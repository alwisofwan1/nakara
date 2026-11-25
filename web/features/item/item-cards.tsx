import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import type {
  ActionCardDto,
  ItemDetailDto,
  Tone,
} from "../../../src/web/api.ts";
import {
  answerApproval,
  cancelItem,
  pullRequestQuery,
  raiseBudget,
  raiseRunLimit,
  retryItem,
  runQuery,
  sendItemMessage,
} from "../../lib/api";
import { formatDuration, relativeTime, runDuration } from "../../lib/format";
import { Icon, type IconName } from "../../ui/icons";
import { NewWorkDialog } from "../new-work/newWork";
import { useRunLog } from "../run/run-log";
import { StopRunButton } from "../run/stop-run";
import { TONE } from "../../ui/tone";

// The action card at the bottom of a work item's conversation, one per state,
// and the pieces the work item page shares with it.

export type Item = ItemDetailDto;
type Card<K extends ActionCardDto["kind"]> = Extract<
  ActionCardDto,
  { kind: K }
>;
type RunStatus = Item["runs"][number]["status"];

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  queued: { label: "Queued", tone: "muted" },
  running: { label: "Running", tone: "building" },
  succeeded: { label: "Succeeded", tone: "handoff" },
  failed: { label: "Failed", tone: "bad" },
  cancelled: { label: "Cancelled", tone: "muted" },
  interrupted: { label: "Interrupted", tone: "muted" },
};

const REVIEW_OUTCOME: Record<
  NonNullable<Card<"complete">["reviewOutcome"]>,
  string
> = {
  accepted: "passed",
  revision_needed: "revision needed",
  human_decision: "human decision needed",
};

/** Re-render on an interval for relative times and live durations. */
export function useNow(intervalMs: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export const money = (usd: number) => `$${usd.toFixed(2)}`;

/** Plain text with its URLs turned into links. */
export function Linkified({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/[^\s<>]+)/g);
  return (
    <>
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <a
            // biome-ignore lint/suspicious/noArrayIndexKey: Static text segments.
            key={index}
            href={part}
            className="text-accent hover:underline"
          >
            {part}
          </a>
        ) : (
          part
        ),
      )}
    </>
  );
}

export function Tile({ icon, tone }: { icon: IconName; tone: Tone }) {
  return (
    <span
      className={`flex h-tile w-tile shrink-0 items-center justify-center rounded-control ${TONE[tone]}`}
    >
      <Icon name={icon} className="h-md w-md" />
    </span>
  );
}

function CardShell({
  icon,
  tone,
  title,
  subtitle,
  children,
  label,
}: {
  icon: IconName;
  tone: Tone;
  title: ReactNode;
  subtitle?: ReactNode;
  children?: ReactNode;
  label: string;
}) {
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-md rounded-control border border-line bg-bg p-lg"
    >
      <div className="flex items-center gap-md">
        <Tile icon={icon} tone={tone} />
        <div className="min-w-0">
          <h2 className="font-semibold">{title}</h2>
          {subtitle && <p className="text-tiny text-muted">{subtitle}</p>}
        </div>
      </div>
      {children}
    </section>
  );
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap gap-sm">{children}</div>;
}

export function ActionCard({ item, now }: { item: Item; now: number }) {
  const card = item.card;
  switch (card.kind) {
    case "question":
      return <QuestionCard card={card} now={now} />;
    case "spec":
      return <SpecCard card={card} />;
    case "live":
      return <LiveCard card={card} />;
    case "pr":
      return <PrCard item={item} card={card} />;
    case "failed":
      return <FailedCard item={item} card={card} />;
    case "complete":
      return (
        <CardShell
          label="Action"
          icon="circle-check"
          tone="muted"
          title={card.merged ? "Merged and completed" : "Completed"}
          subtitle={[
            card.prLabel && `${card.prLabel}${card.merged ? " merged" : ""}`,
            `${formatDuration(card.durationMs)} total`,
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <dl className="flex flex-wrap gap-xxl">
            <Stat label="Cost" value={money(card.costUsd)} />
            <Stat label="Runs" value={String(card.runs)} />
            <Stat label="Revisions" value={String(card.revisions)} />
            <Stat
              label="Review"
              value={[
                card.reviews === 0
                  ? "none"
                  : `${card.reviews} round${card.reviews === 1 ? "" : "s"}`,
                card.reviewOutcome &&
                  `${REVIEW_OUTCOME[card.reviewOutcome]}${card.revised ? " → revised" : ""}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            />
          </dl>
        </CardShell>
      );
    case "cancelled":
      return (
        <CardShell
          label="Action"
          icon="ban"
          tone="muted"
          title="Cancelled"
          subtitle={`${relativeTime(card.at, now)} · running runs were stopped`}
        >
          <p className="text-small">
            Cancelling is final for this item. Duplicate it as new work to try
            again with the same request.
          </p>
          <Actions>
            <DuplicateButton item={item} />
          </Actions>
        </CardShell>
      );
    case "none":
      return null;
  }
}

/** Opens the New work modal with the item's title, request, repo and automation. */
function DuplicateButton({ item }: { item: Item }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="primary flex items-center gap-xs"
        onClick={() => setOpen(true)}
      >
        <Icon name="copy" className="h-md w-md" />
        Duplicate as new work
      </button>
      <NewWorkDialog
        slug={item.factory}
        open={open}
        onOpenChange={setOpen}
        prefill={{
          title: item.title,
          request: item.request,
          repo: item.details.repo,
          automation: item.details.automation,
        }}
      />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-tiny text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}

export function FormError({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="form-error">
      {error.message}
    </p>
  ) : null;
}

/** Invalidate the item after an action; SSE then keeps it current. */
export function useItemMutation<T>(fn: (value: T) => Promise<unknown>) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => void client.invalidateQueries({ queryKey: ["items"] }),
  });
}

function QuestionCard({ card, now }: { card: Card<"question">; now: number }) {
  const [answer, setAnswer] = useState("");
  const mutation = useItemMutation((text: string) =>
    answerApproval(card.approvalId, { decision: "answer", answer: text }),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (answer.trim()) mutation.mutate(answer.trim());
  };
  return (
    <CardShell
      label="Action"
      icon="message-circle"
      tone="attention"
      title="Foreman asks"
      subtitle={`${relativeTime(card.askedAt, now)} · blocks the work`}
    >
      <p className="whitespace-pre-wrap">
        <Linkified text={card.prompt} />
      </p>
      <form onSubmit={submit} className="flex flex-col gap-sm">
        <label className="sr-only" htmlFor="answer">
          Answer
        </label>
        <textarea
          id="answer"
          rows={3}
          className="input"
          placeholder="Type an answer…"
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
        />
        <FormError error={mutation.error} />
        <Actions>
          <button
            type="submit"
            className="primary flex items-center gap-xs"
            disabled={!answer.trim() || mutation.isPending}
          >
            <Icon name="send" className="h-md w-md" />
            Send answer
          </button>
        </Actions>
      </form>
    </CardShell>
  );
}

function SpecCard({ card }: { card: Card<"spec"> }) {
  const [changes, setChanges] = useState<string | null>(null);
  const mutation = useItemMutation(
    (decision: { decision: "approve" | "reject"; answer: string }) =>
      answerApproval(card.approvalId, decision),
  );
  const ref = card.refLabel ?? "the spec";
  return (
    <section
      aria-label="Action"
      className="flex flex-col gap-md rounded-control border border-attention bg-attention-soft p-lg"
    >
      <h2 className="flex items-center gap-sm font-semibold text-attention">
        <Icon name="circle-alert" className="h-lg w-lg" />
        Waiting for you: approve{" "}
        {card.refUrl ? (
          <a href={card.refUrl} className="underline">
            {ref}
          </a>
        ) : (
          ref
        )}
      </h2>
      <p className="text-small whitespace-pre-wrap">
        <Linkified text={card.prompt} />
      </p>
      {changes !== null && (
        <>
          <label className="sr-only" htmlFor="spec-changes">
            What should change
          </label>
          <textarea
            id="spec-changes"
            rows={3}
            className="input"
            placeholder="Say what should change in the spec"
            value={changes}
            onChange={(event) => setChanges(event.target.value)}
          />
        </>
      )}
      <FormError error={mutation.error} />
      <Actions>
        {changes === null ? (
          <>
            <button
              type="button"
              className="primary"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate({ decision: "approve", answer: "" })
              }
            >
              Approve spec
            </button>
            <button
              type="button"
              className="ghost bg-bg"
              onClick={() => setChanges("")}
            >
              Request changes
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="primary"
              disabled={!changes.trim() || mutation.isPending}
              onClick={() =>
                mutation.mutate({ decision: "reject", answer: changes.trim() })
              }
            >
              Send changes
            </button>
            <button
              type="button"
              className="ghost bg-bg"
              onClick={() => setChanges(null)}
            >
              Back
            </button>
          </>
        )}
      </Actions>
    </section>
  );
}

function LiveCard({ card }: { card: Card<"live"> }) {
  const { run } = card;
  const now = useNow(1000);
  const log = useRunLog(run.id);
  // Only the dialog's wording depends on the runner; the run page query has it.
  const docker = useQuery(runQuery(run.id)).data?.docker ?? false;
  const tail = log.entries.slice(-6);
  const elapsed = runDuration(
    { status: run.status, startedAt: run.startedAt, durationMs: null },
    now,
  );
  return (
    <CardShell
      label="Action"
      icon={run.icon}
      tone={run.tone}
      title={run.title}
      subtitle={
        run.status === "queued"
          ? "Queued for a free slot"
          : `Running ${elapsed === null ? "" : formatDuration(elapsed)}`
      }
    >
      <div
        role="log"
        aria-label="Live log"
        className="flex flex-col gap-xs rounded-control bg-log-bg p-md font-mono text-tiny text-log-text"
      >
        {tail.length === 0 ? (
          <p className="text-log-muted">Waiting for output…</p>
        ) : (
          tail.map((entry) => (
            <p key={entry.id} className="truncate">
              {entry.text}
            </p>
          ))
        )}
      </div>
      <p className="text-tiny text-muted">
        Streaming from run #{run.id}
        {log.ended ? " · run ended" : ""}
      </p>
      <Actions>
        <Link
          to="/runs/$runId"
          params={{ runId: String(run.id) }}
          className="ghost flex items-center gap-xs"
        >
          <Icon name="square-arrow-out-up-right" className="h-md w-md" />
          Open run
        </Link>
        <StopRunButton run={{ id: run.id, status: run.status, docker }} />
      </Actions>
    </CardShell>
  );
}

const CHECKS_LABEL = {
  passing: "checks passing",
  failing: "checks failing",
  pending: "checks pending",
  none: "no checks",
} as const;

function PrCard({ item, card }: { item: Item; card: Card<"pr"> }) {
  const { data: pr, error } = useQuery(pullRequestQuery(item.id));
  return (
    <CardShell
      label="Action"
      icon="git-pull-request"
      tone="handoff"
      title={`${card.prLabel} ready for review`}
      subtitle={`${card.reviews.used} of ${card.reviews.max} reviews · ${card.revisions.used} of ${card.revisions.max} revisions`}
    >
      <div className="flex flex-col gap-xs rounded-control bg-surface-muted px-lg py-md">
        {pr ? (
          <>
            <p className="font-semibold">{pr.title}</p>
            <p className="text-tiny text-muted">
              {pr.repo} · {pr.head} → {pr.base} ·{" "}
              <span className="text-handoff">+{pr.additions}</span>{" "}
              <span className="text-bad">−{pr.deletions}</span> ·{" "}
              {CHECKS_LABEL[pr.checks]} on{" "}
              <span className="font-mono" title={pr.headSha}>
                {pr.headSha.slice(0, 7)}
              </span>
            </p>
          </>
        ) : (
          <p className="text-small text-muted">
            {error ? error.message : "Loading the pull request…"}
          </p>
        )}
      </div>
      <p className="text-small">
        Nothing in the factory merges. Merge on GitHub; the merge wakes the
        foreman, which completes the item.
      </p>
      <Actions>
        <a href={card.prUrl} className="primary flex items-center gap-xs">
          <Icon name="github" className="h-md w-md" />
          Open PR on GitHub
        </a>
        <RequestChanges itemId={item.id} prLabel={card.prLabel} />
      </Actions>
    </CardShell>
  );
}

function RequestChanges({
  itemId,
  prLabel,
}: {
  itemId: number;
  prLabel: string;
}) {
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const mutation = useItemMutation((text: string) =>
    sendItemMessage(itemId, `Changes requested on ${prLabel}:\n\n${text}`),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!feedback.trim()) return;
    mutation.mutate(feedback.trim(), {
      onSuccess: () => {
        setFeedback("");
        setOpen(false);
      },
    });
  };
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger className="ghost flex items-center gap-xs">
        <Icon name="message-square" className="h-md w-md" />
        Request changes
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal" aria-describedby={undefined}>
          <form onSubmit={submit}>
            <div className="modal-head">
              <Dialog.Title className="font-semibold">
                Request changes on {prLabel}
              </Dialog.Title>
              <Dialog.Close className="icon-button" aria-label="Close">
                <Icon name="x" className="h-lg w-lg" />
              </Dialog.Close>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">
                  Feedback
                  <span className="field-hint">sent to the foreman</span>
                </span>
                <textarea
                  rows={5}
                  className="input"
                  value={feedback}
                  onChange={(event) => setFeedback(event.target.value)}
                  placeholder="Rename the flag and add a test for…"
                />
              </label>
              <FormError error={mutation.error} />
            </div>
            <div className="modal-foot">
              <Dialog.Close className="ghost">Cancel</Dialog.Close>
              <button
                type="submit"
                className="primary"
                disabled={!feedback.trim() || mutation.isPending}
              >
                Send feedback
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function FailedCard({ item, card }: { item: Item; card: Card<"failed"> }) {
  const { budget, runLimit } = item;
  const retry = useItemMutation(() => retryItem(item.id));
  const raise = useItemMutation(() => raiseBudget(item.id));
  const raiseRuns = useItemMutation(() => raiseRunLimit(item.id));
  const busy = retry.isPending || raise.isPending || raiseRuns.isPending;
  const held = budget.exhausted
    ? "Raise the budget first"
    : runLimit.exhausted
      ? "Raise the run limit first"
      : undefined;
  return (
    <CardShell
      label="Action"
      icon="circle-alert"
      tone="bad"
      title={card.reason}
      subtitle={[
        `${money(budget.usedUsd)} of ${money(budget.limitUsd)}`,
        `${runLimit.used} of ${runLimit.max} runs`,
        card.lastRun && `last run ${card.lastRun.agent} failed`,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <BudgetBar ratio={budget.ratio} exhausted={budget.exhausted} />
      {card.detail && (
        <p className="text-small whitespace-pre-wrap">
          <Linkified text={card.detail} />
        </p>
      )}
      <FormError error={retry.error ?? raise.error ?? raiseRuns.error} />
      <Actions>
        {card.lastRun && (
          <button
            type="button"
            className="primary flex items-center gap-xs"
            disabled={busy || Boolean(held)}
            title={held}
            onClick={() => {
              raise.reset();
              raiseRuns.reset();
              retry.mutate(undefined);
            }}
          >
            <Icon name="rotate-ccw" className="h-md w-md" />
            Retry
          </button>
        )}
        <button
          type="button"
          className="ghost flex items-center gap-xs"
          disabled={busy}
          onClick={() => {
            retry.reset();
            raiseRuns.reset();
            raise.mutate(undefined);
          }}
        >
          <Icon name="plus" className="h-md w-md" />
          Raise budget +$10
        </button>
        {runLimit.exhausted && (
          <button
            type="button"
            className="ghost flex items-center gap-xs"
            disabled={busy}
            onClick={() => {
              retry.reset();
              raise.reset();
              raiseRuns.mutate(undefined);
            }}
          >
            <Icon name="plus" className="h-md w-md" />
            Raise run limit +10
          </button>
        )}
        <CancelButton item={item} label="Cancel item" />
      </Actions>
    </CardShell>
  );
}

export function CancelButton({
  item,
  label = "Cancel",
}: {
  item: Item;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const mutation = useItemMutation(() => cancelItem(item.id));
  const pr = item.details.pr ?? item.details.specPr;
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger
        className={`ghost flex items-center gap-xs ${label === "Cancel" ? "" : "text-bad"}`}
      >
        <Icon
          name={label === "Cancel" ? "circle-stop" : "x"}
          className="h-md w-md"
        />
        {label}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="modal">
          <div className="modal-head">
            <Dialog.Title className="font-semibold">
              Cancel #{item.id}?
            </Dialog.Title>
          </div>
          <div className="modal-body">
            <Dialog.Description>
              Running agents are stopped and queued runs are dropped. Cancelling
              is final: the item cannot resume.
            </Dialog.Description>
            <dl className="flex flex-col gap-xs text-small">
              <div>
                <dt className="inline font-semibold">Kept: </dt>
                <dd className="inline">
                  the branch and {pr ? pr.label : "any draft PR"} stay on{" "}
                  GitHub. Nothing is closed or deleted there.
                </dd>
              </div>
              <div>
                <dt className="inline font-semibold">Removed: </dt>
                <dd className="inline">
                  the item's local worktree. Uncommitted changes in it are lost.
                </dd>
              </div>
            </dl>
            <FormError error={mutation.error} />
          </div>
          <div className="modal-foot">
            <Dialog.Close className="ghost">Keep working</Dialog.Close>
            <button
              type="button"
              className="primary bg-bad"
              disabled={mutation.isPending}
              onClick={() =>
                mutation.mutate(undefined, { onSuccess: () => setOpen(false) })
              }
            >
              Cancel work item
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function BudgetBar({
  ratio,
  exhausted,
}: {
  ratio: number;
  exhausted: boolean;
}) {
  return (
    <div
      // The amounts are written next to the bar.
      aria-hidden="true"
      data-ratio={ratio}
      className="h-xs overflow-hidden rounded-control bg-line"
    >
      <div
        className={`h-full ${exhausted ? "bg-bad" : "bg-accent"}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  );
}
