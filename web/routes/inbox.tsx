import * as Dialog from "@radix-ui/react-dialog";
import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type {
  InboxEntryDto,
  InboxKind,
  InboxLessonDto,
  InboxReachDto,
  Tone,
} from "../../src/web/api.ts";
import {
  type ApprovalDecision,
  answerApproval,
  decideLesson,
  decideReach,
  inboxQuery,
} from "../lib/api";
import { EmptyState } from "../ui/empty-state";
import { FactoryFilter, FactoryTag, factorySearch } from "../app/factory";
import { Icon, type IconName } from "../ui/icons";
import { useToast } from "../app/toast";

const KINDS = ["question", "spec", "pr", "failed"] as const;
const KIND: Record<
  InboxKind,
  { label: string; pill: string; icon: IconName; tile: string; text: string }
> = {
  question: {
    label: "Question",
    pill: "Questions",
    icon: "message-circle-question",
    tile: "bg-accent-soft text-accent",
    text: "text-accent",
  },
  spec: {
    label: "Spec review",
    pill: "Spec reviews",
    icon: "file-check",
    tile: "bg-attention-soft text-attention",
    text: "text-attention",
  },
  pr: {
    label: "PR review",
    pill: "PR reviews",
    icon: "git-pull-request",
    tile: "bg-handoff-soft text-handoff",
    text: "text-handoff",
  },
  failed: {
    label: "Failed",
    pill: "Failed",
    icon: "circle-x",
    tile: "bg-bad-bg text-bad",
    text: "text-bad",
  },
};
const TONE_TEXT: Record<Tone, string> = {
  muted: "text-muted",
  accent: "text-accent",
  attention: "text-attention",
  building: "text-building",
  reviewing: "text-reviewing",
  handoff: "text-handoff",
  bad: "text-bad",
};
const DONE: Record<ApprovalDecision["decision"], string> = {
  approve: "Spec approved",
  reject: "Changes requested",
  answer: "Answer sent",
};

type Search = { kind?: InboxKind; item?: number; factory?: string };

export const Route = createFileRoute("/inbox")({
  staticData: { title: "Inbox" },
  // Unknown kinds or ids fall back to the whole list with no pane open.
  validateSearch: (raw: Record<string, unknown>): Search => ({
    kind: KINDS.find((kind) => kind === raw.kind),
    item:
      typeof raw.item === "number" && Number.isInteger(raw.item) && raw.item > 0
        ? raw.item
        : undefined,
    factory: factorySearch(raw.factory),
  }),
  loaderDeps: ({ search }) => ({ factory: search.factory }),
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(inboxQuery(deps.factory));
  },
  component: Inbox,
});

function age(iso: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function Inbox() {
  const { kind, item, factory } = Route.useSearch();
  const { data, isError } = useQuery({
    ...inboxQuery(factory),
    placeholderData: keepPreviousData,
  });
  const navigate = useNavigate({ from: Route.fullPath });
  const select = (id: number | undefined) =>
    void navigate({ search: (prev) => ({ ...prev, item: id }) });
  const entries = (data?.entries ?? []).filter(
    (entry) => !kind || entry.kind === kind,
  );
  // A pane only opens for a listed row, so a kind filter never hides its row.
  const current = entries.find((entry) => entry.itemId === item);

  return (
    <section className="grid gap-lg">
      <h1 className="text-heading font-bold">Inbox</h1>
      {data && (data.counts.all > 0 || factory) && (
        <div className="flex flex-wrap items-center gap-md">
          <fieldset className="flex flex-wrap gap-sm">
            <legend className="sr-only">Filter by kind</legend>
            {([undefined, ...KINDS] as const).map((value) => (
              <button
                key={value ?? "all"}
                type="button"
                className="kind-pill"
                aria-pressed={kind === value}
                onClick={() =>
                  navigate({ search: (prev) => ({ ...prev, kind: value }) })
                }
              >
                {value ? KIND[value].pill : "All"}{" "}
                <span className="tabular-nums">
                  {data.counts[value ?? "all"]}
                </span>
              </button>
            ))}
          </fieldset>
          <FactoryFilter
            value={factory}
            onChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  factory: value,
                  item: undefined,
                }),
              })
            }
          />
        </div>
      )}
      {!data ? (
        <p role="status" className="text-muted">
          {isError ? "Inbox unavailable. Retrying…" : "Loading the inbox…"}
        </p>
      ) : data.counts.all === 0 ? (
        <EmptyState
          icon="circle-check"
          title={
            factory ? "Nothing in this factory needs you" : "Nothing needs you"
          }
        >
          Spec approvals, questions and ready PRs will show up here and on
          Telegram.
        </EmptyState>
      ) : (
        <div className="grid gap-lg">
          {!kind && data.reach.length > 0 && (
            <ul className="grid gap-sm" aria-label="Wider reach">
              {data.reach.map((held) => (
                <li key={held.factory}>
                  <ReachRow held={held} />
                </li>
              ))}
            </ul>
          )}
          {!kind && data.lessons.length > 0 && (
            <ul className="grid gap-sm" aria-label="Lessons">
              {data.lessons.map((lesson) => (
                <li key={lesson.id}>
                  <LessonRow lesson={lesson} />
                </li>
              ))}
            </ul>
          )}
          <div className="inbox-layout">
            {entries.length === 0 ? (
              <p className="flex-1 text-muted">
                Nothing of this kind needs you.
              </p>
            ) : (
              <ul className="inbox-list" aria-label="Needs you">
                {entries.map((entry) => (
                  <li key={entry.itemId}>
                    <Row
                      entry={entry}
                      selected={entry.itemId === item}
                      onSelect={() => select(entry.itemId)}
                    />
                  </li>
                ))}
              </ul>
            )}
            <Dialog.Root
              open={Boolean(current)}
              modal={false}
              onOpenChange={(open) => {
                if (!open) select(undefined);
              }}
            >
              {current && (
                <Pane
                  key={current.itemId}
                  entry={current}
                  onDone={() => select(undefined)}
                />
              )}
            </Dialog.Root>
          </div>
        </div>
      )}
    </section>
  );
}

/** A reload that widens what agents can reach: the operator approves or rejects it here. */
function ReachRow({ held }: { held: InboxReachDto }) {
  const client = useQueryClient();
  const toast = useToast();
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideReach(held.factory, approve),
    onSuccess: (_, approve) => {
      for (const queryKey of [["inbox"], ["definition"], ["status"]])
        void client.invalidateQueries({ queryKey });
      toast({
        title: approve ? "Wider reach approved." : "Wider reach rejected.",
        description: held.factory,
        tone: "ok",
      });
    },
    onError: (error) =>
      toast({ title: error.message, description: held.factory, tone: "bad" }),
  });
  return (
    <section className="grid gap-sm rounded-control bg-surface-muted p-md">
      <h3 className="flex items-center gap-sm text-small font-semibold text-attention">
        <Icon name="circle-alert" className="h-md w-md" />
        Wider agent reach
        <FactoryTag slug={held.factory} />
      </h3>
      <p className="text-small text-muted">
        A reload adds this. The previous definition keeps running until you
        decide.
      </p>
      <ul className="grid gap-xs font-mono text-small">
        {held.added.map((line) => (
          <li key={line}>+ {line}</li>
        ))}
      </ul>
      <div className="grid grid-cols-2 gap-sm">
        <button
          type="button"
          className="primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="ghost"
          disabled={decide.isPending}
          onClick={() => decide.mutate(false)}
        >
          Reject
        </button>
      </div>
    </section>
  );
}

/** A lesson a reflect run proposed: approving writes it to the factory's learnings skill. */
function LessonRow({ lesson }: { lesson: InboxLessonDto }) {
  const client = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState(lesson.lines.join("\n"));
  const [reason, setReason] = useState("");
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      decideLesson(
        lesson.id,
        approve
          ? {
              decision: "approve",
              lines: text
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
            }
          : { decision: "reject", reason: reason.trim() || undefined },
      ),
    onSuccess: (_, approve) => {
      for (const queryKey of [["inbox"], ["definition"], ["status"]])
        void client.invalidateQueries({ queryKey });
      toast({
        title: approve ? "Lesson approved." : "Lesson rejected.",
        description: lesson.factory,
        tone: "ok",
      });
    },
    onError: (error) =>
      toast({ title: error.message, description: lesson.factory, tone: "bad" }),
  });
  const id = `lesson-${lesson.id}`;
  return (
    <section
      className="grid gap-sm rounded-control bg-surface-muted p-md"
      aria-labelledby={`${id}-title`}
    >
      <h3
        id={`${id}-title`}
        className="flex items-center gap-sm text-small font-semibold text-accent"
      >
        <Icon name="sparkles" className="h-md w-md" />
        Proposed lesson
        <FactoryTag slug={lesson.factory} />
      </h3>
      <p className="text-small text-muted">
        From{" "}
        <Link to="/items/$itemId" params={{ itemId: String(lesson.itemId) }}>
          {lesson.itemTitle}
        </Link>
        . Mistake: {lesson.mistake}
      </p>
      {lesson.suggestCheck && (
        <p className="text-small text-attention">
          A lint rule, type or test could make this mistake impossible. Consider
          adding one instead.
        </p>
      )}
      <label className="text-small" htmlFor={`${id}-lines`}>
        Lines for every agent of this factory (one per line, at most 3)
      </label>
      <textarea
        id={`${id}-lines`}
        className="input font-mono"
        rows={3}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <label className="sr-only" htmlFor={`${id}-reason`}>
        Reason to reject
      </label>
      <input
        id={`${id}-reason`}
        className="input"
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        placeholder="Why not? (only for Reject)"
      />
      <div className="grid grid-cols-2 gap-sm">
        <button
          type="button"
          className="primary"
          disabled={decide.isPending}
          onClick={() => decide.mutate(true)}
        >
          Approve
        </button>
        <button
          type="button"
          className="ghost"
          disabled={decide.isPending}
          onClick={() => decide.mutate(false)}
        >
          Reject
        </button>
      </div>
    </section>
  );
}

function Row({
  entry,
  selected,
  onSelect,
}: {
  entry: InboxEntryDto;
  selected: boolean;
  onSelect: () => void;
}) {
  const look = KIND[entry.kind];
  return (
    <button
      type="button"
      id={`inbox-${entry.itemId}`}
      className="inbox-row"
      aria-expanded={selected}
      onClick={onSelect}
    >
      <span
        className={`flex h-tile w-tile shrink-0 items-center justify-center rounded-control ${look.tile}`}
      >
        <Icon name={look.icon} className="h-lg w-lg" />
      </span>
      <span className="inbox-row-text">
        <span className="inbox-row-line">
          <span className={`shrink-0 text-small font-semibold ${look.text}`}>
            {entry.kind === "failed" ? entry.label : look.label}
          </span>
          <span className="shrink-0 text-small text-muted">
            #{entry.itemId}
          </span>
          <FactoryTag slug={entry.factory} />
          <span className="inbox-row-title">{entry.title}</span>
          <time
            className="shrink-0 text-small text-muted"
            dateTime={entry.at}
            title={entry.at}
          >
            {age(entry.at)}
          </time>
        </span>
        <span className="truncate text-small text-muted">
          {entry.summary.split("\n", 1)[0]}
        </span>
      </span>
    </button>
  );
}

function Pane({ entry, onDone }: { entry: InboxEntryDto; onDone: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [answer, setAnswer] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const look = KIND[entry.kind];
  const item = {
    to: "/items/$itemId",
    params: { itemId: String(entry.itemId) },
  } as const;
  const decide = useMutation({
    mutationFn: (decision: ApprovalDecision) => {
      // biome-ignore lint/style/noNonNullAssertion: The actions are only rendered for entries with an approval.
      return answerApproval(entry.approval!.id, decision);
    },
    onSuccess: (_, decision) => {
      for (const queryKey of [["inbox"], ["items"], ["status"]])
        void client.invalidateQueries({ queryKey });
      toast({
        title: `${DONE[decision.decision]} on #${entry.itemId}.`,
        description: entry.title,
        tone: "ok",
      });
      onDone();
    },
    onError: (error) => setProblem(error.message),
  });
  const send = (decision: ApprovalDecision["decision"]) => {
    setProblem(null);
    const text = answer.trim();
    if (decision === "reject" && !text)
      return setProblem("Say what should change in the spec.");
    if (decision === "answer" && !text) return setProblem("Write an answer.");
    decide.mutate({ decision, answer: text });
  };
  const box = (heading: string, body: string, link?: [string, string]) => (
    <section className="grid gap-sm rounded-control bg-surface-muted p-md">
      <h3 className="text-small font-semibold text-muted">{heading}</h3>
      <p className="whitespace-pre-wrap">{body}</p>
      {link && (
        <a className="text-small font-medium text-accent" href={link[0]}>
          {link[1]} →
        </a>
      )}
    </section>
  );

  return (
    <Dialog.Content
      className="inbox-pane"
      aria-describedby={undefined}
      onInteractOutside={(event) => event.preventDefault()}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        document.getElementById(`inbox-${entry.itemId}`)?.focus();
      }}
    >
      <div className="flex items-center justify-between gap-md">
        <span className={`chip font-semibold ${look.tile}`}>
          <Icon name={look.icon} className="h-md w-md" />
          {entry.kind === "failed" ? entry.label : look.label}
        </span>
        <span className="flex items-center gap-sm">
          <Link className="icon-button" {...item} aria-label="Open work item">
            <Icon name="external-link" className="h-lg w-lg" />
          </Link>
          <Dialog.Close className="icon-button" aria-label="Close">
            <Icon name="x" className="h-lg w-lg" />
          </Dialog.Close>
        </span>
      </div>
      <Dialog.Title className="text-title font-bold">
        #{entry.itemId} {entry.title}
      </Dialog.Title>
      <div className="flex flex-wrap gap-sm">
        {entry.chips.map((chip) =>
          chip.url ? (
            <a
              key={chip.kind}
              className="chip border border-line hover:underline"
              href={chip.url}
            >
              <Icon name={chip.icon} className="h-md w-md text-muted" />
              {chip.label}
            </a>
          ) : (
            <span key={chip.kind} className="chip border border-line">
              <Icon name={chip.icon} className="h-md w-md text-muted" />
              {chip.label}
            </span>
          ),
        )}
        <span className="chip border border-line">
          <Icon name="coins" className="h-md w-md text-muted" />$
          {entry.costUsd.toFixed(2)}
        </span>
      </div>
      {entry.kind === "spec" &&
        box(
          "Spec summary",
          entry.summary,
          entry.approval?.refUrl
            ? [entry.approval.refUrl, "Open the spec on GitHub"]
            : undefined,
        )}
      {entry.kind === "question" && box("Question", entry.summary)}
      {entry.kind === "pr" &&
        box(
          "Pull request",
          entry.summary,
          entry.prUrl ? [entry.prUrl, "Open the PR on GitHub"] : undefined,
        )}
      {entry.kind === "failed" && box(entry.label, entry.summary)}
      {entry.recent.length > 0 && (
        <section className="grid gap-sm">
          <h3 className="text-small font-semibold text-muted">
            Recent on this item
          </h3>
          <ul className="grid gap-sm">
            {entry.recent.map((event, index) => (
              <li
                // Events have no id; their order is stable for one entry.
                // biome-ignore lint/suspicious/noArrayIndexKey: See above.
                key={index}
                className="flex items-start gap-sm text-small"
              >
                <Icon
                  name={event.icon}
                  className={`mt-xs h-md w-md shrink-0 ${TONE_TEXT[event.tone]}`}
                />
                <span className="flex-1">{event.text}</span>
                <time className="text-muted" dateTime={event.at}>
                  {age(event.at)}
                </time>
              </li>
            ))}
          </ul>
        </section>
      )}
      {entry.approval && (
        <form
          className="grid gap-sm"
          onSubmit={(event) => {
            event.preventDefault();
            send(entry.kind === "spec" ? "approve" : "answer");
          }}
        >
          {entry.kind === "question" && entry.approval.options.length > 0 && (
            <fieldset className="flex flex-wrap gap-sm">
              <legend className="sr-only">Suggested answers</legend>
              {entry.approval.options.map((option) => (
                <button
                  key={option}
                  type="button"
                  className="kind-pill"
                  aria-pressed={answer === option}
                  onClick={() => {
                    setProblem(null);
                    setAnswer(option);
                  }}
                >
                  {option}
                </button>
              ))}
            </fieldset>
          )}
          <label className="sr-only" htmlFor="inbox-answer">
            {entry.kind === "spec" ? "Feedback" : "Answer"}
          </label>
          <textarea
            id="inbox-answer"
            className="input"
            rows={3}
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={
              entry.kind === "spec"
                ? "What should change? (only needed for Request changes)"
                : "Type an answer…"
            }
          />
          {problem && (
            <p className="form-error" role="alert">
              {problem}
            </p>
          )}
          {entry.kind === "spec" ? (
            <div className="grid grid-cols-2 gap-sm">
              <button
                type="submit"
                className="primary flex items-center justify-center gap-xs"
                disabled={decide.isPending}
              >
                <Icon name="check" className="h-md w-md" />
                Approve spec
              </button>
              <button
                type="button"
                className="ghost"
                disabled={decide.isPending}
                onClick={() => send("reject")}
              >
                Request changes
              </button>
            </div>
          ) : (
            <button
              type="submit"
              className="primary"
              disabled={decide.isPending}
            >
              Send answer
            </button>
          )}
        </form>
      )}
      <Link className="text-small font-medium text-accent" {...item}>
        View work item →
      </Link>
    </Dialog.Content>
  );
}
