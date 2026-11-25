import { useSuspenseQuery } from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import type { ConversationEntryDto } from "../../src/web/api.ts";
import { itemQuery, loadPage, sendItemMessage } from "../lib/api";
import { formatDuration, relativeTime, runDuration } from "../lib/format";
import { Icon } from "../ui/icons";
import {
  ActionCard,
  BudgetBar,
  CancelButton,
  FormError,
  type Item,
  Linkified,
  money,
  RUN_STATUS,
  Tile,
  useItemMutation,
  useNow,
} from "../features/item/item-cards";
import { defaultFactory } from "../app/runtime";
import { usePageCrumbs } from "../app/shell";
import { TONE, TONE_FILL, TONE_TEXT } from "../ui/tone";

export const Route = createFileRoute("/items/$itemId")({
  loader: ({ context, params }) => {
    const id = Number(params.itemId);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    return loadPage(context.queryClient, itemQuery(id));
  },
  component: ItemPage,
});

const initials = (name: string) =>
  name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "?";

function ItemPage() {
  const id = Number(Route.useParams().itemId);
  const { data: item } = useSuspenseQuery(itemQuery(id));
  usePageCrumbs(
    [
      {
        label: "Activity",
        href: `/f/${item.factory || defaultFactory.slug}/activity`,
      },
      { label: `#${id}` },
    ],
    item.factory,
  );
  return <ItemView key={item.id} item={item} />;
}

function ItemView({ item }: { item: Item }) {
  // Relative times only change by the minute; live durations tick on their own.
  const now = useNow(30_000);
  return (
    <div className="flex flex-col gap-xl">
      <header className="flex flex-col gap-lg">
        <div className="flex flex-wrap items-start gap-md">
          <h1 className="min-w-0 grow basis-title text-heading font-bold">
            <span className="text-muted">#{item.id}</span> {item.title}
          </h1>
          <div className="flex flex-wrap gap-sm">
            {(
              [
                ["github", item.details.issue],
                ["file-text", item.details.specPr],
                ["git-pull-request", item.details.pr],
              ] as const
            ).map(
              ([icon, link]) =>
                link && (
                  <a
                    key={link.url}
                    href={link.url}
                    className="ghost flex items-center gap-xs"
                  >
                    <Icon name={icon} className="h-md w-md text-muted" />
                    {link.label}
                  </a>
                ),
            )}
            {!item.closed && <CancelButton item={item} />}
          </div>
        </div>
        <StageProgress steps={item.progress} />
      </header>
      <div className="item-body">
        <section
          className="flex min-w-0 flex-col gap-lg"
          aria-label="Conversation"
        >
          {item.conversation.map((entry) => (
            <Entry key={`${entry.kind}:${entry.id}`} entry={entry} now={now} />
          ))}
          <ActionCard item={item} now={now} />
          {!item.closed && <Composer itemId={item.id} />}
        </section>
        <Properties item={item} now={now} />
      </div>
    </div>
  );
}

function StageProgress({ steps }: { steps: Item["progress"] }) {
  return (
    <ol className="stage-progress" aria-label="Stage progress">
      {steps.map((step) => (
        <li
          key={step.key}
          aria-current={step.state === "current" ? "step" : undefined}
          className="flex min-w-0 flex-col gap-xs"
        >
          <span
            className={`h-xs rounded-control ${
              step.state === "done"
                ? "bg-text"
                : step.state === "current"
                  ? TONE_FILL[step.tone]
                  : "bg-line"
            }`}
          />
          <span
            className={`text-tiny ${
              step.state === "done"
                ? "text-text"
                : step.state === "current"
                  ? `font-semibold ${TONE_TEXT[step.tone]}`
                  : "text-muted"
            }`}
          >
            {step.label}
            {step.state === "skipped" && (
              <span className="sr-only"> (skipped)</span>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Entry({ entry, now }: { entry: ConversationEntryDto; now: number }) {
  switch (entry.kind) {
    case "message":
      return (
        <article className="flex gap-md">
          {entry.author === "factory" ? (
            <Tile icon="sparkles" tone="accent" />
          ) : (
            <span className="flex h-tile w-tile shrink-0 items-center justify-center rounded-chip bg-nav-active text-tiny font-semibold">
              {initials(entry.name)}
            </span>
          )}
          <div className="flex min-w-0 flex-col gap-xs">
            <p className="flex items-baseline gap-sm">
              <span className="text-small font-semibold">{entry.name}</span>
              <time
                className="text-tiny text-muted"
                dateTime={entry.at}
                title={entry.at}
              >
                {relativeTime(entry.at, now)}
              </time>
            </p>
            <p className="whitespace-pre-wrap">
              <Linkified text={entry.body} />
            </p>
          </div>
        </article>
      );
    case "run": {
      const status = RUN_STATUS[entry.status];
      return (
        <article className="flex flex-wrap items-center gap-md rounded-control border border-line px-lg py-md">
          <Tile icon={entry.icon} tone={entry.tone} />
          <div className="min-w-0 grow basis-title">
            <h2 className="font-semibold">{entry.title}</h2>
            {entry.summary && (
              <p className="text-small text-muted">{entry.summary}</p>
            )}
          </div>
          <span className={`chip text-tiny font-medium ${TONE[status.tone]}`}>
            {status.label}
          </span>
          <span className="text-tiny text-muted tabular-nums">
            {money(entry.costUsd)}
          </span>
          <Link
            to="/runs/$runId"
            params={{ runId: String(entry.id) }}
            className="text-tiny text-accent hover:underline"
          >
            View log →
          </Link>
        </article>
      );
    }
    case "approval": {
      const spec = entry.approval === "spec";
      const ref = entry.refLabel ? `spec ${entry.refLabel}` : "the spec";
      const text = !spec
        ? "Question answered"
        : entry.status === "approved"
          ? `Approved ${ref}`
          : `Requested changes to ${ref}`;
      return (
        <article className="flex items-center gap-md rounded-control bg-surface-muted px-lg py-sm text-small">
          <Icon
            name={entry.status === "rejected" ? "message-square" : "check"}
            className="h-md w-md text-muted"
          />
          {entry.refUrl ? (
            <a href={entry.refUrl} className="hover:underline">
              {text}
            </a>
          ) : (
            text
          )}
        </article>
      );
    }
  }
}

function Composer({ itemId }: { itemId: number }) {
  const [message, setMessage] = useState("");
  const mutation = useItemMutation((text: string) =>
    sendItemMessage(itemId, text),
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!message.trim()) return;
    mutation.mutate(message.trim(), { onSuccess: () => setMessage("") });
  };
  return (
    <form
      onSubmit={submit}
      className="flex flex-col gap-sm rounded-control border border-line p-md focus-within:border-accent"
    >
      <label className="sr-only" htmlFor="composer">
        Message the factory
      </label>
      <div className="flex items-end gap-sm">
        <textarea
          id="composer"
          rows={2}
          className="min-w-0 grow resize-y bg-bg text-body outline-none"
          placeholder="Message the factory…"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey))
              submit(event);
          }}
        />
        <button
          type="submit"
          className="primary"
          disabled={!message.trim() || mutation.isPending}
        >
          Send
        </button>
      </div>
      <FormError error={mutation.error} />
    </form>
  );
}

function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-md text-small">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-right">{children}</dd>
    </div>
  );
}

function Properties({ item, now: page }: { item: Item; now: number }) {
  const running = item.runs.some((run) => run.status === "running");
  const ticking = useNow(running ? 1000 : 60_000);
  const now = Math.max(page, ticking);
  const { details, budget, counters } = item;
  const links = [
    { label: "Issue", link: details.issue },
    { label: "Spec", link: details.specPr },
    {
      label: "Pull request",
      link: details.pr && {
        ...details.pr,
        label: `${details.pr.label}${details.pr.merged ? " (merged)" : ""}`,
      },
    },
  ];
  return (
    <aside className="item-properties" aria-label="Properties">
      <section className="flex flex-col gap-sm">
        <h2 className="pane-heading">Details</h2>
        <dl className="flex flex-col gap-sm">
          <Prop label="Status">
            <span className={TONE_TEXT[item.status.tone]}>
              {item.status.label}
            </span>
          </Prop>
          <Prop label="Source">{details.source}</Prop>
          <Prop label="Repository">{details.repo ?? "—"}</Prop>
          <Prop label="Automation">{details.automation ?? "—"}</Prop>
          <Prop label="Requester">{details.requester ?? "—"}</Prop>
          {item.requestEdited && (
            <Prop label="Request">
              <span className={TONE_TEXT.attention}>
                Changed after labelling
              </span>
            </Prop>
          )}
          <Prop label="Created">
            <time dateTime={details.createdAt} title={details.createdAt}>
              {relativeTime(details.createdAt, now)}
            </time>
          </Prop>
          {links.map(
            ({ label, link }) =>
              link && (
                <Prop key={label} label={label}>
                  <a href={link.url} className="text-accent hover:underline">
                    {link.label}
                  </a>
                </Prop>
              ),
          )}
        </dl>
      </section>
      <section className="flex flex-col gap-sm">
        <h2 className="pane-heading">Budget</h2>
        <p className="flex justify-between text-small">
          <span>
            {money(budget.usedUsd)} of {money(budget.limitUsd)}
          </span>
          <span className="text-muted">{Math.round(budget.ratio * 100)}%</span>
        </p>
        <BudgetBar ratio={budget.ratio} exhausted={budget.exhausted} />
        <dl className="flex flex-col gap-sm">
          <Prop label="Reviews">
            {counters.reviews.used} of {counters.reviews.max}
          </Prop>
          <Prop label="Revisions">
            {counters.revisions.used} of {counters.revisions.max}
          </Prop>
          <Prop label="Runs">
            <span className={item.runLimit.exhausted ? "text-bad" : undefined}>
              {item.runLimit.used} of {item.runLimit.max}
            </span>
          </Prop>
        </dl>
      </section>
      <section className="flex flex-col gap-sm">
        <h2 className="pane-heading">Runs</h2>
        {item.runs.length === 0 ? (
          <p className="text-small text-muted">No runs yet.</p>
        ) : (
          <ul className="flex flex-col gap-xs">
            {item.runs.map((run) => {
              const duration = runDuration(run, now);
              return (
                <li key={run.id}>
                  <Link
                    to="/runs/$runId"
                    params={{ runId: String(run.id) }}
                    className="flex items-center gap-sm rounded-control py-xs text-small hover:bg-surface-muted"
                  >
                    <span
                      className={`h-sm w-sm shrink-0 rounded-chip ${TONE_FILL[RUN_STATUS[run.status].tone]}`}
                      title={RUN_STATUS[run.status].label}
                    />
                    <span className="font-medium">{run.name}</span>
                    <span className="sr-only">
                      , {RUN_STATUS[run.status].label.toLowerCase()}
                    </span>
                    <span className="min-w-0 grow truncate text-tiny text-muted">
                      {run.model}
                    </span>
                    <span className="text-tiny text-muted">
                      {run.turns !== null
                        ? `${run.turns} turn${run.turns === 1 ? "" : "s"}`
                        : duration === null
                          ? "—"
                          : formatDuration(duration)}
                    </span>
                    <span className="text-tiny tabular-nums">
                      {money(run.costUsd)}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </aside>
  );
}
