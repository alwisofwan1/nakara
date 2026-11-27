import * as Tabs from "@radix-ui/react-tabs";
import {
  useMutation,
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { createFileRoute, Link, notFound } from "@tanstack/react-router";
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { RepoDiffDto, RunDetailDto } from "../../src/web/api.ts";
import { loadPage, queueFollowUp, runDiffQuery, runQuery } from "../lib/api";
import { type DiffLineKind, parseDiff } from "../features/run/diff";
import type { LogEntry, LogState } from "../features/run/log";
import { useRunLog } from "../features/run/run-log";
import { defaultFactory } from "../app/runtime";
import { usePageCrumbs } from "../app/shell";
import { StopRunButton } from "../features/run/stop-run";

export const Route = createFileRoute("/runs/$runId")({
  loader: ({ context, params }) => {
    const id = Number(params.runId);
    if (!Number.isInteger(id) || id <= 0) throw notFound();
    return loadPage(context.queryClient, runQuery(id));
  },
  component: RunPage,
});

type RunDetail = RunDetailDto;
type RunStatus = RunDetail["status"];

const STATUS: Record<RunStatus, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "bg-surface-muted text-muted" },
  running: { label: "Running", tone: "bg-building-soft text-building" },
  succeeded: { label: "Succeeded", tone: "bg-handoff-soft text-handoff" },
  failed: { label: "Failed", tone: "bg-bad-bg text-bad" },
  cancelled: { label: "Cancelled", tone: "bg-surface-muted text-muted" },
  interrupted: { label: "Interrupted", tone: "bg-surface-muted text-muted" },
};
const live = (status: RunStatus) => status === "queued" || status === "running";
const runName = (run: {
  role: string;
  agent: string;
  harness: string;
  model: string | null;
}) =>
  `${run.role === "foreman" ? "Foreman turn" : run.agent} · ${run.harness}${run.model ? `:${run.model}` : ""}`;
const shortId = (id: string) =>
  id.length > 12 ? `${id.slice(0, 4)}…${id.slice(-3)}` : id;

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${s % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** Re-render every second while a run is live, for its elapsed time. */
function useNow(ticking: boolean) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return now;
}

function RunPage() {
  const id = Number(Route.useParams().runId);
  const { data: run } = useSuspenseQuery(runQuery(id));
  usePageCrumbs(
    [
      {
        label: "Activity",
        href: `/f/${run.factory || defaultFactory.slug}/activity`,
      },
      {
        label: `#${run.item.id} ${run.item.title}`,
        href: `/items/${run.item.id}`,
      },
      { label: `Run #${run.id}` },
    ],
    run.factory,
  );
  // Keyed so a different run starts a fresh log stream and composer.
  return <RunDetailView key={run.id} run={run} />;
}

function RunDetailView({ run }: { run: RunDetail }) {
  const log = useRunLog(run.id);
  const now = useNow(run.status === "running");
  const status = STATUS[run.status];
  const elapsed =
    run.durationMs ??
    (run.status === "running" ? now - Date.parse(run.startedAt) : null);
  return (
    <div className="flex flex-col gap-lg">
      <div className="flex flex-wrap items-start gap-md">
        <div className="min-w-0">
          <h1 className="text-heading font-bold">{runName(run)}</h1>
          <p className="text-small text-muted">
            {run.role === "foreman"
              ? `Turn ${run.attempt}`
              : run.fallback
                ? `Fallback for run #${run.fallback.runId}`
                : run.attempt > 1
                  ? `Follow-up ${run.attempt - 1}`
                  : "First run"}
            {run.sessionId ? ` · session ${shortId(run.sessionId)}` : ""}
          </p>
        </div>
        <span
          className={`flex items-center gap-xs rounded-control px-md py-xs text-tiny font-semibold ${status.tone}`}
        >
          {status.label}
        </span>
        <div className="ml-auto flex flex-wrap gap-sm">
          <CopySession sessionId={run.sessionId} />
          <StopRunButton run={run} />
        </div>
      </div>
      <dl className="run-meta">
        <Meta label="Started">
          <time dateTime={run.startedAt} title={run.startedAt}>
            {new Date(run.startedAt).toLocaleString()}
          </time>
        </Meta>
        <Meta label="Duration">
          {elapsed === null ? "—" : duration(elapsed)}
        </Meta>
        <Meta label="Cost">${run.costUsd.toFixed(2)}</Meta>
        <Meta label="Runner">{run.runner}</Meta>
        <Meta label="Worktree">
          <span title={run.worktree}>{run.worktree.split("/").at(-1)}</span>
        </Meta>
        <Meta label="Exit">{live(run.status) ? "—" : run.status}</Meta>
      </dl>
      {run.fallback && (
        <p
          role="status"
          className="rounded-control border border-attention bg-attention-soft px-md py-sm text-small"
        >
          Moved to the fallback harness {run.harness}:{" "}
          <Link
            to="/runs/$runId"
            params={{ runId: String(run.fallback.runId) }}
            className="font-semibold hover:underline"
          >
            run #{run.fallback.runId}
          </Link>{" "}
          hit the {run.fallback.harness} rate or usage limit (
          {run.fallback.reason}
          {run.fallback.resetAt
            ? `; it resets ${new Date(run.fallback.resetAt).toLocaleString()}`
            : ""}
          ), so this run started the same brief on {run.harness}.
        </p>
      )}
      {run.error && (
        <p
          role="alert"
          className="rounded-control border border-bad-line bg-bad-bg px-md py-sm text-bad"
        >
          {run.error}
        </p>
      )}
      <div className="run-body">
        <RunTabs run={run} log={log} />
        <aside className="flex flex-col gap-lg" aria-label="Run actions">
          {run.role === "agent" && (
            <Box
              title={
                run.attempt > 1 && !run.fallback
                  ? "Follow-up message"
                  : "Dispatched by foreman"
              }
            >
              <p className="max-h-panel overflow-auto text-small whitespace-pre-wrap">
                {run.input}
              </p>
            </Box>
          )}
          {run.role === "agent" && <FollowUp run={run} />}
          {run.tools.length > 0 && (
            <Box title="External tools called">
              <ul className="flex flex-col gap-sm">
                {run.tools.map((tool) => (
                  <li
                    key={tool.name}
                    className="flex justify-between gap-sm text-small"
                  >
                    <code>{tool.name}</code>
                    <span className="text-muted">× {tool.calls}</span>
                  </li>
                ))}
              </ul>
            </Box>
          )}
          <Box title={`Other runs on #${run.item.id}`}>
            {run.otherRuns.length === 0 ? (
              <p className="text-small text-muted">No other runs yet.</p>
            ) : (
              <ul className="flex flex-col gap-sm">
                {run.otherRuns.map((other) => (
                  <li key={other.id}>
                    <Link
                      to="/runs/$runId"
                      params={{ runId: String(other.id) }}
                      className="flex justify-between gap-sm text-small hover:underline"
                    >
                      <span className="font-semibold">{runName(other)}</span>
                      <span className="text-muted">
                        {STATUS[other.status].label.toLowerCase()} · $
                        {other.costUsd.toFixed(2)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Box>
        </aside>
      </div>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-tiny text-muted">{label}</dt>
      <dd className="text-small font-semibold">{children}</dd>
    </div>
  );
}

function Box({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-sm rounded-control border border-line p-lg">
      <h2 className="text-small font-bold">{title}</h2>
      {children}
    </section>
  );
}

function CopySession({ sessionId }: { sessionId: string | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="ghost"
      disabled={!sessionId}
      onClick={() => {
        if (!sessionId) return;
        void navigator.clipboard
          ?.writeText(sessionId)
          .then(() => setCopied(true));
      }}
    >
      {copied ? "Copied" : "Copy session id"}
    </button>
  );
}

function RunTabs({ run, log }: { run: RunDetail; log: LogState }) {
  return (
    <Tabs.Root defaultValue="log" className="flex min-w-0 flex-col gap-md">
      <Tabs.List className="flex gap-xs" aria-label="Run details">
        {["Log", "Prompt", "Report", "Diff"].map((name) => (
          <Tabs.Trigger key={name} value={name.toLowerCase()} className="tab">
            {name}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
      <Tabs.Content value="log">
        <LogView
          entries={log.entries}
          ended={log.ended}
          queued={run.status === "queued"}
        />
        <p className="mt-sm text-tiny text-muted">
          {log.ended ? "Run ended" : "Live · auto-scroll"}
          {run.logPath ? ` · raw log: ${run.logPath}` : ""}
        </p>
      </Tabs.Content>
      <Tabs.Content value="prompt" className="flex flex-col gap-md">
        <Section
          title={run.role === "foreman" ? "Turn input" : "Message"}
          text={run.input}
        />
        {run.systemPrompt && (
          <Section title="System prompt" text={run.systemPrompt} />
        )}
      </Tabs.Content>
      <Tabs.Content value="report">
        {run.report ? (
          <Pre text={run.report} />
        ) : (
          <p className="text-muted">
            {live(run.status)
              ? "The report arrives when the run ends."
              : "This run left no report."}
          </p>
        )}
      </Tabs.Content>
      <Tabs.Content value="diff">
        <RunDiff runId={run.id} changes={log.changes} />
      </Tabs.Content>
    </Tabs.Root>
  );
}

function Section({ title, text }: { title: string; text: string }) {
  return (
    <section className="flex flex-col gap-sm">
      <h2 className="text-small font-semibold text-muted">{title}</h2>
      <Pre text={text} />
    </section>
  );
}

function Pre({ text }: { text: string }) {
  return (
    <pre className="max-h-log overflow-auto rounded-control border border-line bg-surface-muted p-md font-mono text-small whitespace-pre-wrap">
      {text}
    </pre>
  );
}

const ENTRY_TONE: Record<LogEntry["kind"], string> = {
  text: "text-log-text",
  tool: "text-log-tool",
  output: "text-log-muted",
  error: "text-log-bad",
  meta: "text-log-muted",
  raw: "text-log-muted",
};

function LogView({
  entries,
  ended,
  queued,
}: {
  entries: LogState["entries"];
  ended: boolean;
  queued: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Scroll whenever entries grow.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  return (
    <div
      ref={ref}
      role="log"
      aria-label="Run log"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable log must be reachable by keyboard.
      tabIndex={0}
      onScroll={(event) => {
        const el = event.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      }}
      className="flex max-h-log min-h-panel flex-col gap-xs overflow-auto rounded-control bg-log-bg p-lg font-mono text-small text-log-text"
    >
      {entries.length === 0 && (
        <p className="text-log-muted">
          {ended
            ? "No log was recorded."
            : queued
              ? "Waiting for the run to start…"
              : "Waiting for output…"}
        </p>
      )}
      {entries.map((entry) =>
        entry.detail ? (
          <details key={entry.id} className={ENTRY_TONE[entry.kind]}>
            <summary className="cursor-pointer">{entry.text}</summary>
            <pre className="whitespace-pre-wrap">{entry.detail}</pre>
          </details>
        ) : (
          <p
            key={entry.id}
            className={`whitespace-pre-wrap ${ENTRY_TONE[entry.kind]}`}
          >
            {entry.text}
          </p>
        ),
      )}
      {!ended && entries.length > 0 && <p aria-hidden="true">▍</p>}
    </div>
  );
}

/** The run's git diff per repository; runs without snapshots show the edits from their log. */
function RunDiff({
  runId,
  changes,
}: {
  runId: number;
  changes: LogState["changes"];
}) {
  const { data, error, refetch, isFetching } = useQuery(runDiffQuery(runId));
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return <p role="status">Loading the diff…</p>;
  if (data.source === "log") return <DiffView changes={changes} />;
  return (
    <div className="flex flex-col gap-md">
      <div className="flex flex-wrap items-center gap-sm">
        <p className="text-small text-muted">
          {data.live
            ? "Changes so far in the run's worktrees, committed or not, by any tool."
            : "What this run changed in its worktrees, committed or not, by any tool."}
        </p>
        {data.live && (
          <button
            type="button"
            className="ghost ml-auto"
            disabled={isFetching}
            onClick={() => void refetch()}
          >
            {isFetching ? "Refreshing…" : "Refresh"}
          </button>
        )}
      </div>
      {data.repos.map((repo) => (
        <RepoDiff key={repo.slug} repo={repo} />
      ))}
    </div>
  );
}

const LINE_TONE: Record<DiffLineKind, string> = {
  add: "bg-handoff-soft text-handoff",
  del: "bg-bad-bg text-bad",
  hunk: "text-accent",
  context: "",
};

function RepoDiff({ repo }: { repo: RepoDiffDto }) {
  const files = parseDiff(repo.diff);
  return (
    <section aria-label={repo.slug} className="flex flex-col gap-sm">
      <h2 className="flex flex-wrap items-baseline gap-sm text-small font-bold">
        <span className="font-mono">{repo.slug}</span>
        {repo.stat && (
          <span className="font-normal text-muted">{repo.stat}</span>
        )}
      </h2>
      {repo.error ? (
        <p role="alert" className="text-small text-bad">
          {repo.error}
        </p>
      ) : files.length === 0 ? (
        <p className="text-small text-muted">No changes.</p>
      ) : (
        files.map((file) => (
          <section
            key={`${file.from ?? ""}>${file.path}`}
            className="overflow-hidden rounded-control border border-line"
          >
            <h3 className="border-b border-line bg-surface-muted px-md py-xs font-mono text-small">
              {file.from ? `${file.from} → ${file.path}` : file.path}{" "}
              <span className="text-muted">
                ({file.status}
                {file.binary ? ", binary" : ""})
              </span>
            </h3>
            {file.lines.length > 0 && (
              <pre className="max-h-panel overflow-auto p-md font-mono text-small">
                {file.lines.map((line, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: Static diff lines.
                  <div key={i} className={LINE_TONE[line.kind]}>
                    {line.text}
                  </div>
                ))}
              </pre>
            )}
          </section>
        ))
      )}
      {repo.truncated && (
        <p
          role="note"
          className="rounded-control border border-line bg-attention-soft px-md py-sm text-small text-attention"
        >
          Diff truncated: only the first {Math.round(repo.limitBytes / 1024)} KB
          are shown. The summary above counts every change.
        </p>
      )}
    </section>
  );
}

/** The file edits recorded in the log, for runs from before snapshots. */
function DiffView({ changes }: { changes: LogState["changes"] }) {
  if (changes.length === 0)
    return (
      <p className="text-muted">
        No file edits were recorded in this run's log.
      </p>
    );
  return (
    <div className="flex flex-col gap-md">
      <p className="text-small text-muted">
        File edits recorded in this run's log, not a git diff. Changes made by
        shell commands do not appear here.
      </p>
      {changes.map((change) => (
        <section
          key={change.id}
          className="overflow-hidden rounded-control border border-line"
        >
          <h2 className="border-b border-line bg-surface-muted px-md py-xs font-mono text-small">
            {change.path} <span className="text-muted">({change.kind})</span>
          </h2>
          {(change.removed || change.added) && (
            <pre className="max-h-panel overflow-auto p-md font-mono text-small">
              {lines(change.removed).map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Static diff lines.
                <div key={`-${i}`} className="bg-bad-bg text-bad">
                  − {line}
                </div>
              ))}
              {lines(change.added).map((line, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Static diff lines.
                <div key={`+${i}`} className="bg-handoff-soft text-handoff">
                  + {line}
                </div>
              ))}
            </pre>
          )}
        </section>
      ))}
    </div>
  );
}
const lines = (text: string) =>
  text ? text.replace(/\n$/, "").split("\n") : [];

function FollowUp({ run }: { run: RunDetail }) {
  const client = useQueryClient();
  const [message, setMessage] = useState("");
  const mutation = useMutation({
    mutationFn: (text: string) => queueFollowUp(run.id, text),
    onSuccess: () => {
      setMessage("");
      void client.invalidateQueries({ queryKey: ["runs"] });
    },
  });
  const { allowed, reason, countsAsRevision, revisions } = run.followUp;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (message.trim()) mutation.mutate(message.trim());
  };
  return (
    <Box title="Follow up">
      <p className="text-tiny text-muted">
        Sends a message into this agent's session after the run ends.{" "}
        {countsAsRevision
          ? `Counts as a revision (${revisions.used} of ${revisions.max} used).`
          : `Revisions: ${revisions.used} of ${revisions.max} used.`}
      </p>
      <form onSubmit={submit} className="flex flex-col gap-sm">
        <label className="sr-only" htmlFor="follow-up">
          Follow-up message
        </label>
        <textarea
          id="follow-up"
          rows={3}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          disabled={!allowed || mutation.isPending}
          placeholder="Also add a test for…"
          className="rounded-control border border-line px-md py-sm text-small"
        />
        {!allowed && reason && <p className="text-tiny text-muted">{reason}</p>}
        {mutation.error && (
          <p role="alert" className="text-tiny text-bad">
            {mutation.error.message}
          </p>
        )}
        {mutation.data && (
          <p role="status" className="text-tiny">
            Queued as{" "}
            <Link
              to="/runs/$runId"
              params={{ runId: String(mutation.data.run.id) }}
              className="text-accent hover:underline"
            >
              run #{mutation.data.run.id}
            </Link>
            .
          </p>
        )}
        <button
          type="submit"
          disabled={!allowed || mutation.isPending || !message.trim()}
          className="self-start rounded-control bg-text px-md py-xs text-small font-semibold text-bg disabled:opacity-50"
        >
          Queue follow-up
        </button>
      </form>
    </Box>
  );
}
