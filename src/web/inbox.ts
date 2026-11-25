import type {
  Approval,
  Learning,
  Message,
  Run,
  Store,
  WorkItem,
} from "../db.ts";
import { LEARNING_MAX_LINES, LEARNING_MAX_CHARS } from "../definition/write.ts";
import { z } from "zod";
import {
  type ChipDto,
  type Icon,
  itemView,
  type NeedsYouKind,
  RUN_LIMIT_REACHED,
  refLabel,
  type Tone,
} from "./items.ts";

export type InboxKind = Exclude<NeedsYouKind, "none">;
export const INBOX_KINDS = ["question", "spec", "pr", "failed"] as const;

export interface InboxEventDto {
  at: string;
  icon: Icon;
  tone: Tone;
  text: string;
}

export interface InboxEntryDto {
  kind: InboxKind;
  itemId: number;
  /** The slug of the item's factory. */
  factory: string;
  title: string;
  /** Why the item needs you, e.g. "Budget exhausted". */
  label: string;
  /** The spec summary, the question, or what is ready or broken. */
  summary: string;
  /** When the item started needing you. */
  at: string;
  chips: ChipDto[];
  costUsd: number;
  prUrl: string | null;
  /** The pending spec approval or question this entry acts on. */
  approval: {
    id: number;
    prompt: string;
    refUrl: string | null;
    options: string[];
  } | null;
  /** The latest agent runs and messages, oldest first. */
  recent: InboxEventDto[];
}

/** A reload that widens what a factory's agents can reach and waits for the operator. */
export interface InboxReachDto {
  factory: string;
  /** The reach lines the reload adds. */
  added: string[];
}

/** A lesson a reflect run proposed after a correction; approving writes it to the factory's learnings skill. */
export interface InboxLessonDto {
  id: number;
  factory: string;
  itemId: number;
  itemTitle: string;
  lines: string[];
  /** The mistake the lesson targets. */
  mistake: string;
  /** The reflect run thinks a lint rule, type or test should hold it instead. */
  suggestCheck: boolean;
  at: string;
}

export interface InboxDto {
  /** Newest first. */
  entries: InboxEntryDto[];
  /** Held reloads, one per factory at most. */
  reach: InboxReachDto[];
  /** Pending lessons, oldest first. */
  lessons: InboxLessonDto[];
  counts: Record<InboxKind | "all", number>;
}

export const RECENT_LIMIT = 5;

const firstLine = (text: string, max = 140) => {
  const line = text.trim().split("\n", 1)[0] ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function parseOptions(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((option): option is string => typeof option === "string")
      : [];
  } catch {
    return [];
  }
}

const RUN_TEXT: Record<Run["status"], (run: Run) => string> = {
  queued: (run) => `Foreman dispatched ${run.agent}`,
  running: (run) => `Foreman dispatched ${run.agent}`,
  succeeded: (run) => `${run.agent} finished`,
  failed: (run) => `${run.agent} run #${run.id} failed`,
  cancelled: (run) => `${run.agent} run #${run.id} was cancelled`,
  interrupted: (run) =>
    `${run.agent} run #${run.id} was interrupted by a restart`,
};

function recentEvents(runs: Run[], messages: Message[]): InboxEventDto[] {
  const events: InboxEventDto[] = [
    ...runs
      .filter((run) => run.role === "agent")
      .map((run) => ({
        at: run.ended_at ?? run.started_at,
        icon: "bot" as const,
        tone: (run.status === "failed" ? "bad" : "muted") as Tone,
        text: RUN_TEXT[run.status](run),
      })),
    ...messages.map((message) =>
      message.author === "factory"
        ? {
            at: message.created_at,
            icon: "sparkles" as const,
            tone: "accent" as const,
            text: `Foreman: ${firstLine(message.body)}`,
          }
        : {
            at: message.created_at,
            icon: "user" as const,
            tone: "muted" as const,
            text: `You: ${firstLine(message.body)}`,
          },
    ),
  ];
  return events.sort((a, b) => a.at.localeCompare(b.at)).slice(-RECENT_LIMIT);
}

function failureSummary(
  item: WorkItem,
  label: string,
  runs: Run[],
  messages: Message[],
): string {
  if (label === "Budget exhausted")
    return `Spent $${item.cost_usd.toFixed(2)} of the $${item.budget_usd.toFixed(2)} budget.`;
  if (label === RUN_LIMIT_REACHED)
    return `Started ${item.run_count} of the ${item.max_runs} runs allowed (foreman turns and failed runs included).`;
  const failed = runs.findLast((run) => run.role === "agent");
  if (label === "Run failed" && failed)
    return `${failed.agent} run #${failed.id} failed${failed.error ? `: ${firstLine(failed.error)}` : "."}`;
  const said = messages.findLast((message) => message.author === "factory");
  return said ? firstLine(said.body) : "Paused until you reply.";
}

/** Pure view of one item in the Inbox, or null when it does not need you. */
export function inboxEntry(
  item: WorkItem,
  runs: Run[],
  approvals: Approval[],
  messages: Message[],
  factory = "",
): InboxEntryDto | null {
  const view = itemView(item, runs, approvals);
  const kind = view.needsYou.kind;
  if (kind === "none") return null;
  const approval =
    kind === "spec" || kind === "question"
      ? approvals.find((a) => a.status === "pending" && a.kind === kind)
      : undefined;
  const label = view.needsYou.label ?? "";
  const summary = approval
    ? approval.prompt
    : kind === "pr"
      ? `${item.pr_url ? `PR ${refLabel(item.pr_url, false)}` : "The PR"} is ready for review and merge.`
      : failureSummary(item, label, runs, messages);
  return {
    kind,
    itemId: item.id,
    factory,
    title: item.title,
    label,
    summary,
    at: approval?.created_at ?? item.updated_at,
    chips: view.chips,
    costUsd: item.cost_usd,
    prUrl: item.pr_url,
    approval: approval
      ? {
          id: approval.id,
          prompt: approval.prompt,
          refUrl: approval.ref_url,
          options: parseOptions(approval.options),
        }
      : null,
    recent: recentEvents(runs, messages),
  };
}

/** The held reach of each factory (see DefinitionService.pendingReach), or of the one with factoryId. */
function pendingReach(
  store: Store,
  factoryId: number | null | undefined,
): InboxReachDto[] {
  return store.repos.factories
    .factories()
    .filter((f) => factoryId == null || f.id === factoryId)
    .flatMap((f) => {
      const held = store.getKv(`reach:${f.id}:pending`);
      return held
        ? [
            {
              factory: f.slug,
              added: (JSON.parse(held) as { added: string[] }).added,
            },
          ]
        : [];
    });
}

/** Pending lessons of every factory, or of the one with factoryId. */
function pendingLessons(
  store: Store,
  factoryId: number | null | undefined,
): InboxLessonDto[] {
  const slugs = new Map(
    store.repos.factories.factories().map((f) => [f.id, f.slug]),
  );
  return store.pendingLearnings().flatMap((l: Learning) => {
    const item = store.item(l.item_id);
    if (!item || (factoryId != null && item.factory_id !== factoryId))
      return [];
    return [
      {
        id: l.id,
        factory: slugs.get(item.factory_id) ?? "",
        itemId: item.id,
        itemTitle: item.title,
        lines: parseOptions(l.lines),
        mistake: l.mistake,
        suggestCheck: l.suggest_check === 1,
        at: l.created_at,
      },
    ];
  });
}

export const inboxQuery = z.object({
  /** Only the items of the factory with this slug. */
  factory: z.string().trim().min(1).max(200).optional(),
});

/** The open items that need you, of every factory or of the one with factoryId. */
export function readInbox(
  store: Store,
  filter: { factoryId?: number | null } = {},
): InboxDto {
  const slugs = new Map(
    store.repos.factories.factories().map((f) => [f.id, f.slug]),
  );
  const entries = store
    .items({ open: true, factoryId: filter.factoryId ?? undefined })
    .map((item) =>
      inboxEntry(
        item,
        store.runs(item.id),
        store.approvals(item.id),
        store.messages(item.id),
        slugs.get(item.factory_id),
      ),
    )
    .filter((entry) => entry !== null)
    .sort((a, b) => b.at.localeCompare(a.at) || b.itemId - a.itemId);
  const reach = pendingReach(store, filter.factoryId);
  const lessons = pendingLessons(store, filter.factoryId);
  const counts = {
    all: entries.length + reach.length + lessons.length,
    question: 0,
    spec: 0,
    pr: 0,
    failed: 0,
  };
  for (const entry of entries) counts[entry.kind]++;
  return { entries, reach, lessons, counts };
}

/** The sidebar badge: how many open items need you, without building the entries. */
export function inboxCount(store: Store): number {
  return (
    pendingReach(store, null).length +
    store.pendingLearnings().length +
    store
      .items({ open: true })
      .filter(
        (item) =>
          itemView(item, store.runs(item.id), store.approvals(item.id)).needsYou
            .kind !== "none",
      ).length
  );
}

export const approvalDecision = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    answer: z.string().trim().max(20_000).default(""),
  }),
  z.object({
    decision: z.literal("reject"),
    answer: z
      .string({ error: "Say what should change in the spec." })
      .trim()
      .min(1, "Say what should change in the spec.")
      .max(20_000),
  }),
  z.object({
    decision: z.literal("answer"),
    answer: z
      .string({ error: "Write an answer." })
      .trim()
      .min(1, "Write an answer.")
      .max(20_000),
  }),
]);
export type ApprovalDecision = z.infer<typeof approvalDecision>;

/** Approve a lesson, with the Operator's edited lines, or reject it with an optional reason. */
export const lessonDecision = z.discriminatedUnion("decision", [
  z.object({
    decision: z.literal("approve"),
    lines: z
      .array(z.string().max(LEARNING_MAX_CHARS * 2))
      .min(1)
      .max(LEARNING_MAX_LINES)
      .optional(),
  }),
  z.object({
    decision: z.literal("reject"),
    reason: z.string().trim().max(2_000).optional(),
  }),
]);
export type LessonDecision = z.infer<typeof lessonDecision>;
