import { pickSecrets } from "../secrets.ts";
import { join } from "node:path";

import type { Config } from "../config.ts";
import { policyState, type Run, type ScheduledRun, type Store } from "../db.ts";
import type {
  AgentDef,
  Definition,
  ResolvedHarness,
} from "../definition/load.ts";
import { runsUsed } from "../domain/policy.ts";
import {
  findUnpushed,
  GH_PR,
  type PrHead,
  type PrIO,
  unpushedRefusal,
} from "../domain/pushed.ts";
import { reviewVerdict } from "../domain/review.ts";
import { runTurn, type TurnOutcome } from "../harness/claude.ts";
import type { RateLimit } from "../harness/limits.ts";
import {
  agentCredentials,
  runLabels,
  type DockerSpec,
} from "../runner/docker.ts";
import {
  collectProof,
  EVIDENCE_DIR,
  PROOF_DIR,
  type Proof,
  stageEvidence,
} from "../runner/evidence.ts";
import { runVerify, type Verifier } from "../runner/verify.ts";
import {
  endSnapshots,
  recordDiff,
  startSnapshots,
} from "../runner/snapshot.ts";
import {
  dockerSpec,
  internalDir,
  prepareWorkspace,
  type Workspace,
  writeInternal,
} from "../runner/workspace.ts";
import { quietTelemetry, type Telemetry } from "../telemetry/metrics.ts";
import { agentSystemPrompt } from "./prompts.ts";
import {
  type FallbackOf,
  fallbackOf,
  type PendingRun,
  recordFallback,
  waitForReset,
} from "./limit-wait.ts";
import { applyReflection, countUnchecked } from "./reflect.ts";
import {
  ended,
  harnessBins,
  NEVER,
  type RunControl,
  type RunEnd,
  reachedBudget,
  recordRunEnd,
  reportStopped,
  resolveMcp,
  SHUT_DOWN,
  STOPPED,
} from "./run-support.ts";
import {
  recordVerify,
  type VerifyResult,
  verifyConfig,
  verifyLogPath,
  verifyPaused,
  verifySummary,
} from "./verify.ts";

const READ_ONLY_EXTRA = [
  "Edit",
  "Write",
  "NotebookEdit",
  "Bash(git commit:*)",
  "Bash(git push:*)",
  "Bash(gh pr review:*)",
  "Bash(gh pr comment:*)",
  "Bash(gh pr edit:*)",
  "Bash(gh issue comment:*)",
];

/** Runs one queued agent run to its end: prepares it, runs the harness, and reports the result to the foreman. */
export class AgentRunner {
  private readonly store: Store;
  private readonly config: Config;
  private readonly control: RunControl;
  /** The applied definition; throws when none is loaded. */
  private readonly definition: () => Definition;
  private readonly telemetry: Telemetry;
  /** Runs the harness; tests replace it. */
  private readonly turn: typeof runTurn;
  /** Reads the PR head on GitHub; tests replace it. */
  private readonly pr: PrIO;
  /** The factory's slug, which picks its agent token; none when standalone. */
  private readonly slug: string | undefined;
  /** Runs a repository's verify commands; tests replace it. */
  private readonly verifier: Verifier;

  constructor(
    store: Store,
    config: Config,
    control: RunControl,
    definition: () => Definition,
    telemetry: Telemetry = quietTelemetry(),
    turn: typeof runTurn = runTurn,
    pr: PrIO = GH_PR,
    slug?: string,
    verifier: Verifier = runVerify,
  ) {
    this.store = store;
    this.config = config;
    this.control = control;
    this.definition = definition;
    this.telemetry = telemetry;
    this.turn = turn;
    this.pr = pr;
    this.slug = slug;
    this.verifier = verifier;
  }

  async run(scheduled: ScheduledRun): Promise<void> {
    const def = this.definition();
    // The scheduler reads a few columns; the input is read once the run starts.
    // biome-ignore lint/style/noNonNullAssertion: Runs are never deleted, so the scheduled run exists.
    const queued = this.store.runById(scheduled.id)!;
    // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
    const item = this.store.item(queued.item_id)!;
    const agent = def.agents.get(queued.agent);
    // Mark started before any await so the next pump cannot start it twice.
    const logPath = join(
      internalDir(this.config.workDir, item.id),
      "logs",
      `run-${queued.id}.jsonl`,
    );
    // A queued run's started_at is when it was queued, until it starts.
    const startedAt = Date.now();
    const waited =
      Math.max(0, startedAt - Date.parse(queued.started_at)) / 1000;
    this.store.markRunStarted(queued.id, logPath);
    const log = this.telemetry.log.child({
      item_id: item.id,
      run_id: queued.id,
      agent: queued.agent,
    });
    this.telemetry.metrics.runWait.observe({ role: "agent" }, waited);
    log.info("run.started", { harness: queued.harness, wait_s: waited });
    const recordEnd = (end: Omit<RunEnd, "startedAt">) =>
      recordRunEnd(this.telemetry, log, queued, { ...end, startedAt });
    // Registered before any await so the run can be stopped while it prepares.
    const controller = new AbortController();
    this.control.controllers.set(queued.id, controller);
    // A reflect run reports to the Inbox, not the foreman: it must not wake a turn.
    const reports = queued.agent_type !== "REFLECT";
    const fail = (error: string) => {
      this.control.controllers.delete(queued.id);
      this.control.stopped.delete(queued.id);
      this.store.finishRun(queued.id, {
        status: "failed",
        result: null,
        error,
        cost_usd: 0,
        num_turns: null,
        duration_ms: 0,
        session_id: queued.session_id,
        log_path: logPath,
      });
      if (reports)
        this.store.addEvent(item.id, "agent_report", {
          runId: String(queued.id),
          agent: queued.agent,
          status: "failed",
          error,
        });
      else countUnchecked(this.store, item.factory_id);
      recordEnd({ status: "failed", costUsd: 0, error });
    };
    if (!agent)
      return fail(
        `Agent "${queued.agent}" is no longer in the factory definition.`,
      );
    // A run queued on one of the agent's fallbacks runs there; any other on its harness.
    const harnesses = [agent.harness, ...agent.fallback];
    const harness =
      harnesses.find(
        (h) => h.kind === queued.harness && (h.model ?? null) === queued.model,
      ) ?? agent.harness;
    // Only claude takes a budget cap; no harness starts on a spent budget,
    // e.g. a resume queued before other runs spent it.
    if (item.cost_usd >= item.budget_usd)
      return fail(
        `The budget is spent ($${item.cost_usd.toFixed(2)} of $${item.budget_usd.toFixed(2)}), so the run did not start. Raise the budget to continue.`,
      );
    let ws: Workspace;
    try {
      ws = await prepareWorkspace(
        def,
        item.id,
        this.config,
        item.repo,
        this.config.claudeBin,
      );
    } catch (error) {
      return fail(
        `Could not prepare the workspace: ${String(error).slice(0, 1500)}`,
      );
    }
    let secrets: Record<string, string>;
    try {
      secrets = await pickSecrets(this.config.secretsPath, agent.secrets);
    } catch (error) {
      return fail(
        `Could not read the agent's secrets: ${(error as Error).message}`,
      );
    }
    for (const value of Object.values(secrets)) log.addSecret(value);
    const env = { NAKARA_ITEM: String(item.id), NAKARA_LABEL: def.label };
    let docker: DockerSpec | undefined;
    try {
      docker = await dockerSpec(def, agent.runner, ws);
      if (docker)
        Object.assign(
          env,
          await agentCredentials(harness.kind, "agent", this.slug),
        );
    } catch (error) {
      return fail(
        `Could not prepare the ${agent.runner} runner: ${String(error).slice(0, 1500)}`,
      );
    }

    const systemPromptFile = join(ws.internal, `run-${queued.id}.system.md`);
    // A reviewer opens the latest screenshots itself; any other agent finds none.
    // A copy that fails leaves the reviewer the written record, as before #161.
    let evidence: Proof[] = [];
    try {
      evidence = await stageEvidence(
        agent.type === "REVIEW" ? this.store.latestEvidence(item.id) : [],
        join(ws.root, EVIDENCE_DIR),
      );
    } catch (error) {
      log.info("evidence.stage_failed", { error: String(error).slice(0, 500) });
    }
    // In a container the staged copy is also a read-only mount inside the writable root.
    if (docker && evidence.length)
      docker.readOnly = [
        ...(docker.readOnly ?? []),
        join(ws.root, EVIDENCE_DIR),
      ];
    await writeInternal(
      systemPromptFile,
      agentSystemPrompt(def, agent, ws, item, evidence) + agent.instructions,
    );
    // Recorded before the harness starts: the run page diffs a live run against it.
    const started = await startSnapshots(ws.repos);
    this.store.setRunSnapshots(queued.id, started);
    const readOnly = agent.type === "REVIEW" || agent.type === "REFLECT";
    // A follow-up queued behind a running turn resumes the session that turn left behind.
    const session = queued.session_id
      ? (this.store.latestAgentSession(item.id, agent.name, queued.id) ??
        queued.session_id)
      : undefined;
    const outcome = await this.turn(
      {
        harness: harness.kind,
        model: harness.model,
        effort: harness.effort,
        cwd: ws.root,
        prompt: queued.input,
        systemPromptFile,
        resumeSession: session,
        onSession: (id) => this.store.setRunSession(queued.id, id),
        onTool: (tool) => {
          log.info("tool.called", { tool });
          this.store.countRunTool(queued.id, tool);
        },
        mcpConfig: Object.keys(agent.mcpServers).length
          ? resolveMcp(agent.mcpServers, secrets)
          : undefined,
        mcpConfigPath: join(ws.internal, `run-${queued.id}.mcp.json`),
        codexSessions: join(ws.internal, "codex-sessions"),
        permissionMode: "bypassPermissions",
        disallowedTools: readOnly ? [...NEVER, ...READ_ONLY_EXTRA] : NEVER,
        maxBudgetUsd: item.budget_usd - item.cost_usd,
        idleTimeoutMs: agent.idleTimeoutMinutes * 60_000,
        logPath,
        // Its gh refuses a body starting with /nakara, the Operator's trigger.
        ghGuard: join(ws.internal, `run-${queued.id}.gh`),
        env,
        docker: docker && {
          ...docker,
          labels: runLabels(queued.id, this.config.dataDir),
        },
        signal: controller.signal,
      },
      harnessBins(this.config),
    );
    if (started.length) {
      const snapshots = await endSnapshots(ws.repos, started);
      this.store.setRunSnapshots(queued.id, snapshots);
      // Written before the run ends: the page of an ended run reads this file.
      await recordDiff(logPath, snapshots, ws.repos).catch(() => undefined);
    }
    const pushed =
      outcome.ok && agent.type === "IMPLEMENT"
        ? await this.unpushed(item.id, log)
        : null;
    const notOnPr = pushed && "notOnPr" in pushed ? pushed.notOnPr : null;
    // Only work Nakara saw on the PR is verified, before the foreman hears of it.
    const verified =
      pushed && "onPr" in pushed
        ? await this.verify(
            def,
            item.id,
            queued.id,
            agent,
            pushed.onPr,
            logPath,
            controller.signal,
            log,
          )
        : null;
    const proof =
      outcome.ok && agent.type === "IMPLEMENT"
        ? await this.proof(ws, queued.id, startedAt, log)
        : null;
    this.control.controllers.delete(queued.id);
    const stopped = this.control.stopped.delete(queued.id) && !outcome.ok;
    // biome-ignore lint/style/noNonNullAssertion: Work items are never deleted.
    const spentBefore = this.store.item(item.id)!.cost_usd;
    // A run that finished as the drain ran out reports as usual.
    if (
      this.control.interrupting &&
      controller.signal.aborted &&
      !outcome.ok &&
      !stopped
    ) {
      const interrupted = this.store.transaction(() => {
        const { status, error } = this.store.interruptRun(
          queued.id,
          ended(outcome),
          SHUT_DOWN,
        );
        if (status === "failed" && reports)
          this.store.addEvent(item.id, "agent_report", {
            runId: String(queued.id),
            agent: agent.name,
            status,
            error,
          });
        return { status, error };
      });
      recordEnd({
        ...interrupted,
        costUsd: outcome.costUsd,
        reachedBudget: reachedBudget(this.store, item.id, spentBefore),
      });
      return;
    }
    const status = outcome.ok
      ? "succeeded"
      : controller.signal.aborted
        ? "cancelled"
        : "failed";
    // A reflect run that hits a limit fails as before: Nakara starts it, the item does not wait on it.
    const limit =
      status === "failed" && !stopped && reports
        ? (outcome.limit ?? null)
        : null;
    if (limit) {
      this.store.transaction(() =>
        this.limited(queued, agent, harness, session, outcome, limit, logPath),
      );
      recordEnd({
        status,
        costUsd: outcome.costUsd,
        reachedBudget: reachedBudget(this.store, item.id, spentBefore),
        error: outcome.error,
      });
      return;
    }
    this.store.transaction(() => {
      this.store.finishRun(queued.id, {
        status,
        result: outcome.result,
        error: stopped ? STOPPED : outcome.error,
        cost_usd: outcome.costUsd,
        num_turns: outcome.numTurns,
        duration_ms: outcome.durationMs,
        session_id: outcome.sessionId ?? queued.session_id,
        log_path: logPath,
        review_verdict:
          agent.type === "REVIEW" && status === "succeeded"
            ? reviewVerdict(outcome.result)
            : null,
      });
      this.store.addCost(item.id, outcome.costUsd);
      if (proof?.proofs.length)
        this.store.addEvidence(item.id, queued.id, proof.proofs);
      if (verified) recordVerify(this.store, item.id, verified);
      if (!reports) {
        if (status !== "succeeded") countUnchecked(this.store, item.factory_id);
        else {
          const done = applyReflection(
            this.store,
            item,
            queued.id,
            outcome.result,
          );
          log.info("reflect.done", {
            learning_id: done.learningId ?? undefined,
            recurrences: done.recurrences,
            reason: done.reason ?? undefined,
          });
        }
      } else if (stopped) reportStopped(this.store, queued);
      else if (status !== "cancelled")
        this.store.addEvent(item.id, "agent_report", {
          runId: String(queued.id),
          agent: agent.name,
          status,
          report: outcome.result ?? undefined,
          error: outcome.error ?? undefined,
          notOnPr: notOnPr ?? undefined,
          verify: verified ? verifySummary(verified) : undefined,
          proof: proof?.summary,
        });
      // A verify that could not run says nothing about the change: the Operator decides.
      if (verified?.status === "error" && status === "succeeded") {
        this.store.updateItem(item.id, { status: "paused" });
        this.store.addMessage(item.id, "factory", verifyPaused(verified));
      }
    });

    if (notOnPr) log.warn("run.unpushed", { message: notOnPr });
    recordEnd({
      status,
      stopped,
      costUsd: outcome.costUsd,
      reachedBudget: reachedBudget(this.store, item.id, spentBefore),
      error: outcome.error,
    });
  }

  /**
   * A run that failed at a rate or usage limit. A fresh dispatch that did no
   * work moves to the next fallback harness as a new run, which counts like
   * any run; a follow-up, a resume, or a run that worked stays in its session
   * on its harness, so the item waits for the limit to reset (limit-wait.ts).
   * The foreman hears of neither: the brief goes on.
   */
  private limited(
    queued: Run,
    agent: AgentDef,
    harness: ResolvedHarness,
    session: string | undefined,
    outcome: TurnOutcome,
    limit: RateLimit,
    logPath: string,
  ): void {
    const harnesses = [agent.harness, ...agent.fallback];
    const fresh = !session && !limit.worked;
    const next = fresh ? harnesses[harnesses.indexOf(harness) + 1] : undefined;
    // biome-ignore lint/style/noNonNullAssertion: Work items are never deleted.
    const item = this.store.item(queued.item_id)!;
    const canRun = !runsUsed(policyState(item));
    const finish = (error: string) => {
      this.store.finishRun(queued.id, {
        status: "failed",
        result: outcome.result,
        error,
        cost_usd: outcome.costUsd,
        num_turns: outcome.numTurns,
        duration_ms: outcome.durationMs,
        session_id: outcome.sessionId ?? queued.session_id,
        log_path: logPath,
      });
      this.store.addCost(item.id, outcome.costUsd);
    };
    const who = `${agent.name} (run #${queued.id})`;
    if (next && canRun) {
      const moved = this.store.createRun({
        item_id: item.id,
        role: "agent",
        agent: agent.name,
        agent_type: agent.type,
        harness: next.kind,
        model: next.model ?? null,
        session_id: null,
        status: "queued",
        input: queued.input,
        counts_review: queued.counts_review,
      });
      finish(
        `${outcome.error} Run #${moved.id} retries the brief on ${next.kind}.`,
      );
      // The limited review gave its review back as it failed; the retry takes it again.
      if (queued.counts_review)
        this.store.updateItem(item.id, {
          // biome-ignore lint/style/noNonNullAssertion: Work items are never deleted.
          review_count: this.store.item(item.id)!.review_count + 1,
        });
      recordFallback(this.store, moved.id, {
        runId: queued.id,
        harness: harness.kind,
        reason: limit.message,
        resetAt: limit.resetAt,
      });
      this.store.addMessage(
        item.id,
        "factory",
        `${who} hit the ${harness.kind} rate or usage limit: ${limit.message}\n\nRun #${moved.id} retries the brief on the fallback harness ${next.kind}.`,
      );
      return;
    }
    if (!canRun) {
      // At the run limit nothing more starts: the foreman hears of the failure and pauses there.
      finish(outcome.error ?? "Rate or usage limit.");
      this.store.addEvent(item.id, "agent_report", {
        runId: String(queued.id),
        agent: agent.name,
        status: "failed",
        error: outcome.error ?? undefined,
      });
      return;
    }
    // A fresh brief starts again on the agent's own harness; a session continues where it stopped.
    const pending: PendingRun = fresh
      ? {
          agent: agent.name,
          agentType: agent.type,
          harness: agent.harness.kind,
          model: agent.harness.model ?? null,
          session: null,
          input: queued.input,
          countsReview: queued.counts_review,
          limitedRun: queued.id,
        }
      : {
          agent: agent.name,
          agentType: agent.type,
          harness: harness.kind,
          model: harness.model ?? null,
          session: outcome.sessionId ?? session ?? null,
          input: `Your previous run stopped at a rate or usage limit. Continue the task where you left off.\n\nThe task was:\n\n${queued.input}`,
          countsReview: queued.counts_review,
          limitedRun: queued.id,
        };
    // The limits this brief hit before, on the harnesses it moved from.
    const earlier: FallbackOf[] = [];
    for (
      let from = fallbackOf(this.store, queued.id);
      from && earlier.length < harnesses.length;
      from = fallbackOf(this.store, from.runId)
    )
      earlier.unshift(from);
    // It resumes once the first known reset of its harnesses has passed; only with none known, after the fixed wait.
    const resets = [limit.resetAt, ...earlier.map((e) => e.resetAt)];
    const known = resets
      .filter((r): r is string => r !== null)
      .sort((a, b) => Date.parse(a) - Date.parse(b));
    finish(
      `${outcome.error} The work item waits for the limit to reset${
        earlier.length ? "; every fallback harness is limited too" : ""
      }.`,
    );
    waitForReset(this.store, this.telemetry.log, item, {
      who,
      harness: harness.kind,
      limit: {
        ...limit,
        resetAt: known[0] ?? null,
      },
      earlier: earlier.map(
        (e) =>
          `run #${e.runId} hit the ${e.harness} limit: ${e.reason}${e.resetAt ? ` (resets at ${e.resetAt})` : ""}`,
      ),
      run: pending,
    });
  }

  /**
   * The screenshots an implement run left as proof, copied out of its
   * workspace, and what the foreman is told about them.
   */
  private async proof(
    ws: Workspace,
    runId: number,
    since: number,
    log: Telemetry["log"],
  ): Promise<{ proofs: Proof[]; summary: string } | null> {
    const proofs: Proof[] = [];
    const problems: string[] = [];
    for (const repo of ws.repos) {
      try {
        const found = await collectProof(
          repo.path,
          since,
          join(
            ws.internal,
            "evidence",
            `run-${runId}`,
            repo.slug.replace("/", "-"),
          ),
        );
        proofs.push(...found.proofs);
        problems.push(...found.problems.map((p) => `${repo.slug}: ${p}`));
      } catch (error) {
        log.warn("run.proof_failed", { repo: repo.slug, error });
        problems.push(`${repo.slug}: the proof could not be read.`);
      }
    }
    if (!proofs.length && !problems.length) return null;
    return {
      proofs,
      summary: [
        proofs.length
          ? `Proof: ${proofs.length} screenshot${proofs.length === 1 ? "" : "s"} from \`${PROOF_DIR}/\`. Nakara posts them on the PR and in the requester's thread; do not post them yourself.\n${proofs.map((p) => `- ${p.criterion}`).join("\n")}`
          : "",
        problems.length
          ? `Refused proof:\n${problems.map((p) => `- ${p}`).join("\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
  }

  /**
   * Whether an implement run's work reached the item's PR, checked by Nakara
   * rather than taken from the report: why not, or the PR head it is on; null
   * with no PR yet, or when GitHub could not tell.
   */
  private async unpushed(
    itemId: number,
    log: Telemetry["log"],
  ): Promise<
    { notOnPr: string } | { onPr: { prUrl: string; head: PrHead } } | null
  > {
    // The foreman may have recorded the PR while the run was going.
    const prUrl = this.store.item(itemId)?.pr_url;
    if (!prUrl) return null;
    try {
      const head = await this.pr.readPrHead(prUrl);
      const unpushed = await findUnpushed(
        this.pr,
        this.definition(),
        this.config.workDir,
        itemId,
        prUrl,
        head,
      );
      return unpushed
        ? { notOnPr: unpushedRefusal(unpushed, prUrl) }
        : { onPr: { prUrl, head } };
    } catch (error) {
      log.warn("run.push_check_failed", { pr_url: prUrl, error });
      return null;
    }
  }

  /**
   * Run the PR repository's verify commands on the PR head; null when it
   * lists none. The full output goes beside the run's log.
   */
  private async verify(
    def: Definition,
    itemId: number,
    runId: number,
    agent: AgentDef,
    onPr: { prUrl: string; head: PrHead },
    logPath: string,
    signal: AbortSignal,
    log: Telemetry["log"],
  ): Promise<VerifyResult | null> {
    const config = verifyConfig(def, onPr.prUrl);
    if (!config) return null;
    const started = Date.now();
    const outcome = await this.verifier({
      def,
      itemId,
      runId,
      owner: config.owner,
      name: config.name,
      head: onPr.head.sha,
      commands: config.commands,
      runner: config.runner ?? agent.runner,
      timeoutMs: config.timeoutMs,
      dirs: this.config,
      claudeBin: this.config.claudeBin,
      logPath: verifyLogPath(logPath),
      signal,
    }).catch(
      (error: unknown): Awaited<ReturnType<Verifier>> => ({
        status: "error",
        commands: [],
        reason: `Nakara error: ${String(error).slice(0, 1000)}`,
      }),
    );
    // A stopped run or a shutdown cut the verify short: it decides nothing.
    if (signal.aborted) {
      log.info("verify.interrupted", {});
      return null;
    }
    log.info("verify.done", {
      status: outcome.status,
      failed: outcome.failed,
      reason: outcome.reason,
      duration_ms: Date.now() - started,
    });
    return {
      ...outcome,
      prUrl: onPr.prUrl,
      head: onPr.head.sha,
      repo: `${config.owner}/${config.name}`,
      runId,
    };
  }
}
