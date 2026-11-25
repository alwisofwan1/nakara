import type { Approval, Run, Store, WorkItem } from "../db.ts";
import { uncheckedKey } from "../db/learnings.ts";
import type { AgentType, Stage } from "../domain/policy.ts";

export const STAGE_GROUPS = [
  "triage",
  "planning",
  "building",
  "reviewing",
  "handoff",
  "complete",
] as const;
export type StageGroup = (typeof STAGE_GROUPS)[number];

/** Theme token families; the client maps each to its token utilities. */
export type Tone =
  | "muted"
  | "accent"
  | "attention"
  | "building"
  | "reviewing"
  | "handoff"
  | "bad";
export type Icon =
  | "sparkles"
  | "scan-search"
  | "file-text"
  | "code-xml"
  | "git-pull-request"
  | "check"
  | "bot"
  | "github"
  | "send"
  | "clock"
  | "user";

export type NeedsYouKind = "spec" | "question" | "pr" | "failed" | "none";
export type ActionCardKind =
  | "spec"
  | "question"
  | "failed"
  | "pr"
  | "live"
  | "complete"
  | "cancelled"
  | "none";

export interface ChipDto {
  kind: "source" | "spec_pr" | "pr" | "edited";
  label: string;
  icon: Icon;
  url: string | null;
}

export interface ItemViewDto {
  id: number;
  title: string;
  stage: Stage;
  group: StageGroup;
  source: WorkItem["source"];
  agent: {
    name: string;
    type: AgentType;
    icon: Icon;
    tone: Tone;
    running: boolean;
  };
  needsYou: { kind: NeedsYouKind; label: string | null };
  actionCard: ActionCardKind;
  chips: ChipDto[];
  /** Someone without write access changed the request after the label was applied. */
  requestEdited: boolean;
  budget: {
    usedUsd: number;
    limitUsd: number;
    ratio: number;
    exhausted: boolean;
  };
  /** Runs started of the item's limit: foreman turns and agent runs, failed ones included. */
  runLimit: { used: number; max: number; exhausted: boolean };
  updatedAt: string;
}

const GROUP: Record<Stage, StageGroup> = {
  intake: "triage",
  triage: "triage",
  planning: "planning",
  building: "building",
  reviewing: "reviewing",
  handoff: "handoff",
  complete: "complete",
  cancelled: "complete",
};

export const AGENT_LOOK: Record<AgentType, { icon: Icon; tone: Tone }> = {
  FOREMAN: { icon: "sparkles", tone: "accent" },
  TRIAGE: { icon: "scan-search", tone: "muted" },
  SPEC: { icon: "file-text", tone: "attention" },
  IMPLEMENT: { icon: "code-xml", tone: "building" },
  REVIEW: { icon: "git-pull-request", tone: "reviewing" },
  VERIFY: { icon: "check", tone: "handoff" },
  CUSTOM: { icon: "bot", tone: "muted" },
  REFLECT: { icon: "sparkles", tone: "muted" },
};

const NEEDS_YOU_LABEL: Record<Exclude<NeedsYouKind, "none">, string> = {
  spec: "Spec needs approval",
  question: "Asked you a question",
  pr: "Ready to merge",
  failed: "Run failed",
};

const isActive = (run: Run) =>
  run.status === "running" || run.status === "queued";

/** "owner/repo/pull/12" → "#12"; issues keep the repo name: "repo#5". */
export function refLabel(url: string, withRepo = false): string {
  const match = /github\.com\/[^/]+\/([^/]+)\/(?:pull|issues)\/(\d+)/.exec(url);
  if (!match) return url;
  return withRepo ? `${match[1]}#${match[2]}` : `#${match[2]}`;
}

function sourceChip(item: WorkItem): ChipDto {
  switch (item.source) {
    case "github": {
      const url = item.source_url ?? item.issue_url;
      return {
        kind: "source",
        label: url ? refLabel(url, true) : (item.repo ?? "GitHub"),
        icon: "github",
        url,
      };
    }
    case "telegram":
      return { kind: "source", label: "Telegram", icon: "send", url: null };
    case "slack":
      return { kind: "source", label: "Slack", icon: "send", url: null };
    case "schedule":
      return {
        kind: "source",
        label: item.automation ?? "Schedule",
        icon: "clock",
        url: null,
      };
    default:
      return { kind: "source", label: "Manual", icon: "user", url: null };
  }
}

/** The needs-you label of an item that used its runs. */
export const RUN_LIMIT_REACHED = "Run limit reached";

/** Pure view of one work item: no clock, no I/O. Runs and approvals in id order. */
export function itemView(
  item: WorkItem,
  runs: Run[],
  approvals: Approval[],
): ItemViewDto {
  const closed = item.stage === "complete" || item.stage === "cancelled";
  const pending = approvals.filter((a) => a.status === "pending");
  const agentRuns = runs.filter((r) => r.role === "agent");
  const active = closed
    ? undefined
    : (agentRuns.findLast(isActive) ?? runs.findLast(isActive));
  const shown = active ?? agentRuns.at(-1);
  const agentType = shown?.agent_type ?? "FOREMAN";
  const exhausted = item.cost_usd >= item.budget_usd;
  // Merging a handed-off PR spends nothing, so the budget does not block it.
  const runsExhausted = item.run_count >= item.max_runs;
  const blocked = exhausted && item.stage !== "handoff";
  // Merging needs no run either.
  const runBlocked = runsExhausted && item.stage !== "handoff";
  const lastFailed = !active && agentRuns.at(-1)?.status === "failed";

  let needsYou: NeedsYouKind = "none";
  let failure: string | null = null;
  if (!closed) {
    if (pending.some((a) => a.kind === "spec")) needsYou = "spec";
    else if (pending.some((a) => a.kind === "question")) needsYou = "question";
    else if (blocked || runBlocked || item.status === "paused" || lastFailed) {
      needsYou = "failed";
      failure = blocked
        ? "Budget exhausted"
        : runBlocked
          ? RUN_LIMIT_REACHED
          : lastFailed
            ? "Run failed"
            : "Paused";
    } else if (item.stage === "handoff") needsYou = "pr";
  }

  const chips: ChipDto[] = [];
  const specPr = approvals.findLast((a) => a.kind === "spec" && a.ref_url);
  if (specPr?.ref_url && specPr.ref_url !== item.pr_url)
    chips.push({
      kind: "spec_pr",
      label: `Spec ${refLabel(specPr.ref_url, false)}`,
      icon: "file-text",
      url: specPr.ref_url,
    });
  if (item.pr_url && needsYou !== "pr")
    chips.push({
      kind: "pr",
      label: `PR ${refLabel(item.pr_url, false)}`,
      icon: "git-pull-request",
      url: item.pr_url,
    });
  chips.push(sourceChip(item));
  if (item.request_edited)
    chips.push({
      kind: "edited",
      label: "Request changed after labelling",
      icon: "user",
      url: null,
    });

  return {
    id: item.id,
    title: item.title,
    stage: item.stage,
    group: GROUP[item.stage],
    source: item.source,
    agent: {
      name: shown?.agent ?? "foreman",
      type: agentType,
      ...AGENT_LOOK[agentType],
      running: Boolean(active),
    },
    needsYou: {
      kind: needsYou,
      label:
        needsYou === "none" ? null : (failure ?? NEEDS_YOU_LABEL[needsYou]),
    },
    actionCard: closed
      ? (item.stage as "complete" | "cancelled")
      : needsYou !== "none"
        ? needsYou
        : active?.role === "agent"
          ? "live"
          : "none",
    chips,
    requestEdited: item.request_edited === 1,
    budget: {
      usedUsd: item.cost_usd,
      limitUsd: item.budget_usd,
      ratio:
        item.budget_usd > 0 ? Math.min(1, item.cost_usd / item.budget_usd) : 1,
      exhausted,
    },
    runLimit: {
      used: item.run_count,
      max: item.max_runs,
      exhausted: runsExhausted,
    },
    updatedAt: item.updated_at,
  };
}

const GROUP_LABEL: Record<StageGroup, string> = {
  triage: "Triage",
  planning: "Planning",
  building: "Building",
  reviewing: "Reviewing",
  handoff: "Handoff",
  complete: "Complete",
};

/** One-line state for notifications: "Needs you · spec", "Handoff · PR #14". */
export function stateLabel(item: WorkItem, view: ItemViewDto): string {
  const kind = view.needsYou.kind;
  if (kind !== "none" && kind !== "pr") return `Needs you · ${kind}`;
  const stage =
    item.stage === "cancelled" ? "Cancelled" : GROUP_LABEL[view.group];
  return item.pr_url ? `${stage} · PR ${refLabel(item.pr_url)}` : stage;
}

export interface ActivityDto {
  /** Every open item, plus the most recently updated closed ones. */
  items: ItemViewDto[];
  summary: { open: number; needsYou: number; costUsd: number };
  /** Closed work only; a rate is null until there is something to divide by. */
  outcomes: OutcomesDto;
  /** Approved lessons and how often their mistake came back (T4). */
  lessons: LessonDto[];
  /** Corrections no reflect run checked: recurrences among them went uncounted. */
  uncheckedCorrections: number;
}

export interface LessonDto {
  id: number;
  lines: string[];
  mistake: string;
  recurrences: number;
  approvedAt: string | null;
}

export interface OutcomesDto {
  /** Closed items that opened a pull request. */
  prs: number;
  merged: number;
  closedUnmerged: number;
  revisionsPerItem: number | null;
  /** Every closed item's cost over the merged PRs. */
  costPerMergedPrUsd: number | null;
  /** Request to last merge. */
  medianCycleHours: number | null;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  // biome-ignore lint/style/noNonNullAssertion: mid is in range.
  if (sorted.length % 2) return sorted[mid]!;
  // biome-ignore lint/style/noNonNullAssertion: mid - 1 and mid are in range.
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function readOutcomes(store: Store, factoryId?: number): OutcomesDto {
  const o = store.outcomes(factoryId);
  return {
    prs: o.prs,
    merged: o.merged,
    closedUnmerged: o.prs - o.merged,
    revisionsPerItem: o.prs ? o.revisions / o.prs : null,
    costPerMergedPrUsd: o.merged ? o.costUsd / o.merged : null,
    medianCycleHours: median(o.cycleHours),
  };
}

/** Closed items are history; only the latest are listed. */
export const CLOSED_LIMIT = 200;

/** The items of the factory with factoryId, or of every factory when omitted. */
export function readActivity(store: Store, factoryId?: number): ActivityDto {
  const view = (item: WorkItem) =>
    itemView(item, store.runs(item.id), store.approvals(item.id));
  const open = store.items({ open: true, factoryId }).map(view);
  return {
    items: [...open, ...store.closedItems(CLOSED_LIMIT, factoryId).map(view)],
    summary: {
      open: open.length,
      needsYou: open.filter((item) => item.needsYou.kind !== "none").length,
      costUsd: store.totalCost(factoryId),
    },
    outcomes: readOutcomes(store, factoryId),
    lessons: store.approvedLearnings(factoryId).map((l) => ({
      id: l.id,
      lines: JSON.parse(l.lines) as string[],
      mistake: l.mistake,
      recurrences: l.recurrences,
      approvedAt: l.resolved_at,
    })),
    uncheckedCorrections: store.repos.factories
      .factories()
      .filter((f) => factoryId === undefined || f.id === factoryId)
      .reduce(
        (sum, f) => sum + Number(store.getKv(uncheckedKey(f.id)) ?? 0),
        0,
      ),
  };
}
