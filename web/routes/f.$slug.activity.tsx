import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import type {
  ItemViewDto,
  LessonDto,
  OutcomesDto,
  StageGroup,
  Tone,
} from "../../src/web/api.ts";
import { activityQuery, statusQuery } from "../lib/api";
import { EmptyState } from "../ui/empty-state";
import { Icon } from "../ui/icons";
import { TONE } from "../ui/tone";

const SOURCES = ["github", "telegram", "schedule", "manual"] as const;
type Source = (typeof SOURCES)[number];
const SOURCE_LABEL: Record<Source, string> = {
  github: "GitHub",
  telegram: "Telegram",
  schedule: "Schedule",
  manual: "Manual",
};
const GROUPS: { group: StageGroup; label: string; tone: Tone }[] = [
  { group: "triage", label: "Triage", tone: "muted" },
  { group: "planning", label: "Planning", tone: "muted" },
  { group: "building", label: "Building", tone: "building" },
  { group: "reviewing", label: "Reviewing", tone: "reviewing" },
  { group: "handoff", label: "Handoff", tone: "handoff" },
  { group: "complete", label: "Complete", tone: "muted" },
];
const NEEDS_YOU_TONE: Record<ItemViewDto["needsYou"]["kind"], Tone> = {
  spec: "attention",
  question: "attention",
  pr: "handoff",
  failed: "bad",
  none: "muted",
};

type Search = { source?: Source; hideComplete?: true };

export const Route = createFileRoute("/f/$slug/activity")({
  staticData: { title: "Activity" },
  // Unknown or malformed filters fall back to showing everything.
  validateSearch: (raw: Record<string, unknown>): Search => ({
    source: SOURCES.find((source) => source === raw.source),
    hideComplete: raw.hideComplete === true || undefined,
  }),
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(activityQuery(params.slug));
  },
  component: Activity,
});

function age(iso: string): string {
  const minutes = Math.max(0, (Date.now() - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${Math.floor(minutes)}m`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / 1440)}d`;
}

function Activity() {
  const { slug } = Route.useParams();
  const { data, isError } = useQuery(activityQuery(slug));
  const { data: status } = useQuery(statusQuery);
  const repositories = status?.factories.find(
    (factory) => factory.slug === slug,
  )?.repositories;
  const { source, hideComplete } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [collapsed, setCollapsed] = useState<Set<StageGroup>>(
    () => new Set(["complete"]),
  );
  const toggle = (group: StageGroup) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(group)) next.add(group);
      return next;
    });
  const all = data?.items ?? [];
  const items = all.filter(
    (item) =>
      (!source || item.source === source) &&
      !(hideComplete && item.group === "complete"),
  );

  return (
    <section className="grid gap-lg">
      <div className="flex flex-wrap items-baseline gap-md">
        <h1 className="text-heading font-bold">Activity</h1>
        {data && (
          <p className="text-small text-muted">
            {data.summary.open} open · {data.summary.needsYou} need you · $
            {data.summary.costUsd.toFixed(2)} total
          </p>
        )}
        <div className="ml-auto flex flex-wrap gap-sm">
          <DropdownMenu.Root>
            <DropdownMenu.Trigger className="filter-button">
              <Icon name="list-filter" className="h-md w-md text-muted" />
              Source: {source ? SOURCE_LABEL[source] : "all"}
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" className="menu">
                <DropdownMenu.RadioGroup
                  value={source ?? "all"}
                  onValueChange={(value) =>
                    navigate({
                      search: (prev) => ({
                        ...prev,
                        source: value === "all" ? undefined : (value as Source),
                      }),
                    })
                  }
                >
                  {(["all", ...SOURCES] as const).map((value) => (
                    <DropdownMenu.RadioItem
                      key={value}
                      value={value}
                      className="menu-item"
                    >
                      {value === "all" ? "All sources" : SOURCE_LABEL[value]}
                    </DropdownMenu.RadioItem>
                  ))}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <button
            type="button"
            className="filter-button"
            aria-pressed={Boolean(hideComplete)}
            onClick={() =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  hideComplete: hideComplete ? undefined : true,
                }),
              })
            }
          >
            <Icon name="eye-off" className="h-md w-md text-muted" />
            Hide complete
          </button>
        </div>
      </div>
      {data && data.outcomes.prs > 0 && <Outcomes outcomes={data.outcomes} />}
      {data && data.lessons.length > 0 && (
        <Lessons lessons={data.lessons} unchecked={data.uncheckedCorrections} />
      )}
      {repositories === 0 && (
        <EmptyState
          icon="folder-git-2"
          title="Add a repository to start"
          action={
            <Link
              to="/f/$slug/definition"
              params={{ slug }}
              className="primary flex items-center gap-xs"
            >
              <Icon name="plus" className="h-icon w-icon" />
              Add repository
            </Link>
          }
        >
          Nakara needs at least one repository in factory.yaml before agents can
          work.
        </EmptyState>
      )}
      {!data ? (
        <p role="status" className="text-muted">
          {isError ? "Activity unavailable. Retrying…" : "Loading activity…"}
        </p>
      ) : all.length === 0 ? (
        // Without repositories, adding one is the only next step.
        repositories !== 0 && (
          <EmptyState
            icon="inbox"
            title="No work yet"
            action={
              <Link
                to="."
                search={(prev) => ({ ...prev, new: 1 })}
                className="primary flex items-center gap-xs"
              >
                <Icon name="plus" className="h-icon w-icon" />
                New work
              </Link>
            }
          >
            Create work, label an issue factory:Nakara, or message the Telegram
            bot.
          </EmptyState>
        )
      ) : items.length === 0 ? (
        <p className="text-muted">No work items match these filters.</p>
      ) : (
        <div className="grid gap-xs">
          {GROUPS.map(({ group, label, tone }) => {
            const rows = items.filter((item) => item.group === group);
            if (rows.length === 0) return null;
            const expanded = !collapsed.has(group);
            return (
              <section key={group} aria-label={label} className="grid gap-xs">
                <h2>
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-controls={`group-${group}`}
                    onClick={() => toggle(group)}
                    className={`flex w-full items-center gap-sm rounded-control px-md py-sm text-body font-semibold ${TONE[tone]}`}
                  >
                    <Icon
                      name="chevron-down"
                      className={`h-lg w-lg ${expanded ? "" : "-rotate-90"}`}
                    />
                    {label} <span className="font-normal">{rows.length}</span>
                  </button>
                </h2>
                <ul
                  id={`group-${group}`}
                  hidden={!expanded}
                  className="grid gap-xs"
                >
                  {rows.map((item) => (
                    <Row key={item.id} item={item} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

const hours = (h: number) =>
  h < 1
    ? `${Math.round(h * 60)} min`
    : h < 48
      ? `${h.toFixed(1)} h`
      : `${(h / 24).toFixed(1)} d`;

/** What closed work came to; shown once a PR has closed. */
function Outcomes({ outcomes: o }: { outcomes: OutcomesDto }) {
  const stats: {
    label: string;
    value: string;
    note: string;
    title?: string;
  }[] = [
    {
      label: "Merge rate",
      value: `${Math.round((o.merged / o.prs) * 100)}%`,
      note: `${o.merged} of ${o.prs} PRs`,
    },
    {
      label: "Closed unmerged",
      value: String(o.closedUnmerged),
      note: "PRs closed without a merge",
    },
    {
      label: "Revisions per item",
      value: o.revisionsPerItem?.toFixed(1) ?? "—",
      note: "after review",
    },
    {
      label: "Cost per merged PR",
      value:
        o.costPerMergedPrUsd === null
          ? "—"
          : `$${o.costPerMergedPrUsd.toFixed(2)}`,
      note: "all closed work ÷ merged",
      title:
        "Runs on codex or qwen record $0, so this counts Claude runs only.",
    },
    {
      label: "Median cycle time",
      value: o.medianCycleHours === null ? "—" : hours(o.medianCycleHours),
      note: "request → merge",
    },
  ];
  return (
    <section aria-label="Outcomes">
      <dl className="outcomes">
        {stats.map((s) => (
          <div key={s.label} title={s.title}>
            <dt className="text-small text-muted">{s.label}</dt>
            <dd className="text-title font-bold tabular-nums">{s.value}</dd>
            <dd className="text-tiny text-muted">{s.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Approved lessons and their recurrences: T4 is done at 3 lessons whose mistakes stay at 0. */
function Lessons({
  lessons,
  unchecked,
}: {
  lessons: LessonDto[];
  unchecked: number;
}) {
  const recurrences = lessons.reduce((sum, l) => sum + l.recurrences, 0);
  return (
    <section aria-label="Lessons" className="grid gap-sm">
      <dl className="outcomes">
        <div>
          <dt className="text-small text-muted">Approved lessons</dt>
          <dd className="text-title font-bold tabular-nums">
            {lessons.length}
          </dd>
          <dd className="text-tiny text-muted">in the learnings skill</dd>
        </div>
        <div>
          <dt className="text-small text-muted">Recurrences</dt>
          <dd
            className={`text-title font-bold tabular-nums ${recurrences ? "text-bad" : ""}`}
          >
            {recurrences}
          </dd>
          <dd className="text-tiny text-muted">mistakes that came back</dd>
        </div>
        <div title="A proposal still waited, the budget was spent, the reflect run failed, or the factory had no reflect agent. Check these corrections yourself before trusting 0 recurrences.">
          <dt className="text-small text-muted">Not checked</dt>
          <dd
            className={`text-title font-bold tabular-nums ${unchecked ? "text-attention" : ""}`}
          >
            {unchecked}
          </dd>
          <dd className="text-tiny text-muted">
            corrections no reflect run saw
          </dd>
        </div>
      </dl>
      <ul className="grid gap-xs text-small">
        {lessons.map((l) => (
          <li key={l.id} className="flex items-baseline gap-sm">
            <span
              className={`shrink-0 tabular-nums ${l.recurrences ? "text-bad" : "text-muted"}`}
              title="Recurrences"
            >
              ×{l.recurrences}
            </span>
            <span className="min-w-0">
              {l.lines.join(" ")}{" "}
              <span className="text-muted">({l.mistake})</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Row({ item }: { item: ItemViewDto }) {
  const { agent, needsYou } = item;
  return (
    <li className="flex items-center gap-md rounded-control px-md py-sm hover:bg-surface-muted">
      <span
        className={`flex h-tile w-tile shrink-0 items-center justify-center rounded-control ${TONE[agent.tone]}`}
        title={`${agent.name}${agent.running ? " (running)" : ""}`}
      >
        <Icon name={agent.icon} className="h-lg w-lg" />
        <span className="sr-only">{agent.name}</span>
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-md gap-y-xs">
        <p className="min-w-0 grow basis-title">
          <span className="mr-md text-small text-muted">#{item.id}</span>
          <Link
            className="font-medium hover:underline"
            to="/items/$itemId"
            params={{ itemId: String(item.id) }}
          >
            {item.title}
          </Link>
        </p>
        <span className="flex flex-wrap items-center gap-sm">
          {needsYou.label && (
            <span
              className={`chip font-medium ${TONE[NEEDS_YOU_TONE[needsYou.kind]]}`}
            >
              <Icon name="circle-alert" className="h-md w-md" />
              {needsYou.label}
            </span>
          )}
          {item.chips.map((chip) =>
            chip.url ? (
              <a
                key={chip.kind}
                className="chip border border-line hover:underline"
                href={chip.url}
              >
                <Icon name={chip.icon} className="h-md w-md" />
                {chip.label}
              </a>
            ) : (
              <span key={chip.kind} className="chip border border-line">
                <Icon name={chip.icon} className="h-md w-md" />
                {chip.label}
              </span>
            ),
          )}
        </span>
        <span className="ml-auto flex gap-md">
          <span className="w-cost text-right text-small text-muted tabular-nums">
            ${item.budget.usedUsd.toFixed(2)}
          </span>
          <time
            className="w-age text-right text-small text-muted"
            dateTime={item.updatedAt}
            title={item.updatedAt}
          >
            {age(item.updatedAt)}
          </time>
        </span>
      </div>
    </li>
  );
}
