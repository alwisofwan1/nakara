import type { Approval, Message, Run, Store, WorkItem } from "../db.ts";
import {
  GATE_CHECK_LABEL,
  type GateCheck,
  gateCheckMet,
  gateEvidence,
  parseGateChecks,
  type Stage,
} from "../domain/policy.ts";
import type { ReviewVerdict } from "../domain/review.ts";
import {
  AGENT_LOOK,
  type Icon,
  type ItemViewDto,
  itemView,
  refLabel,
  type Tone,
} from "./items.ts";

export const PROGRESS_STEPS = [
  "intake",
  "triage",
  "planning",
  "spec",
  "building",
  "reviewing",
  "handoff",
  "complete",
] as const;
export type ProgressStepKey = (typeof PROGRESS_STEPS)[number];

export interface ProgressStepDto {
  key: ProgressStepKey;
  label: string;
  state: "done" | "current" | "skipped" | "todo";
  tone: Tone;
}

export interface RunCardDto {
  id: number;
  agent: string;
  /** "triage · qwen", "spec · claude opus". */
  title: string;
  icon: Icon;
  tone: Tone;
  status: Run["status"];
  summary: string | null;
  costUsd: number;
  startedAt: string;
}

export type ConversationEntryDto =
  | {
      kind: "message";
      id: number;
      author: Message["author"];
      name: string;
      body: string;
      at: string;
    }
  | ({ kind: "run"; at: string } & RunCardDto)
  | {
      kind: "approval";
      id: number;
      approval: Approval["kind"];
      status: Exclude<Approval["status"], "pending">;
      refUrl: string | null;
      refLabel: string | null;
      answer: string | null;
      at: string;
    };

export type ActionCardDto =
  | { kind: "question"; approvalId: number; prompt: string; askedAt: string }
  | {
      kind: "spec";
      approvalId: number;
      prompt: string;
      refUrl: string | null;
      refLabel: string | null;
    }
  | { kind: "live"; run: RunCardDto }
  | {
      kind: "pr";
      prUrl: string;
      prLabel: string;
      reviews: { used: number; max: number };
      revisions: { used: number; max: number };
      /** The checks the factory added to the item's Handoff Gate; empty when it added none. */
      gateChecks: GateCheckDto[];
    }
  | {
      kind: "failed";
      reason: string;
      detail: string | null;
      lastRun: { id: number; agent: string; error: string | null } | null;
    }
  | {
      kind: "complete";
      merged: boolean;
      prUrl: string | null;
      prLabel: string | null;
      costUsd: number;
      runs: number;
      revisions: number;
      reviews: number;
      /** The verdict of the last review that stated one; null without one, as for items reviewed before verdicts were recorded. */
      reviewOutcome: ReviewVerdict | null;
      /** A revision needed verdict that the implement agent revised after; no reviewer re-checked it. */
      revised: boolean;
      durationMs: number;
    }
  | { kind: "cancelled"; at: string }
  | { kind: "none" };

/** One check the item's factory added to its Handoff Gate, and whether its runs meet it. */
export interface GateCheckDto {
  check: GateCheck;
  label: string;
  met: boolean;
}

export interface ItemRunDto {
  id: number;
  name: string;
  model: string;
  status: Run["status"];
  /** Foreman turns are summed into one row. */
  turns: number | null;
  startedAt: string;
  durationMs: number | null;
  costUsd: number;
}

export interface LinkDto {
  label: string;
  url: string;
}

export interface ItemDetailDto extends ItemViewDto {
  /** The slug of the item's factory. */
  factory: string;
  request: string;
  status: { label: string; tone: Tone };
  progress: ProgressStepDto[];
  conversation: ConversationEntryDto[];
  card: ActionCardDto;
  /** The checks the factory added to the item's Handoff Gate, on top of pushed and CI passing. */
  handoffGate: GateCheckDto[];
  details: {
    source: string;
    repo: string | null;
    automation: string | null;
    requester: string | null;
    createdAt: string;
    issue: LinkDto | null;
    specPr: LinkDto | null;
    pr: (LinkDto & { merged: boolean }) | null;
  };
  counters: {
    reviews: { used: number; max: number };
    revisions: { used: number; max: number };
  };
  runs: ItemRunDto[];
  closed: boolean;
}

const STEP_LABEL: Record<ProgressStepKey, string> = {
  intake: "Intake",
  triage: "Triage",
  planning: "Planning",
  spec: "Spec approval",
  building: "Building",
  reviewing: "Reviewing",
  handoff: "Handoff",
  complete: "Complete",
};

const STAGE_TONE: Partial<Record<Stage, Tone>> = {
  building: "building",
  reviewing: "reviewing",
  handoff: "handoff",
};

const NEEDS_YOU_TONE: Record<ItemViewDto["needsYou"]["kind"], Tone> = {
  spec: "attention",
  question: "attention",
  pr: "handoff",
  failed: "bad",
  none: "accent",
};

const SOURCE_LABEL: Record<WorkItem["source"], string> = {
  github: "GitHub issue",
  telegram: "Telegram",
  slack: "Slack",
  schedule: "Schedule",
  manual: "Manual",
};

const modelLabel = (run: Run) =>
  run.model ? `${run.harness} ${run.model}` : run.harness;

/** The first prose line of a report or error, without markdown markers. */
function summaryOf(run: Run): string | null {
  const text =
    run.status === "failed" || run.status === "interrupted"
      ? (run.error ?? run.result)
      : run.result;
  const line = text
    ?.split("\n")
    .map((l) => l.replace(/^[\s#>*-]+/, "").trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 200 ? `${line.slice(0, 199)}…` : line;
}

function runCard(run: Run): RunCardDto {
  return {
    id: run.id,
    agent: run.agent,
    title: `${run.agent} · ${modelLabel(run)}`,
    ...AGENT_LOOK[run.agent_type],
    status: run.status,
    summary: summaryOf(run),
    costUsd: run.cost_usd,
    startedAt: run.started_at,
  };
}

function progress(
  item: WorkItem,
  view: ItemViewDto,
  approvals: Approval[],
): ProgressStepDto[] {
  if (item.stage === "cancelled")
    return PROGRESS_STEPS.map((key) =>
      key === "complete"
        ? { key, label: "Cancelled", state: "current", tone: "muted" }
        : { key, label: STEP_LABEL[key], state: "todo", tone: "muted" },
    );
  const awaitingSpec =
    item.spec_state === "awaiting_approval" ||
    approvals.some((a) => a.kind === "spec" && a.status === "pending");
  const current: ProgressStepKey = awaitingSpec ? "spec" : item.stage;
  const at = PROGRESS_STEPS.indexOf(current);
  const hadSpec =
    item.spec_state !== "none" || approvals.some((a) => a.kind === "spec");
  return PROGRESS_STEPS.map((key, index) => {
    const step = { key, label: STEP_LABEL[key] };
    if (item.stage === "complete")
      return { ...step, state: "done", tone: "muted" };
    if (index < at)
      return {
        ...step,
        state: key === "spec" && !hadSpec ? "skipped" : "done",
        tone: "muted",
      };
    if (index > at) return { ...step, state: "todo", tone: "muted" };
    const tone =
      view.needsYou.kind !== "none"
        ? NEEDS_YOU_TONE[view.needsYou.kind]
        : (STAGE_TONE[item.stage] ?? "accent");
    return { ...step, state: "current", tone };
  });
}

function statusOf(
  item: WorkItem,
  view: ItemViewDto,
): { label: string; tone: Tone } {
  if (item.stage === "complete") return { label: "Complete", tone: "handoff" };
  if (item.stage === "cancelled") return { label: "Cancelled", tone: "muted" };
  if (view.needsYou.label)
    return {
      label: view.needsYou.label,
      tone: NEEDS_YOU_TONE[view.needsYou.kind],
    };
  if (item.status === "waiting_human")
    return { label: "Waiting for you", tone: "attention" };
  if (view.agent.running) return { label: "Working", tone: "building" };
  return { label: "Active", tone: "accent" };
}

function actionCard(
  item: WorkItem,
  view: ItemViewDto,
  runs: Run[],
  approvals: Approval[],
): ActionCardDto {
  const pending = (kind: Approval["kind"]) =>
    approvals.findLast((a) => a.kind === kind && a.status === "pending");
  const agentRuns = runs.filter((r) => r.role === "agent");
  switch (view.actionCard) {
    case "question": {
      const approval = pending("question");
      if (!approval) return { kind: "none" };
      return {
        kind: "question",
        approvalId: approval.id,
        prompt: approval.prompt,
        askedAt: approval.created_at,
      };
    }
    case "spec": {
      const approval = pending("spec");
      if (!approval) return { kind: "none" };
      return {
        kind: "spec",
        approvalId: approval.id,
        prompt: approval.prompt,
        refUrl: approval.ref_url,
        refLabel: approval.ref_url
          ? `Spec ${refLabel(approval.ref_url)}`
          : null,
      };
    }
    case "live": {
      const run = agentRuns.findLast(
        (r) => r.status === "running" || r.status === "queued",
      );
      return run ? { kind: "live", run: runCard(run) } : { kind: "none" };
    }
    case "pr":
      if (!item.pr_url) return { kind: "none" };
      return {
        kind: "pr",
        prUrl: item.pr_url,
        prLabel: `PR ${refLabel(item.pr_url)}`,
        reviews: { used: item.review_count, max: item.max_reviews },
        revisions: { used: item.revision_count, max: item.max_revisions },
        gateChecks: handoffGate(item, runs),
      };
    case "failed": {
      const last = agentRuns.at(-1);
      const failed = last?.status === "failed" ? last : undefined;
      return {
        kind: "failed",
        reason: view.needsYou.label ?? "Run failed",
        // Budget and pause notices are already the foreman's last message.
        detail: failed?.error ?? null,
        lastRun: failed
          ? { id: failed.id, agent: failed.agent, error: failed.error }
          : null,
      };
    }
    case "complete": {
      // A follow-up review that states no verdict keeps the earlier outcome.
      const review = agentRuns.findLast(
        (r) => r.agent_type === "REVIEW" && r.review_verdict !== null,
      );
      return {
        kind: "complete",
        merged: item.pr_merged === 1,
        prUrl: item.pr_url,
        prLabel: item.pr_url ? `PR ${refLabel(item.pr_url)}` : null,
        costUsd: item.cost_usd,
        runs: agentRuns.length,
        revisions: item.revision_count,
        reviews: item.review_count,
        reviewOutcome: review?.review_verdict ?? null,
        revised:
          review?.review_verdict === "revision_needed" &&
          agentRuns.some(
            (r) =>
              r.id > review.id &&
              r.agent_type === "IMPLEMENT" &&
              r.status === "succeeded",
          ),
        durationMs: Math.max(
          0,
          Date.parse(item.updated_at) - Date.parse(item.created_at),
        ),
      };
    }
    case "cancelled":
      return { kind: "cancelled", at: item.updated_at };
    default:
      return { kind: "none" };
  }
}

/** The item's added Handoff Gate checks, met or not by its latest review and verify runs. */
function handoffGate(item: WorkItem, runs: Run[]): GateCheckDto[] {
  const evidence = gateEvidence(runs);
  return parseGateChecks(item.gate_checks).map((check) => ({
    check,
    label: GATE_CHECK_LABEL[check],
    met: gateCheckMet(evidence, check),
  }));
}

function runRows(runs: Run[]): ItemRunDto[] {
  const rows: ItemRunDto[] = [];
  const turns = runs.filter((r) => r.role === "foreman");
  const latest = turns.at(-1);
  if (latest)
    rows.push({
      id: latest.id,
      name: latest.agent,
      model: modelLabel(latest),
      status: latest.status,
      turns: turns.length,
      startedAt: turns[0]?.started_at ?? latest.started_at,
      durationMs: null,
      costUsd: turns.reduce((sum, r) => sum + r.cost_usd, 0),
    });
  for (const run of runs)
    if (run.role === "agent")
      rows.push({
        id: run.id,
        name: run.agent,
        model: modelLabel(run),
        status: run.status,
        turns: null,
        startedAt: run.started_at,
        durationMs: run.duration_ms,
        costUsd: run.cost_usd,
      });
  return rows;
}

/** Pure detail view of one work item for its page: no clock, no I/O. */
export function itemDetail(
  item: WorkItem,
  runs: Run[],
  approvals: Approval[],
  messages: Message[],
  factory = "",
): ItemDetailDto {
  const view = itemView(item, runs, approvals);
  const card = actionCard(item, view, runs, approvals);
  // The live run is the action card; it joins the history once it ends.
  const live = card.kind === "live" ? card.run.id : null;
  const conversation: ConversationEntryDto[] = [
    // Intake stores the request on the item, not as a message.
    {
      kind: "message",
      id: 0,
      author: "human",
      name: item.requester ?? (item.source === "schedule" ? "Schedule" : "You"),
      body: item.request,
      at: item.created_at,
    },
    ...messages.map(
      (m): ConversationEntryDto => ({
        kind: "message",
        id: m.id,
        author: m.author,
        name: m.author === "factory" ? "Foreman" : (item.requester ?? "You"),
        body: m.body,
        at: m.created_at,
      }),
    ),
    ...runs
      .filter((r) => r.role === "agent" && r.id !== live)
      .map(
        (r): ConversationEntryDto => ({
          kind: "run",
          at: r.started_at,
          ...runCard(r),
        }),
      ),
    // Pending approvals are the action card; resolved ones stay in the history.
    ...approvals.flatMap((a): ConversationEntryDto[] =>
      a.status === "pending"
        ? []
        : [
            {
              kind: "approval",
              id: a.id,
              approval: a.kind,
              status: a.status,
              refUrl: a.ref_url,
              refLabel: a.ref_url ? refLabel(a.ref_url) : null,
              answer: a.answer,
              at: a.resolved_at ?? a.created_at,
            },
          ],
    ),
  ];
  // Stable: same-instant entries keep messages, then runs, then approvals.
  conversation.sort((a, b) => a.at.localeCompare(b.at));

  const issueUrl =
    item.issue_url ?? (item.source === "github" ? item.source_url : null);
  const specPr = approvals.findLast((a) => a.kind === "spec" && a.ref_url);
  return {
    factory,
    ...view,
    request: item.request,
    status: statusOf(item, view),
    progress: progress(item, view, approvals),
    conversation,
    card,
    handoffGate: handoffGate(item, runs),
    details: {
      source: SOURCE_LABEL[item.source],
      repo: item.repo,
      automation: item.automation,
      requester: item.requester,
      createdAt: item.created_at,
      issue: issueUrl
        ? { label: `Issue ${refLabel(issueUrl, true)}`, url: issueUrl }
        : null,
      specPr:
        specPr?.ref_url && specPr.ref_url !== item.pr_url
          ? {
              label: `Spec ${refLabel(specPr.ref_url)}`,
              url: specPr.ref_url,
            }
          : null,
      pr: item.pr_url
        ? {
            label: `PR ${refLabel(item.pr_url)}`,
            url: item.pr_url,
            merged: item.pr_merged === 1,
          }
        : null,
    },
    counters: {
      reviews: { used: item.review_count, max: item.max_reviews },
      revisions: { used: item.revision_count, max: item.max_revisions },
    },
    runs: runRows(runs),
    closed: item.stage === "complete" || item.stage === "cancelled",
  };
}

export function readItem(store: Store, id: number): ItemDetailDto | undefined {
  const item = store.item(id);
  if (!item) return undefined;
  return itemDetail(
    item,
    store.runs(id),
    store.approvals(id),
    store.messages(id),
    store.repos.factories.factoryById(item.factory_id)?.slug,
  );
}
