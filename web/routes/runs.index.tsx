import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { RunRowDto, RunStatus } from "../../src/web/api.ts";
import { type RunFilter, runsQuery } from "../lib/api";
import { FactoryFilter, FactoryTag, factorySearch } from "../app/factory";
import { formatDuration, relativeTime, runDuration } from "../lib/format";

const STATUSES = [
  ["running", "Running"],
  ["queued", "Queued"],
  ["failed", "Failed"],
  ["succeeded", "Succeeded"],
  ["cancelled", "Cancelled"],
  ["interrupted", "Interrupted"],
] as const satisfies readonly (readonly [RunStatus, string])[];

export const Route = createFileRoute("/runs/")({
  validateSearch: (search: Record<string, unknown>): RunFilter => ({
    status: STATUSES.find(([status]) => status === search.status)?.[0],
    agent:
      typeof search.agent === "string" && search.agent
        ? search.agent
        : undefined,
    factory: factorySearch(search.factory),
  }),
  loaderDeps: ({ search: { status, agent, factory } }) => ({
    status,
    agent,
    factory,
  }),
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context, deps }) => {
    void context.queryClient.prefetchQuery(runsQuery(deps));
  },
  staticData: { title: "Runs" },
  component: Runs,
});

const STATUS_TONE: Record<RunStatus, string> = {
  running: "bg-building-soft text-building",
  queued: "bg-surface-muted text-muted",
  failed: "bg-bad-bg text-bad",
  succeeded: "bg-handoff-soft text-handoff",
  cancelled: "bg-surface-muted text-muted",
  interrupted: "bg-surface-muted text-muted",
};

/** Agent tiles follow the mockups: one tone and glyph per agent type. */
const TILES: Record<RunRowDto["agentType"], { tone: string; path: string }> = {
  FOREMAN: {
    tone: "bg-accent-soft text-accent",
    path: "M3 3h8v8H3zM13 13h8v8h-8zM7 11v4a2 2 0 0 0 2 2h4",
  },
  TRIAGE: {
    tone: "bg-surface-muted text-muted",
    path: "M11 3a8 8 0 1 0 0 16 8 8 0 0 0 0-16ZM21 21l-4.3-4.3",
  },
  SPEC: {
    tone: "bg-attention-soft text-attention",
    path: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M16 13H8M16 17H8",
  },
  IMPLEMENT: {
    tone: "bg-building-soft text-building",
    path: "m18 16 4-4-4-4M6 8l-4 4 4 4M14.5 4l-5 16",
  },
  REVIEW: {
    tone: "bg-reviewing-soft text-reviewing",
    path: "M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM13 6h3a2 2 0 0 1 2 2v7M6 9v12",
  },
  VERIFY: {
    tone: "bg-handoff-soft text-handoff",
    path: "M20 6 9 17l-5-5",
  },
  CUSTOM: {
    tone: "bg-surface-muted text-text",
    path: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z",
  },
  REFLECT: {
    tone: "bg-surface-muted text-muted",
    path: "M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V16h8v-1.3A7 7 0 0 0 12 2Z",
  },
};

function AgentTile({ type }: { type: RunRowDto["agentType"] }) {
  const tile = TILES[type] ?? TILES.CUSTOM;
  return (
    <span
      className={`flex h-xxl w-xxl shrink-0 items-center justify-center rounded-control ${tile.tone}`}
    >
      <svg
        className="h-lg w-lg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={tile.path} />
      </svg>
    </span>
  );
}

/** A display clock; data itself refreshes only through /api/events. */
function useNow(interval: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

function RunRow({ run, now }: { run: RunRowDto; now: number }) {
  const duration = runDuration(run, now);
  const label = STATUSES.find(([status]) => status === run.status)?.[1];
  return (
    <li className="flex items-start gap-md border-b border-line py-md">
      <AgentTile type={run.agentType} />
      <div className="flex min-w-0 flex-1 flex-col gap-xs md:flex-row md:items-start md:justify-between md:gap-lg">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-sm">
            <Link
              className="font-semibold text-text hover:underline"
              to="/runs/$runId"
              params={{ runId: String(run.id) }}
            >
              {run.agent} <span className="text-muted">run #{run.id}</span>
            </Link>
            <span
              className={`rounded-control px-sm text-tiny ${STATUS_TONE[run.status]}`}
            >
              {label}
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-sm">
            <FactoryTag slug={run.factory} />
            <Link
              className="text-small text-accent hover:underline"
              to="/items/$itemId"
              params={{ itemId: String(run.itemId) }}
            >
              #{run.itemId} {run.itemTitle}
            </Link>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-lg text-small text-muted md:shrink-0 md:justify-end">
          <RunMeta run={run} duration={duration} now={now} />
        </dl>
      </div>
    </li>
  );
}

function RunMeta({
  run,
  duration,
  now,
}: {
  run: RunRowDto;
  duration: number | null;
  now: number;
}) {
  return (
    <>
      <div>
        <dt className="sr-only">Harness</dt>
        <dd>
          {run.harness}
          {run.model ? ` · ${run.model}` : ""}
        </dd>
      </div>
      <div>
        <dt className="sr-only">Duration</dt>
        <dd>
          {duration === null ? (
            "—"
          ) : (
            <time dateTime={`PT${Math.floor(duration / 1000)}S`}>
              {formatDuration(duration)}
            </time>
          )}
        </dd>
      </div>
      <div>
        <dt className="sr-only">Cost</dt>
        <dd>${run.costUsd.toFixed(2)}</dd>
      </div>
      <div>
        <dt className="sr-only">Started</dt>
        <dd>
          <time dateTime={run.startedAt} title={run.startedAt}>
            {relativeTime(run.startedAt, now)}
          </time>
        </dd>
      </div>
    </>
  );
}

function Runs() {
  const filter = Route.useSearch();
  const navigate = Route.useNavigate();
  const { data, isError, isPending } = useQuery({
    ...runsQuery(filter),
    placeholderData: keepPreviousData,
  });
  const running = data?.runs.some((run) => run.status === "running");
  const now = useNow(running ? 1000 : 30_000);
  const agents = data?.agents ?? [];
  const agentOptions =
    filter.agent && !agents.includes(filter.agent)
      ? [filter.agent, ...agents]
      : agents;
  const pill = (active: boolean) =>
    `rounded-control border px-md py-xs text-small ${
      active
        ? "border-text bg-text text-bg"
        : "border-line text-text hover:bg-surface-muted"
    }`;
  return (
    <section>
      <h1 className="mb-lg text-heading font-semibold">Runs</h1>
      <div className="mb-lg flex flex-wrap items-center gap-md">
        <nav className="flex flex-wrap gap-sm" aria-label="Filter by status">
          <Link
            className={pill(!filter.status)}
            search={(prev) => ({ ...prev, status: undefined })}
            to="/runs"
            aria-current={!filter.status ? "true" : undefined}
          >
            All
          </Link>
          {STATUSES.map(([status, label]) => (
            <Link
              key={status}
              className={pill(filter.status === status)}
              search={(prev) => ({ ...prev, status })}
              to="/runs"
              aria-current={filter.status === status ? "true" : undefined}
            >
              {label}
            </Link>
          ))}
        </nav>
        <label className="flex items-center gap-sm text-small text-muted">
          Agent
          <select
            className="rounded-control border border-line bg-bg px-sm py-xs text-small text-text"
            value={filter.agent ?? ""}
            onChange={(event) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  agent: event.target.value || undefined,
                }),
              })
            }
          >
            <option value="">All agents</option>
            {agentOptions.map((agent) => (
              <option key={agent} value={agent}>
                {agent}
              </option>
            ))}
          </select>
        </label>
        <FactoryFilter
          value={filter.factory}
          onChange={(factory) =>
            navigate({ search: (prev) => ({ ...prev, factory }) })
          }
        />
      </div>
      {data ? (
        data.runs.length ? (
          <>
            <ul className="border-t border-line">
              {data.runs.map((run) => (
                <RunRow key={run.id} run={run} now={now} />
              ))}
            </ul>
            {data.truncated && (
              <p className="mt-md text-small text-muted">
                Showing the latest {data.runs.length} runs.
              </p>
            )}
          </>
        ) : (
          <p className="text-muted">
            {filter.status || filter.agent || filter.factory ? (
              <>
                No runs match these filters.{" "}
                <Link className="text-accent hover:underline" to="/runs">
                  Clear filters
                </Link>
              </>
            ) : (
              "No runs yet."
            )}
          </p>
        )
      ) : (
        <p className="text-muted" role="status">
          {isError && !isPending ? "Unable to load runs." : "Loading runs…"}
        </p>
      )}
    </section>
  );
}
