// A work item whose runs hit a rate or usage limit on every harness they may
// use waits for the limit to reset instead of failing (#61). The wait lives in
// kv (no migration): which runs to start again, and when. The Scheduler holds
// the item's foreman turns and queued runs while it waits, and resumes it once
// the time has come; a message from the operator, or Retry, resumes it now.
import { policyState, type Run, type Store, type WorkItem } from "../db.ts";
import { runsUsed } from "../domain/policy.ts";
import type { RateLimit } from "../harness/limits.ts";
import type { Logger } from "../telemetry/log.ts";
import { pauseItem, runLimitNeedsYou, runLimitPause } from "./run-support.ts";

/** How long an item waits when the limited harness did not say when its limit resets. */
export const LIMIT_WAIT_MS = 60 * 60_000;

/** The kv key prefix of an item's wait: `limit-wait:<item id>` → LimitWait. */
export const LIMIT_WAIT = "limit-wait:";

/** The kv key prefix of a run that moved to a fallback harness: `fallback-of:<run id>` → FallbackOf. */
export const FALLBACK_OF = "fallback-of:";

/** A limited agent run to start again once the limit resets. */
export interface PendingRun {
  agent: string;
  agentType: Run["agent_type"];
  harness: string;
  model: string | null;
  /** The session to continue; null starts the brief fresh. */
  session: string | null;
  input: string;
  countsReview: number;
  /** The run that hit the limit. */
  limitedRun: number;
}

export interface LimitWait {
  /** When the item resumes (ISO). */
  until: string;
  /** `until` is a reset time a harness gave, not the fixed LIMIT_WAIT_MS. */
  known: boolean;
  runs: PendingRun[];
  /** A foreman turn hit the limit: its events stay pending until the item resumes. */
  foreman: boolean;
}

/** Why a run moved to a fallback harness, for its run page. */
export interface FallbackOf {
  /** The run that hit the limit. */
  runId: number;
  harness: string;
  reason: string;
  resetAt: string | null;
}

const waitKey = (itemId: number) => `${LIMIT_WAIT}${itemId}`;

/** The item's wait, if it waits for a limit to reset. */
export function limitWait(store: Store, itemId: number): LimitWait | undefined {
  const raw = store.getKv(waitKey(itemId));
  try {
    return raw ? (JSON.parse(raw) as LimitWait) : undefined;
  } catch {
    // Unreadable, it holds nothing: resumeDue drops it.
    return undefined;
  }
}

/** The items that wait for a limit to reset. */
export function waitingItems(store: Store): Set<number> {
  return new Set(
    store.repos.kv
      .kvKeys(LIMIT_WAIT)
      .map((k) => Number(k.slice(LIMIT_WAIT.length))),
  );
}

/** Why a run moved to a fallback harness, if it did. */
export function fallbackOf(store: Store, runId: number): FallbackOf | null {
  const raw = store.getKv(`${FALLBACK_OF}${runId}`);
  return raw ? (JSON.parse(raw) as FallbackOf) : null;
}

/** Record that `runId` retries the brief of a limited run on a fallback harness. */
export function recordFallback(
  store: Store,
  runId: number,
  from: FallbackOf,
): void {
  store.setKv(`${FALLBACK_OF}${runId}`, JSON.stringify(from));
}

/**
 * Pause the item until the limit resets: its reset time, or LIMIT_WAIT_MS
 * from now when the harness did not say. A second limit while it waits adds
 * its run; the item then resumes at the earliest known reset of the two, and
 * only when neither is known at the earlier fixed wait. A run still limited
 * then waits again. Only the pause itself tells the Operator (needsYou); a
 * limit on an item already waiting updates the wait and its timeline only.
 */
export function waitForReset(
  store: Store,
  log: Logger,
  item: WorkItem,
  hit: {
    /** "implement (run #12)" or "The foreman (run #12)". */
    who: string;
    harness: string;
    limit: RateLimit;
    /** The limits the same brief hit before, on the harnesses it moved from. */
    earlier?: string[];
    run?: PendingRun;
    foreman?: boolean;
  },
  now = Date.now(),
): void {
  const reset = hit.limit.resetAt ? Date.parse(hit.limit.resetAt) : Number.NaN;
  const known = !Number.isNaN(reset);
  // A reset already past (a clock skew, or a limit that just lifted) waits a minute.
  const until = known ? Math.max(reset, now + 60_000) : now + LIMIT_WAIT_MS;
  const before = limitWait(store, item.id);
  // A known reset wins over the fixed wait; between two of a kind, the earlier.
  const keepBefore =
    before !== undefined &&
    (before.known === known ? Date.parse(before.until) <= until : before.known);
  const wait: LimitWait = {
    until: keepBefore ? before.until : new Date(until).toISOString(),
    known: keepBefore ? before.known : known,
    runs: [...(before?.runs ?? []), ...(hit.run ? [hit.run] : [])],
    foreman: Boolean(before?.foreman || hit.foreman),
  };
  store.setKv(waitKey(item.id), JSON.stringify(wait));
  const when = wait.known
    ? `Nakara resumes the work item when the limit resets, at ${wait.until}`
    : `${hit.harness} did not say when the limit resets, so Nakara resumes the work item after ${LIMIT_WAIT_MS / 60_000} minutes, at ${wait.until}`;
  const history = hit.earlier?.length
    ? `\n\nThe same brief hit a limit before: ${hit.earlier.join("; ")}.`
    : "";
  const notice = `${hit.who} hit the ${hit.harness} rate or usage limit: ${hit.limit.message}${history}\n\n${when}. Send a message to resume it sooner.`;
  // Read before pausing: only the move from running to paused notifies.
  const wasPaused =
    before !== undefined || store.item(item.id)?.status === "paused";
  pauseItem(store, log, item.id, notice);
  if (!wasPaused)
    store.needsYou({ itemId: item.id, event: "paused", what: notice });
}

/**
 * End the item's wait and start what it held: each limited run again, as
 * queued runs, and the foreman's pending events. A closed item only drops its
 * wait; an item at its run limit pauses there instead. Returns the queued runs.
 */
export function resumeLimited(
  store: Store,
  log: Logger,
  itemId: number,
  why: string,
): Run[] {
  const wait = limitWait(store, itemId);
  if (!wait) {
    store.repos.kv.deleteKv(waitKey(itemId));
    return [];
  }
  return store.transaction(() => {
    store.repos.kv.deleteKv(waitKey(itemId));
    const item = store.item(itemId);
    if (!item || item.stage === "complete" || item.stage === "cancelled")
      return [];
    if (item.status === "paused")
      store.updateItem(itemId, { status: "active" });
    const queued: Run[] = [];
    for (const run of wait.runs) {
      // biome-ignore lint/style/noNonNullAssertion: The item was read above.
      const current = store.item(itemId)!;
      if (runsUsed(policyState(current))) {
        pauseItem(store, log, itemId, runLimitPause(current));
        runLimitNeedsYou(store, current);
        break;
      }
      // The limited review gave its review back when it failed; this run takes it again.
      if (run.countsReview)
        store.updateItem(itemId, { review_count: current.review_count + 1 });
      queued.push(
        store.createRun({
          item_id: itemId,
          role: "agent",
          agent: run.agent,
          agent_type: run.agentType,
          harness: run.harness,
          model: run.model,
          session_id: run.session,
          status: "queued",
          input: run.input,
          counts_review: run.countsReview,
        }),
      );
    }
    const started = queued.map(
      (r, i) =>
        `run #${r.id} starts ${r.agent} on ${r.harness} again (after run #${wait.runs[i]?.limitedRun})`,
    );
    store.addMessage(
      itemId,
      "factory",
      `${why} The work item resumes${started.length ? `: ${started.join("; ")}` : ""}${wait.foreman ? `${started.length ? ", and" : ":"} the foreman handles its pending events` : ""}.`,
    );
    log.info("item.limit_resumed", { item_id: itemId, runs: queued.length });
    return queued;
  });
}

/** Resume every item whose wait is over; the Scheduler calls it on each pump. */
export function resumeDue(store: Store, log: Logger, now = Date.now()): void {
  for (const itemId of waitingItems(store)) {
    const wait = limitWait(store, itemId);
    if (!wait || !(Date.parse(wait.until) > now))
      resumeLimited(store, log, itemId, "The rate or usage limit has reset.");
  }
}
