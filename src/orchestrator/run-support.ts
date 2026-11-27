// What the Factory and its runners share about runs in flight: their abort
// state, the harness binaries, and how a run that ends early is recorded.
import type { Config } from "../config.ts";
import {
  policyState,
  type Run,
  type RunStatus,
  type Store,
  type WorkItem,
} from "../db.ts";
import { SECRET_REF } from "../definition/load.ts";
import { runLimitReached } from "../domain/policy.ts";
import type { McpServer } from "../definition/schema.ts";
import type { runTurn } from "../harness/claude.ts";
import { sweepContainers } from "../runner/docker.ts";
import type { Logger } from "../telemetry/log.ts";
import type { Telemetry } from "../telemetry/metrics.ts";

export const STOPPED = "Stopped by the operator.";
export const SHUT_DOWN = "Nakara shut down before this run finished.";

export const NEVER = [
  "Bash(gh pr merge:*)",
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(gh repo delete:*)",
];

/** Tracks the runs this process has in flight: their aborts, operator stops, and shutdown. */
export class RunControl {
  readonly controllers = new Map<number, AbortController>(); // run id → abort
  /** Runs the operator stopped; their end wakes the foreman with run_stopped. */
  readonly stopped = new Set<number>();
  /** Runs aborted now end interrupted, not cancelled, so the next start resumes them. */
  interrupting = false;
}

/** Cancel an item's queued runs and abort its running ones (only those of one role, when given). */
export function stopItemRuns(
  store: Store,
  control: RunControl,
  itemId: number,
  role?: Run["role"],
): void {
  store.cancelQueuedRuns(itemId);
  for (const r of store.runs(itemId))
    if (r.status === "running" && (!role || r.role === role))
      control.controllers.get(r.id)?.abort();
}

/** The harness binaries a run starts. */
export function harnessBins(c: Config) {
  return {
    claude: c.claudeBin,
    qwen: c.qwenBin,
    codex: c.codexBin,
    codexHome: c.codexHome,
  };
}

export function reportStopped(store: Store, run: Run): void {
  store.addEvent(run.item_id, "run_stopped", {
    runId: String(run.id),
    agent: run.agent,
    role: run.role,
  });
}

/** How a run cut short by a shutdown ended, for Store.interruptRun. */
export const ended = (outcome: Awaited<ReturnType<typeof runTurn>>) => ({
  result: outcome.result,
  cost_usd: outcome.costUsd,
  num_turns: outcome.numTurns,
  duration_ms: outcome.durationMs,
  session_id: outcome.sessionId,
});

/** Substitute `{{SECRET_NAME}}` from the agent's secrets; drop Warp-hosted servers. */
export function resolveMcp(
  servers: Record<string, McpServer>,
  secrets: Record<string, string>,
): Record<string, unknown> {
  // The definition loader refuses a reference to an undeclared secret.
  const sub = (v: string) =>
    v.replace(SECRET_REF, (_, k: string) => secrets[k] ?? "");
  const out: Record<string, unknown> = {};
  for (const [name, s] of Object.entries(servers)) {
    if ("command" in s)
      out[name] = {
        command: s.command,
        args: s.args?.map(sub) ?? [],
        env: Object.fromEntries(
          Object.entries(s.env ?? {}).map(([k, v]) => [k, sub(v)]),
        ),
      };
    else if ("url" in s)
      out[name] = {
        type: "http",
        url: sub(s.url),
        headers: Object.fromEntries(
          Object.entries(s.headers ?? {}).map(([k, v]) => [k, sub(v)]),
        ),
      };
  }
  return out;
}

/** How a run ended, for recordRunEnd. */
export interface RunEnd {
  status: RunStatus;
  /** The operator stopped it; counted as status "stopped". */
  stopped?: boolean;
  /** When the run started (ms since the epoch); no duration is observed without it. */
  startedAt?: number;
  costUsd: number;
  /** The run's spend took its work item to its budget. */
  reachedBudget?: boolean;
  error?: string | null;
}

/** Count a run's end in the metrics and log it on the run's logger. */
export function recordRunEnd(
  { metrics }: Telemetry,
  log: Logger,
  run: Pick<Run, "agent" | "harness">,
  end: RunEnd,
): void {
  const status = end.stopped ? "stopped" : end.status;
  const seconds =
    end.startedAt === undefined
      ? undefined
      : (Date.now() - end.startedAt) / 1000;
  metrics.runsTotal.inc({ agent: run.agent, harness: run.harness, status });
  if (seconds !== undefined)
    metrics.runDuration.observe(
      { agent: run.agent, harness: run.harness },
      seconds,
    );
  metrics.costUsd.inc({ agent: run.agent }, end.costUsd);
  if (end.reachedBudget) {
    metrics.itemsOverBudget.inc();
    log.warn("item.budget_reached");
  }
  const fields = {
    status,
    duration_s: seconds,
    cost_usd: end.costUsd,
    error: end.error ? end.error.slice(0, 500) : undefined,
  };
  if (status === "failed") log.warn("run.finished", fields);
  else log.info("run.finished", fields);
}

/**
 * At startup, end the runs of instances that are gone. Interrupted runs
 * continue on their own (see Store.interruptRun); only an agent run that
 * cannot continue is a failure the foreman hears of.
 */
export async function recoverOrphanedRuns(
  store: Store,
  telemetry: Telemetry,
  config: Config,
): Promise<void> {
  // First: the follow-up an interrupted run queues must not start beside its old container.
  await sweepContainers(config.dataDir, telemetry.log);
  for (const orphan of store.recoverOrphanedRuns()) {
    const run = store.runById(orphan.id);
    if (run)
      recordRunEnd(
        telemetry,
        telemetry.log.child({
          item_id: run.item_id,
          run_id: run.id,
          agent: run.agent,
        }),
        run,
        // The process that ran it is gone; only its end is counted here.
        { status: orphan.status, costUsd: 0, error: orphan.error },
      );
    if (orphan.role === "agent" && orphan.status === "failed")
      store.addEvent(orphan.item_id, "agent_report", {
        runId: String(orphan.id),
        agent: orphan.agent,
        status: "failed",
        error: orphan.error,
      });
  }
}

/**
 * Fail a run that crashed or whose hook threw: record it, release what the
 * process held for it, and tell the foreman about an agent run.
 */
export function failRun(
  store: Store,
  control: RunControl,
  run: Run,
  message: string,
): void {
  control.controllers.delete(run.id);
  control.stopped.delete(run.id);
  store.finishRun(run.id, {
    status: "failed",
    result: null,
    error: message,
    cost_usd: 0,
    num_turns: null,
    duration_ms: 0,
    session_id: run.session_id,
    log_path: run.log_path,
  });
  if (run.role === "agent")
    store.addEvent(run.item_id, "agent_report", {
      runId: String(run.id),
      agent: run.agent,
      status: "failed",
      error: message,
    });
}

/** Pause the work item with a reason for the operator. */
export function pauseItem(
  store: Store,
  log: Logger,
  itemId: number,
  reason: string,
): void {
  log.warn("item.paused", { item_id: itemId, reason });
  store.updateItem(itemId, { status: "paused" });
  store.addMessage(itemId, "factory", reason);
}

/** Whether spend since `before` took the work item from under its budget to it. */
export function reachedBudget(
  store: Store,
  itemId: number,
  before: number,
): boolean {
  const item = store.item(itemId);
  return Boolean(
    item && before < item.budget_usd && item.cost_usd >= item.budget_usd,
  );
}

/** Why an item that used its runs is paused, for the operator. */
export const runLimitPause = (item: WorkItem): string =>
  `${runLimitReached(policyState(item))} Press Raise run limit on the work item to continue, or cancel it.`;

/** The kv key prefix of the run limit an item's stop was told at. */
export const RUN_LIMIT_TOLD = "run-limit-told:";

/**
 * Tell the Operator that the item stopped at its run limit, once per limit.
 * A message to the paused item wakes it and it pauses again at the same
 * limit: that is no new stop. Raise run limit gives a new limit, so the
 * next stop at it tells the Operator again.
 */
export function runLimitNeedsYou(store: Store, item: WorkItem): void {
  const told = `${RUN_LIMIT_TOLD}${item.id}`;
  if (store.getKv(told) === String(item.max_runs)) return;
  store.setKv(told, String(item.max_runs));
  store.needsYou({
    itemId: item.id,
    event: "paused",
    what: runLimitPause(item),
  });
}
