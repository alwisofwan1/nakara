// A Work Item's Pull Request gate (CONTEXT.md: Handoff Gate, Push-only
// Follow-up). Its state lives in kv under keys only this module knows:
// `ci-wait:<item>` (the PR whose pending checks a handoff waits on),
// `ci-failed:<item>`, `push-only:<item>` ("available:<PR branch>" from a
// handoff refused for unpushed work until a push-only follow_up uses it, then
// "used" until the next handoff gets the work there) and
// `pr-closed:<item>:<url>` (a closed PR is reported once).
import { policyState, type Store, type WorkItem } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import {
  checksReadError,
  checksRefusal,
  checksStatus,
  type PrCheck,
  readPrChecks,
} from "../domain/checks.ts";
import type { PolicyState } from "../domain/policy.ts";
import {
  findUnpushed,
  GH_PR,
  type PrIO,
  PUSH_ONLY_OFFER,
  prHeadReadError,
  type Unpushed,
  unpushedPaused,
  unpushedRefusal,
  unpushedStatus,
} from "../domain/pushed.ts";
import { run } from "../runner/workspace.ts";
import { type Logger, silentLogger } from "../telemetry/log.ts";

const WAIT = "ci-wait:";
const FAILED = "ci-failed:";
const PUSH_ONLY = "push-only:";
const CLOSED = "pr-closed:";
const PUSH_ONLY_AVAILABLE = "available:";
const PUSH_ONLY_USED = "used";

/** GitHub as the gate reads it; tests replace it. */
export interface PullRequestPort extends PrIO {
  readPrChecks(prUrl: string): Promise<PrCheck[]>;
  /** The state `gh pr view` reports: OPEN, MERGED or CLOSED. */
  readPrState(prUrl: string): Promise<string>;
}

export const GH_PULL_REQUESTS: PullRequestPort = {
  ...GH_PR,
  readPrChecks: (prUrl) => readPrChecks(prUrl),
  async readPrState(prUrl) {
    const out = await run(
      "gh",
      ["pr", "view", prUrl, "--json", "state"],
      undefined,
      60_000,
    );
    return (JSON.parse(out) as { state: string }).state;
  },
};

/** The kv key prefixes of an item's gate state, for deleting a factory's items. */
export const ITEM_KEY_PREFIXES = [WAIT, FAILED, PUSH_ONLY, CLOSED] as const;

/** An item's policy state with the gate's part: failed CI and the push-only follow_up. */
export function policyFor(store: Store, item: WorkItem): PolicyState {
  const pushOnly = store.getKv(PUSH_ONLY + item.id) ?? "";
  return {
    ...policyState(item),
    ciFailed: Boolean(store.getKv(FAILED + item.id)),
    pushOnlyBranch: pushOnly.startsWith(PUSH_ONLY_AVAILABLE)
      ? pushOnly.slice(PUSH_ONLY_AVAILABLE.length)
      : null,
  };
}

/** Where a handoff looks for work that never reached the PR; a gate without them (the poller's) never hands off. */
export interface Workspaces {
  definition: () => Definition;
  workDir: string;
}

export class PullRequestGate {
  private readonly store: Store;
  private readonly io: PullRequestPort;
  private readonly log: Logger;
  private readonly workspaces: Workspaces | undefined;

  constructor(
    store: Store,
    io: PullRequestPort = GH_PULL_REQUESTS,
    log: Logger = silentLogger,
    workspaces?: Workspaces,
  ) {
    this.store = store;
    this.io = io;
    this.log = log;
    this.workspaces = workspaces;
  }

  policyFor(item: WorkItem): PolicyState {
    return policyFor(this.store, item);
  }

  /**
   * Record the item's PR. A different PR starts fresh: not merged, and no CI
   * wait or failure carried over from the previous PR. Re-recording the same
   * PR changes nothing, so its merge is reported once.
   */
  record(itemId: number, prUrl: string): void {
    if (this.store.item(itemId)?.pr_url === prUrl) return;
    this.store.transaction(() => {
      this.store.updateItem(itemId, { pr_url: prUrl, pr_merged: 0 });
      this.store.setKv(WAIT + itemId, "");
      this.store.setKv(FAILED + itemId, "");
      this.store.setKv(PUSH_ONLY + itemId, "");
    });
  }

  /** Whether the item waits for its PR's pending checks, so it is not stalled. */
  waitingOnCi(item: WorkItem): boolean {
    return this.store.getKv(WAIT + item.id) === item.pr_url;
  }

  /** Use up the push-only follow_up the policy allowed: its PR branch, or null when none is available. */
  takePushOnly(item: WorkItem): string | null {
    const branch = this.policyFor(item).pushOnlyBranch ?? null;
    if (branch) this.store.setKv(PUSH_ONLY + item.id, PUSH_ONLY_USED);
    return branch;
  }

  /**
   * A handoff of the recorded PR: the work must be on it and its checks must
   * pass. A refusal is written here (messages, a checks_updated event, or
   * waiting_human) and returns ok false; ok true carries the head the checks
   * ran on.
   */
  async handoff(
    itemId: number,
    prUrl: string,
  ): Promise<{ ok: true; headSha: string } | { ok: false }> {
    const log = this.log.child({ item_id: itemId });
    const refused = { ok: false } as const;
    let headSha: string;
    let unpushed: Unpushed | null;
    try {
      // Read before the checks: they are the checks of this commit.
      const head = await this.io.readPrHead(prUrl);
      headSha = head.sha;
      unpushed = this.workspaces
        ? await findUnpushed(
            this.io,
            this.workspaces.definition(),
            this.workspaces.workDir,
            itemId,
            prUrl,
            head,
          )
        : null;
    } catch (error) {
      log.warn("pr_head.read_failed", { pr_url: prUrl, error });
      this.store.setKv(WAIT + itemId, "");
      this.store.updateItem(itemId, { status: "waiting_human" });
      this.store.addMessage(itemId, "factory", prHeadReadError(prUrl, error));
      return refused;
    }
    const pushOnly = PUSH_ONLY + itemId;
    if (unpushed && this.store.getKv(pushOnly) === PUSH_ONLY_USED) {
      // The push-only follow_up did not get the work there: a human decides.
      log.info("action.refused", {
        action: "handoff",
        reason: "unpushed_after_push_only",
      });
      this.store.setKv(WAIT + itemId, "");
      this.store.updateItem(itemId, { status: "waiting_human" });
      this.store.addMessage(itemId, "factory", unpushedPaused(unpushed, prUrl));
      return refused;
    }
    if (unpushed) {
      log.info("action.refused", { action: "handoff", reason: "unpushed" });
      this.store.setKv(WAIT + itemId, "");
      this.store.setKv(pushOnly, PUSH_ONLY_AVAILABLE + unpushed.head.branch);
      this.store.addMessage(itemId, "factory", unpushedStatus(unpushed, prUrl));
      this.store.addEvent(itemId, "checks_updated", {
        prUrl,
        message: `${unpushedRefusal(unpushed, prUrl)} ${PUSH_ONLY_OFFER}`,
      });
      return refused;
    }
    // The work reached the PR: a later refusal offers a push-only follow_up again.
    this.store.setKv(pushOnly, "");
    let reason: string | null;
    let status: string | null;
    let pending: boolean;
    try {
      const checks = await this.io.readPrChecks(prUrl);
      reason = checksRefusal(checks);
      status = checksStatus(checks, prUrl);
      const failed = checks.some(
        (c) => c.bucket === "fail" || c.bucket === "cancel",
      );
      pending = checks.some((c) => c.bucket === "pending") && !failed;
      this.store.setKv(FAILED + itemId, failed ? "1" : "");
    } catch (error) {
      log.warn("pr_checks.read_failed", { pr_url: prUrl, error });
      this.store.setKv(WAIT + itemId, "");
      this.store.updateItem(itemId, { status: "waiting_human" });
      this.store.addMessage(itemId, "factory", checksReadError(error));
      return refused;
    }
    this.store.setKv(WAIT + itemId, pending ? prUrl : "");
    if (reason) {
      // The refusal instructs the foreman (via checks_updated, now or when
      // pending checks finish); the operator only sees the CI status.
      if (status) this.store.addMessage(itemId, "factory", status);
      if (!pending)
        this.store.addEvent(itemId, "checks_updated", {
          prUrl,
          message: reason,
        });
      return refused;
    }
    return { ok: true, headSha };
  }

  /**
   * Poll the item's PR: finished pending checks, a merge or a close become
   * events. The foreman can record another PR while GitHub is read, so each
   * write first re-checks that the item still tracks the PR that was polled;
   * nothing awaits between that check and the write.
   */
  async poll(itemId: number): Promise<void> {
    const store = this.store;
    const url = store.item(itemId)?.pr_url;
    if (!url) return;
    const tracked = () => {
      const now = store.item(itemId);
      return now?.pr_url === url && now.pr_merged === 0;
    };
    const waitKey = WAIT + itemId;
    if (!tracked()) return;
    if (store.getKv(waitKey) && store.getKv(waitKey) !== url)
      store.setKv(waitKey, "");
    if (!/\/pull\/\d+/.test(url)) return;
    const state = await this.io.readPrState(url);
    if (!tracked()) return;
    if (state === "OPEN" && store.getKv(waitKey) === url) {
      try {
        const checks = await this.io.readPrChecks(url);
        if (!checks.some((c) => c.bucket === "pending")) {
          store.transaction(() => {
            if (!tracked() || store.getKv(waitKey) !== url) return;
            store.setKv(waitKey, "");
            const message = checksRefusal(checks);
            store.setKv(FAILED + itemId, message ? "1" : "");
            store.addEvent(itemId, "checks_updated", {
              prUrl: url,
              message: message ?? "Checks passed. Retry handoff.",
            });
          });
        }
      } catch (error) {
        this.log.warn("pr_checks.read_failed", {
          item_id: itemId,
          pr_url: url,
          error,
        });
        if (!tracked() || store.getKv(waitKey) !== url) return;
        store.setKv(waitKey, "");
        store.updateItem(itemId, { status: "waiting_human" });
        store.addMessage(itemId, "factory", checksReadError(error));
      }
    }
    if (state === "MERGED" || state === "CLOSED") store.setKv(waitKey, "");
    if (state === "MERGED") {
      store.transaction(() => {
        if (!tracked()) return;
        store.updateItem(itemId, { pr_merged: 1 });
        store.addEvent(itemId, "pr_merged", { prUrl: url });
      });
    } else if (state === "CLOSED") {
      const key = `${CLOSED}${itemId}:${url}`;
      if (store.getKv(key)) return;
      store.setKv(key, "1");
      store.addEvent(itemId, "pr_closed", { prUrl: url });
    }
  }
}
