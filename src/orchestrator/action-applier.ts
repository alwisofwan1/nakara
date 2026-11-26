import type { Config } from "../config.ts";
import { policyState, type Store, type WorkItem } from "../db.ts";
import { type Definition, factoryRepositories } from "../definition/load.ts";
import { type Action, check, runsUsed } from "../domain/policy.ts";
import { pushOnlyPrompt, short } from "../domain/pushed.ts";
import type { RecordedAction } from "../mcp/types.ts";
import { agentGhEnv } from "../runner/agent-token.ts";
import { removeWorkspace, run as runCmd } from "../runner/workspace.ts";
import {
  envSecrets,
  type Logger,
  redact,
  silentLogger,
} from "../telemetry/log.ts";
import {
  GH_PULL_REQUESTS,
  PullRequestGate,
  type PullRequestPort,
} from "./pull-request-gate.ts";
import {
  pauseItem,
  RunControl,
  runLimitPause,
  stopItemRuns,
} from "./run-support.ts";

/** The outside world an action touches: GitHub through gh, and the item's workspace. */
export interface ActionIO extends PullRequestPort {
  /** Mark a pull request ready for review. */
  markReady(prUrl: string): Promise<unknown>;
  /** Comment on a GitHub issue. */
  comment(issueUrl: string, body: string): Promise<unknown>;
  removeWorkspace(itemId: number, config: Config): Promise<unknown>;
}

/**
 * GitHub for the factory `slug`: its writes (marking a PR ready, mirroring
 * on the issue) run with the factory's agent token, resolved at each call,
 * so they reach repositories only that token can write to. Without an own
 * or shared token they use gh's login, as before. Reads for the gate stay on
 * gh's login: the agent token needs no Checks or Commit statuses permission.
 */
export const ghIO = (
  slug?: string,
  run: typeof runCmd = runCmd,
  env: NodeJS.ProcessEnv = process.env,
): ActionIO => ({
  ...GH_PULL_REQUESTS,
  markReady: (prUrl) =>
    run("gh", ["pr", "ready", prUrl], undefined, 60_000, agentGhEnv(slug, env)),
  comment: (issueUrl, body) =>
    run(
      "gh",
      ["issue", "comment", issueUrl, "--body", body],
      undefined,
      undefined,
      agentGhEnv(slug, env),
    ),
  removeWorkspace,
});

export const GH_IO: ActionIO = ghIO();

/** The comment that mirrors an applied action on the work item's GitHub issue, if any. */
export function mirrorBody(a: Action): string | null {
  return a.type === "post_update" || a.type === "ask_human"
    ? a.type === "post_update"
      ? a.message
      : a.question
    : a.type === "request_spec_approval"
      ? `Spec ready for approval: ${a.specPrUrl}\n\n${a.summary}`
      : a.type === "handoff"
        ? `Ready for review and merge: ${a.prUrl}\n\n${a.summary}`
        : null;
}

/** Applies the foreman's recorded actions: re-checks each against the policy, then records its effects. */
export class ActionApplier {
  private readonly store: Store;
  private readonly config: Config;
  /** The applied definition; throws when none is loaded. */
  private readonly definition: () => Definition;
  private readonly io: ActionIO;
  private readonly log: Logger;
  private readonly gate: PullRequestGate;
  private readonly control: RunControl;

  constructor(
    store: Store,
    config: Config,
    definition: () => Definition,
    io: ActionIO = GH_IO,
    log: Logger = silentLogger,
    control: RunControl = new RunControl(),
  ) {
    this.control = control;
    this.store = store;
    this.config = config;
    this.definition = definition;
    this.io = io;
    this.log = log;
    this.gate = new PullRequestGate(store, io, log, {
      definition,
      workDir: config.workDir,
    });
  }

  /** Re-check every action against the current state (a human may have acted during the turn) and apply it. */
  async applyActions(
    itemId: number,
    recorded: RecordedAction[],
  ): Promise<Action[]> {
    const applied: Action[] = [];
    const log = this.log.child({ item_id: itemId });
    for (const { action, accepted } of recorded) {
      if (!accepted) continue;
      // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
      let item = this.store.item(itemId)!;
      const repositories = factoryRepositories(this.definition());
      let verdict = check(this.gate.policyFor(item), action, repositories);
      if (!verdict.ok) {
        log.info("action.refused", {
          action: action.type,
          reason: verdict.reason,
        });
        continue;
      }
      // A different PR starts fresh before its checks are read.
      if (
        (action.type === "handoff" || action.type === "record_refs") &&
        action.prUrl
      )
        this.gate.record(itemId, action.prUrl);
      // The PR head the handoff's checks ran on.
      let headSha: string | null = null;
      if (action.type === "handoff") {
        const gated = await this.gate.handoff(itemId, action.prUrl);
        if (!gated.ok) continue;
        headSha = gated.headSha;
        // The gate's GitHub I/O took time: a human may have acted meanwhile, so
        // judge the handoff again against the state it will be applied to.
        // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
        item = this.store.item(itemId)!;
        verdict = check(this.gate.policyFor(item), action, repositories);
        if (!verdict.ok) {
          log.info("action.refused", {
            action: action.type,
            reason: verdict.reason,
          });
          continue;
        }
      }
      this.store.transaction(() => {
        this.store.applyPolicyState(itemId, verdict.next);
        if (action.type !== "handoff") this.effect(item, action);
      });
      // GitHub I/O must finish before announcing handoff, outside the SQLite transaction.
      if (
        action.type === "handoff" &&
        (await this.markReadyAndAnnounce(item, action, headSha)) === false
      )
        continue;
      log.info("action.applied", { action: action.type });
      applied.push(action);
    }
    void this.mirrorToGithub(itemId, applied);
    return applied;
  }

  /** Apply one accepted action's effect; the caller holds the transaction. */
  effect(item: WorkItem, action: Action): void {
    const def = this.definition();
    switch (action.type) {
      case "dispatch_agent":
      case "follow_up": {
        // An agent deleted during the foreman's turn is still queued: agentRun
        // fails the run with a clear error and the report wakes the foreman.
        const agent = def.agents.get(action.agent);
        const session =
          action.type === "follow_up"
            ? this.store.latestAgentSession(item.id, action.agent)
            : undefined;
        // The policy allowed it, so the push-only follow_up is available; it
        // is used up, and Nakara writes its prompt.
        const pushOnlyBranch =
          action.type === "follow_up" && action.pushOnly
            ? this.gate.takePushOnly(item)
            : null;
        this.store.createRun({
          item_id: item.id,
          role: "agent",
          agent: action.agent,
          agent_type: agent?.type ?? action.agentType,
          harness: agent?.harness.kind ?? "none",
          model: agent?.harness.model ?? null,
          session_id: session ?? null,
          status: "queued",
          input:
            action.type === "dispatch_agent"
              ? action.brief
              : pushOnlyBranch
                ? pushOnlyPrompt(pushOnlyBranch)
                : action.message,
        });
        return;
      }
      case "post_update":
        this.store.addMessage(item.id, "factory", action.message);
        return;
      case "ask_human":
        this.store.addApproval(
          item.id,
          "question",
          action.question,
          null,
          action.options,
        );
        this.store.addMessage(item.id, "factory", action.question);
        return;
      case "request_spec_approval":
        this.store.addApproval(
          item.id,
          "spec",
          action.summary,
          action.specPrUrl,
        );
        this.store.addMessage(
          item.id,
          "factory",
          `Spec ready for approval: ${action.specPrUrl}\n\n${action.summary}`,
        );
        return;
      case "record_refs":
        if (action.issueUrl)
          this.store.updateItem(item.id, { issue_url: action.issueUrl });
        return;
      case "complete_task":
        this.store.addMessage(item.id, "factory", action.summary);
        // The foreman's own run is still ending; only the item's agents stop.
        stopItemRuns(this.store, this.control, item.id, "agent");
        // A failed delete (e.g. root-owned files a container left) only leaves disk behind.
        void this.io
          .removeWorkspace(item.id, this.config)
          .catch((error: unknown) =>
            this.log.warn("workspace.remove_failed", {
              item_id: item.id,
              error,
            }),
          );
        return;
    }
  }

  private async markReadyAndAnnounce(
    item: WorkItem,
    action: Extract<Action, { type: "handoff" }>,
    headSha: string | null,
  ): Promise<boolean> {
    try {
      await this.io.markReady(action.prUrl);
    } catch (error) {
      this.log.warn("pr.mark_ready_failed", {
        item_id: item.id,
        pr_url: action.prUrl,
        error,
      });
      const message = `Could not mark PR ready for review: ${action.prUrl}\n\n${String(error)}`;
      this.store.addMessage(item.id, "factory", message);
      await this.mirrorToGithub(item.id, [{ type: "post_update", message }]);
      return false;
    }
    this.store.addMessage(
      item.id,
      "factory",
      `Ready for your review and merge: ${action.prUrl}${headSha ? ` (checks passed on ${short(headSha)})` : ""}\n\n${action.summary}`,
    );
    return true;
  }

  /** Nothing in motion and nobody asked: surface the item instead of letting it hang. */
  checkStalled(item: WorkItem, applied: Action[]): void {
    if (
      item.stage === "complete" ||
      item.stage === "cancelled" ||
      item.status !== "active"
    )
      return;
    if (
      this.store.pendingEvents(item.id).length > 0 ||
      this.gate.waitingOnCi(item)
    )
      return;
    const moving = this.store
      .runs(item.id)
      .some(
        (r) =>
          r.role === "agent" &&
          (r.status === "queued" || r.status === "running"),
      );
    if (
      moving ||
      applied.some((a) => a.type === "dispatch_agent" || a.type === "follow_up")
    )
      return;
    // The foreman's last turn used the last run: nothing more can start.
    if (runsUsed(policyState(item))) {
      this.pause(item, runLimitPause(item));
      return;
    }
    this.log.info("item.stalled", { item_id: item.id });
    this.store.updateItem(item.id, { status: "waiting_human" });
    this.store.addMessage(
      item.id,
      "factory",
      "Nothing is in progress for this work item. Send a message to continue, or cancel it.",
    );
  }

  /** Pause the work item with a reason for the operator. */
  pause(item: WorkItem, reason: string): void {
    pauseItem(this.store, this.log, item.id, reason);
  }

  // ---------- GitHub mirror ----------

  private async mirrorToGithub(
    itemId: number,
    applied: Action[],
  ): Promise<void> {
    if (!this.config.githubMirror) return;
    // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
    const item = this.store.item(itemId)!;
    const target =
      item.issue_url ?? (item.source === "github" ? item.source_url : null);
    if (!target || !/\/issues\/\d+/.test(target)) return;
    for (const a of applied) {
      const mirrored = mirrorBody(a);
      // Published under the Operator's name: a secret in it never leaves.
      const body = mirrored && (redact(mirrored, envSecrets()) as string);
      if (body)
        await this.io.comment(target, body).catch((error: unknown) =>
          this.log.warn("github.mirror_failed", {
            item_id: itemId,
            issue_url: target,
            error,
          }),
        );
    }
  }
}
