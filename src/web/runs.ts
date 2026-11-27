import { join } from "node:path";
import { z } from "zod";
import type { Run, RunStatus, Store } from "../db.ts";
import type { AgentType } from "../domain/policy.ts";
import { checkFollowUp } from "../orchestrator/follow-up.ts";
import { fallbackOf } from "../orchestrator/limit-wait.ts";

export const runsQuery = z.object({
  status: z
    .enum([
      "queued",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "interrupted",
    ])
    .optional(),
  agent: z.string().trim().min(1).max(200).optional(),
  /** Only the runs of the factory with this slug. */
  factory: z.string().trim().min(1).max(200).optional(),
});
export type RunsQuery = z.infer<typeof runsQuery>;

export interface RunRowDto {
  id: number;
  itemId: number;
  itemTitle: string;
  /** The slug of the item's factory. */
  factory: string;
  role: "foreman" | "agent";
  agent: string;
  agentType: AgentType;
  harness: string;
  model: string | null;
  status: RunStatus;
  costUsd: number;
  startedAt: string;
  endedAt: string | null;
  /** Null while the run has not ended; the client derives live duration from startedAt. */
  durationMs: number | null;
}

export interface RunsDto {
  runs: RunRowDto[];
  agents: string[];
  /** True when more runs match than the latest RUNS_LIMIT returned. */
  truncated: boolean;
}

export const RUNS_LIMIT = 200;

/**
 * Read-only projection of runs across items, newest first; no clock in the
 * DTO. Across factories, or of the one with factoryId.
 */
export function readRuns(
  store: Store,
  query: Omit<RunsQuery, "factory"> & { factoryId?: number | null } = {},
): RunsDto {
  const slugs = new Map(
    store.repos.factories.factories().map((f) => [f.id, f.slug]),
  );
  const runs = store.recentRuns({
    ...query,
    factoryId: query.factoryId ?? undefined,
    limit: RUNS_LIMIT + 1,
  });
  return {
    runs: runs.slice(0, RUNS_LIMIT).map((run) => ({
      id: run.id,
      itemId: run.item_id,
      itemTitle: run.item_title,
      factory: slugs.get(run.factory_id) ?? "",
      role: run.role,
      agent: run.agent,
      agentType: run.agent_type,
      harness: run.harness,
      model: run.model,
      status: run.status,
      costUsd: run.cost_usd,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      durationMs:
        run.duration_ms ??
        (run.ended_at && run.status !== "cancelled"
          ? Math.max(0, Date.parse(run.ended_at) - Date.parse(run.started_at))
          : null),
    })),
    agents: store.runAgents(),
    truncated: runs.length > RUNS_LIMIT,
  };
}

export interface RunSummaryDto {
  id: number;
  role: Run["role"];
  agent: string;
  harness: string;
  model: string | null;
  status: RunStatus;
  costUsd: number;
}

export interface RunDetailDto extends RunSummaryDto {
  item: { id: number; title: string };
  /** The slug of the item's factory. */
  factory: string;
  agentType: AgentType;
  /** 1 for the first run of this agent on the item, 2 for its first follow-up, … */
  attempt: number;
  sessionId: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  numTurns: number | null;
  runner: string;
  /** Whether the run's runner has a docker image, so it runs in a container. */
  docker: boolean;
  worktree: string;
  logPath: string | null;
  /** The message the run was started with: the foreman's brief or a follow-up. */
  input: string;
  /** The agent's system prompt, when it is still on disk. */
  systemPrompt: string | null;
  /** Whether Nakara kept the output of a verify it ran after this run, served at /runs/:id/verify-log. */
  verifyLog: boolean;
  report: string | null;
  error: string | null;
  /** The run retries the brief of a run that hit a rate or usage limit, on a fallback harness. */
  fallback: {
    runId: number;
    harness: string;
    reason: string;
    resetAt: string | null;
  } | null;
  /** External MCP tools called, with counts; Nakara's own are not listed. */
  tools: { name: string; calls: number }[];
  followUp: {
    allowed: boolean;
    reason: string | null;
    countsAsRevision: boolean;
    revisions: { used: number; max: number };
  };
  otherRuns: RunSummaryDto[];
}

export interface RunContext {
  workDir: string;
  /** The agent's type and runner in the loaded definition; undefined once it was removed. */
  agent: (
    name: string,
  ) => { type: AgentType; runner: string; docker: boolean } | undefined;
  systemPrompt: string | null;
  verifyLog: boolean;
}

const summary = (run: Run): RunSummaryDto => ({
  id: run.id,
  role: run.role,
  agent: run.agent,
  harness: run.harness,
  model: run.model,
  status: run.status,
  costUsd: run.cost_usd,
});

/** Read-only projection of one run, its follow-up policy and its siblings. */
export function readRun(
  store: Store,
  id: number,
  context: RunContext,
): RunDetailDto | undefined {
  const run = store.runById(id);
  if (!run) return undefined;
  // biome-ignore lint/style/noNonNullAssertion: A run always belongs to an existing work item.
  const item = store.item(run.item_id)!;
  const runs = store.runs(item.id);
  const agent = run.role === "agent" ? context.agent(run.agent) : undefined;
  const verdict = checkFollowUp(store, run, agent?.type);
  return {
    ...summary(run),
    item: { id: item.id, title: item.title },
    factory: store.repos.factories.factoryById(item.factory_id)?.slug ?? "",
    agentType: run.agent_type,
    attempt: runs.filter(
      (r) => r.role === run.role && r.agent === run.agent && r.id <= run.id,
    ).length,
    sessionId: run.session_id,
    startedAt: run.started_at,
    endedAt: run.ended_at,
    durationMs: run.duration_ms,
    numTurns: run.num_turns,
    runner: run.role === "foreman" ? "local" : (agent?.runner ?? "unknown"),
    docker: agent?.docker ?? false,
    worktree: join(context.workDir, `item-${item.id}`),
    logPath: run.log_path,
    input: run.input,
    systemPrompt: context.systemPrompt,
    verifyLog: context.verifyLog,
    report: run.result,
    error: run.error,
    fallback: fallbackOf(store, run.id),
    tools: Object.entries(
      JSON.parse(run.tools ?? "{}") as Record<string, number>,
    ).map(([name, calls]) => ({ name, calls })),
    followUp: {
      allowed: verdict.ok,
      reason: verdict.ok ? null : verdict.reason,
      countsAsRevision:
        verdict.ok && verdict.next.revisionCount > item.revision_count,
      revisions: {
        used: item.revision_count,
        max: item.max_revisions,
      },
    },
    otherRuns: runs.filter((r) => r.id !== run.id).map(summary),
  };
}

/** Where an agent run's system prompt was written, next to its log. */
export const systemPromptPath = (run: Run) =>
  run.role === "agent" && run.log_path
    ? join(run.log_path, "..", "..", `run-${run.id}.system.md`)
    : null;
