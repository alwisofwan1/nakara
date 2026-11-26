import type { DatabaseSync } from "node:sqlite";

import type { AgentType } from "../domain/policy.ts";
import type { ReviewVerdict } from "../domain/review.ts";
import type { RepoSnapshot } from "../runner/snapshot.ts";
import type { ItemRepository } from "./items.ts";
import type { Notifier } from "./notifier.ts";
import { now, Repository, transaction } from "./repository.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "cancelled"
  /** Cut short by a restart; a queued run continues it in its session. */
  | "interrupted";
export interface Run {
  id: number;
  item_id: number;
  role: "foreman" | "agent";
  agent: string;
  agent_type: AgentType;
  harness: string;
  model: string | null;
  session_id: string | null;
  status: RunStatus;
  input: string;
  result: string | null;
  error: string | null;
  cost_usd: number;
  num_turns: number | null;
  duration_ms: number | null;
  log_path: string | null;
  started_at: string;
  ended_at: string | null;
  /** The Nakara instance that started the run; null while queued. */
  instance_id: string | null;
  /** JSON RepoSnapshot[] of the run's worktrees; null when none was recorded. */
  snapshots: string | null;
  /** The verdict a succeeded review run reported; null for other runs, and runs that predate verdicts. */
  review_verdict: ReviewVerdict | null;
  /** JSON {tool: calls} of the external MCP tools the run called; null when none. */
  tools: string | null;
  /** 1 for a dispatched review run, which used up one of its item's reviews; it gives it back when it ends without a verdict. */
  counts_review: number;
}

/** The columns the scheduler reads; not the large input and result. */
export type ScheduledRun = Pick<
  Run,
  | "id"
  | "item_id"
  | "role"
  | "agent"
  | "session_id"
  | "cost_usd"
  | "num_turns"
  | "log_path"
>;
const SCHEDULED_RUN =
  "id, item_id, role, agent, session_id, cost_usd, num_turns, log_path";

/** The input of the follow-up that resumes an interrupted agent run. */
export const RESUME_INPUT =
  "Nakara restarted while you were working, and your run was interrupted. Continue the task where you left off; the workspace still has the work you already did.";

/** Reads and writes the runs table, and ends the runs Nakara cut short. */
export class RunRepository extends Repository {
  /** The id of this process; the runs it starts carry it. */
  private readonly instanceId: string;
  /** Interrupting a run charges its work item. */
  private readonly workItems: ItemRepository;

  constructor(
    db: DatabaseSync,
    notifier: Notifier,
    instanceId: string,
    workItems: ItemRepository,
  ) {
    super(db, notifier);
    this.instanceId = instanceId;
    this.workItems = workItems;
  }

  /** Runs changed: the status bar, the item lists, and the run lists. */
  private changed(): void {
    this.notifier.notify({ type: "status", id: "global" });
    this.notifier.notify({ type: "items", id: "global" });
    this.notifier.notify({ type: "runs", id: "global" });
  }

  private runChanged(id: number): void {
    this.notifier.notify({ type: "run", id: String(id) });
  }

  /** Agent runs are created queued and started when capacity allows; foreman turns start running. */
  createRun(
    input: Pick<
      Run,
      | "item_id"
      | "role"
      | "agent"
      | "agent_type"
      | "harness"
      | "model"
      | "input"
      | "session_id"
      | "status"
    > &
      Partial<Pick<Run, "counts_review">>,
  ): Run {
    const id = this.run(
      `INSERT INTO runs (item_id, role, agent, agent_type, harness, model, session_id, status, input, started_at, instance_id, counts_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.item_id,
      input.role,
      input.agent,
      input.agent_type,
      input.harness,
      input.model,
      input.session_id,
      input.status,
      input.input,
      now(),
      input.status === "running" ? this.instanceId : null,
      input.counts_review ?? 0,
    );
    // Every run counts toward the item's run limit, however it ends, except
    // a reflect run: Nakara starts it, so it must not use up the item's work.
    if (input.agent_type !== "REFLECT") this.workItems.countRun(input.item_id);
    this.changed();
    this.runChanged(id);
    // biome-ignore lint/style/noNonNullAssertion: The synchronous insert or aggregate query guarantees a row; preserve the existing runtime behavior.
    return this.runById(id)!;
  }

  /** Point an item's run logs under `from` at the same files under `to`, once its internal files moved. */
  moveRunLogs(itemId: number, from: string, to: string): void {
    this.run(
      "UPDATE runs SET log_path = ? || substr(log_path, ?) WHERE item_id = ? AND substr(log_path, 1, ?) = ?",
      to,
      from.length + 1,
      itemId,
      from.length,
      from,
    );
    this.changed();
  }

  markRunStarted(id: number, logPath: string): void {
    this.run(
      "UPDATE runs SET status = 'running', log_path = ?, started_at = ?, instance_id = ? WHERE id = ?",
      logPath,
      now(),
      this.instanceId,
      id,
    );
    this.changed();
    this.runChanged(id);
  }

  /** Record the harness session as soon as it is known, so a running agent can be followed up. */
  setRunSession(id: number, sessionId: string): void {
    this.run("UPDATE runs SET session_id = ? WHERE id = ?", sessionId, id);
    this.changed();
    this.runChanged(id);
  }

  /** Count one call of an external MCP tool. */
  countRunTool(id: number, tool: string): void {
    const path = `$."${tool}"`;
    this.run(
      "UPDATE runs SET tools = json_set(COALESCE(tools, '{}'), ?, COALESCE(json_extract(tools, ?), 0) + 1) WHERE id = ?",
      path,
      path,
      id,
    );
    this.runChanged(id);
  }

  /** Record a run's worktree snapshots: at its start, then again with their ends. */
  setRunSnapshots(id: number, snapshots: RepoSnapshot[]): void {
    this.run(
      "UPDATE runs SET snapshots = ? WHERE id = ?",
      snapshots.length ? JSON.stringify(snapshots) : null,
      id,
    );
  }

  queuedRuns(): ScheduledRun[] {
    return this.all<ScheduledRun>(
      `SELECT ${SCHEDULED_RUN} FROM runs WHERE status = 'queued' ORDER BY id`,
    );
  }

  cancelQueuedRuns(itemId: number): void {
    for (const r of this.runs(itemId))
      if (r.status === "queued") {
        this.runChanged(r.id);
        this.giveBackReview(r, "cancelled");
      }
    this.run(
      "UPDATE runs SET status = 'cancelled', ended_at = ? WHERE item_id = ? AND status = 'queued'",
      now(),
      itemId,
    );
    this.changed();
  }

  finishRun(
    id: number,
    patch: Pick<
      Run,
      | "status"
      | "result"
      | "error"
      | "cost_usd"
      | "num_turns"
      | "duration_ms"
      | "session_id"
      | "log_path"
    > &
      Partial<Pick<Run, "review_verdict">>,
  ): void {
    const before = this.runById(id);
    if (before) this.giveBackReview(before, patch.status);
    this.run(
      `UPDATE runs SET status = ?, result = ?, error = ?, cost_usd = ?, num_turns = ?, duration_ms = ?,
              session_id = COALESCE(?, session_id), log_path = ?, review_verdict = ?, ended_at = ? WHERE id = ?`,
      patch.status,
      patch.result,
      patch.error,
      patch.cost_usd,
      patch.num_turns,
      patch.duration_ms,
      patch.session_id,
      patch.log_path,
      patch.review_verdict ?? null,
      now(),
      id,
    );
    this.changed();
    this.runChanged(id);
  }

  /**
   * Only a review that ran counts toward its item's max_reviews: a counted
   * review run that ends stopped, cancelled or failed (so without a verdict)
   * gives its review back. An interrupted one does not: the run that resumes
   * it carries the count on. Call before the run's status changes.
   */
  private giveBackReview(run: Run, status: RunStatus): void {
    if (
      !run.counts_review ||
      (run.status !== "queued" && run.status !== "running") ||
      (status !== "failed" && status !== "cancelled")
    )
      return;
    this.workItems.giveBackReview(run.item_id);
  }

  runById(id: number): Run | undefined {
    return this.get<Run>("SELECT * FROM runs WHERE id = ?", id);
  }

  runsForAgent(name: string, limit = 50): Run[] {
    return this.all<Run>(
      "SELECT * FROM runs WHERE agent = ? ORDER BY id DESC LIMIT ?",
      name,
      limit,
    );
  }

  runs(itemId: number): Run[] {
    return this.all<Run>(
      "SELECT * FROM runs WHERE item_id = ? ORDER BY id",
      itemId,
    );
  }

  /** Runs across all items, newest first, with their item's title. */
  recentRuns(
    filter: {
      status?: RunStatus;
      agent?: string;
      factoryId?: number;
      limit?: number;
    } = {},
  ): (Run & { item_title: string; factory_id: number })[] {
    return this.all(
      `SELECT r.*, w.title AS item_title, w.factory_id FROM runs r JOIN work_items w ON w.id = r.item_id
       WHERE (? IS NULL OR r.status = ?) AND (? IS NULL OR r.agent = ?) AND (? IS NULL OR w.factory_id = ?)
       ORDER BY r.id DESC LIMIT ?`,
      filter.status ?? null,
      filter.status ?? null,
      filter.agent ?? null,
      filter.agent ?? null,
      filter.factoryId ?? null,
      filter.factoryId ?? null,
      filter.limit ?? 200,
    );
  }

  /** Distinct agent names that have runs, for filtering. */
  runAgents(): string[] {
    return this.all<{ agent: string }>(
      "SELECT DISTINCT agent FROM runs ORDER BY agent",
    ).map((r) => r.agent);
  }

  runningRuns(): ScheduledRun[] {
    return this.all<ScheduledRun>(
      `SELECT ${SCHEDULED_RUN} FROM runs WHERE status = 'running' ORDER BY id`,
    );
  }

  /** The latest session of an agent within a work item (before a run, when given), for follow-ups. */
  latestAgentSession(
    itemId: number,
    agent: string,
    beforeRunId = Number.MAX_SAFE_INTEGER,
  ): string | undefined {
    return this.get<{ session_id: string }>(
      "SELECT session_id FROM runs WHERE item_id = ? AND agent = ? AND role = 'agent' AND session_id IS NOT NULL AND id < ? ORDER BY id DESC LIMIT 1",
      itemId,
      agent,
      beforeRunId,
    )?.session_id;
  }

  /**
   * End a running run that Nakara cut short: a restart, or a drain that ran
   * out of time. Adds the run's cost to its work item first. What can continue
   * is `interrupted`, not failed: a foreman turn's events are still pending, so
   * the next turn handles them, and an agent run with a session gets a queued
   * follow-up that resumes it. An agent run fails when it has no session to
   * continue, or when its item's budget is spent (its own cost included) or
   * its runs are used up: the failure report lets the foreman ask for a raise. A run of a closed work
   * item is cancelled. `error` is the reason recorded on the run. Call inside a
   * transaction.
   */
  interruptRun(
    id: number,
    ended: Pick<
      Run,
      "result" | "cost_usd" | "num_turns" | "duration_ms" | "session_id"
    >,
    reason: string,
  ): {
    status: "interrupted" | "failed" | "cancelled";
    error: string;
    resume?: Run;
  } {
    // biome-ignore lint/style/noNonNullAssertion: Runs are never deleted.
    const run = this.runById(id)!;
    this.workItems.addCost(run.item_id, ended.cost_usd);
    // biome-ignore lint/style/noNonNullAssertion: A run always belongs to an existing work item.
    const item = this.workItems.item(run.item_id)!;
    const session = ended.session_id ?? run.session_id;
    let status: "interrupted" | "failed" | "cancelled" = "interrupted";
    let error = reason;
    if (item.stage === "complete" || item.stage === "cancelled")
      status = "cancelled";
    else if (run.role === "agent" && !session) {
      status = "failed";
      error = `${reason} It had not started a session, so there is nothing to continue.`;
    } else if (run.role === "agent" && item.cost_usd >= item.budget_usd) {
      status = "failed";
      error = `${reason} The budget is spent ($${item.cost_usd.toFixed(2)} of $${item.budget_usd.toFixed(2)}), so it was not resumed.`;
    } else if (run.role === "agent" && item.run_count >= item.max_runs) {
      status = "failed";
      error = `${reason} The work item used its ${item.max_runs} runs, so it was not resumed.`;
    }
    const resume =
      status === "interrupted" && run.role === "agent" && session
        ? this.createRun({
            item_id: run.item_id,
            role: "agent",
            agent: run.agent,
            agent_type: run.agent_type,
            harness: run.harness,
            model: run.model,
            session_id: session,
            status: "queued",
            input: RESUME_INPUT,
            counts_review: run.counts_review,
          })
        : undefined;
    const recorded = resume
      ? `${error} Run #${resume.id} continues it in the same session.`
      : error;
    this.finishRun(id, {
      status,
      result: ended.result,
      error: recorded,
      cost_usd: ended.cost_usd,
      num_turns: ended.num_turns,
      duration_ms: ended.duration_ms,
      session_id: session,
      log_path: run.log_path,
    });
    return resume
      ? { status, error: recorded, resume }
      : { status, error: recorded };
  }

  /**
   * Startup recovery: interrupt the runs a stopped Nakara left 'running'
   * (see interruptRun). Returns each run with the status and error it ended with.
   * Only runs of other instances are orphans: the Store holds the database's
   * lock, so every other instance is dead. Runs this instance started are live.
   */
  recoverOrphanedRuns(): (ScheduledRun &
    Pick<ReturnType<RunRepository["interruptRun"]>, "status" | "error">)[] {
    return transaction(this.db, () =>
      this.all<ScheduledRun>(
        `SELECT ${SCHEDULED_RUN} FROM runs WHERE status = 'running' AND instance_id IS NOT ? ORDER BY id`,
        this.instanceId,
      ).map((r) => {
        const { status, error } = this.interruptRun(
          r.id,
          {
            result: null,
            cost_usd: r.cost_usd,
            num_turns: r.num_turns,
            duration_ms: null,
            session_id: r.session_id,
          },
          "Nakara restarted while this run was in progress.",
        );
        return { ...r, status, error };
      }),
    );
  }
}
