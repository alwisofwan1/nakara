import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import {
  definitionQuery,
  decideReach,
  reloadDefinition,
  validateDefinition,
} from "../lib/api";
import {
  plural,
  problemKey,
  problemLocation,
  relativeTime,
  timeOfDay,
} from "../lib/format";
import { Icon } from "../ui/icons";
import { useToast } from "../app/toast";
import { AdoptDefinition } from "../features/definition/adopt-definition";

export const Route = createFileRoute("/f/$slug/definition")({
  // Started, not awaited: the page shows its frame and its own loading state.
  loader: ({ context, params }) => {
    void context.queryClient.prefetchQuery(definitionQuery(params.slug));
  },
  component: DefinitionPage,
  staticData: { title: "Factory definition" },
});

type Definition = Awaited<
  ReturnType<NonNullable<ReturnType<typeof definitionQuery>["queryFn"]>>
>;
type Problem = Definition["errors"][number];
type CheckResult = Awaited<ReturnType<typeof validateDefinition>>;

function DefinitionPage() {
  const { slug } = Route.useParams();
  const client = useQueryClient();
  const toast = useToast();
  const { data, isError } = useQuery(definitionQuery(slug));
  const [validation, setValidation] = useState<CheckResult | null>(null);
  const validate = useMutation({
    mutationFn: () => validateDefinition(slug),
    onSuccess: setValidation,
    onError: (error) =>
      toast({
        title: "Validation failed",
        description: error.message,
        tone: "bad",
      }),
  });
  const reload = useMutation({
    mutationFn: () => reloadDefinition(slug),
    onSuccess: (result) => {
      setValidation(null);
      void client.invalidateQueries({
        queryKey: definitionQuery(slug).queryKey,
      });
      toast(
        result.ok
          ? {
              title: "Definition reloaded",
              description: "The factory now runs the files on disk.",
              tone: "ok",
            }
          : {
              title: `Reload failed: ${plural(result.errors.length, "error")}`,
              description: "The last valid definition is still running.",
              tone: "bad",
            },
      );
    },
    onError: (error) =>
      toast({
        title: "Reload failed",
        description: error.message,
        tone: "bad",
      }),
  });
  const decide = useMutation({
    mutationFn: (approve: boolean) => decideReach(slug, approve),
    onSuccess: (result, approve) => {
      void client.invalidateQueries({
        queryKey: definitionQuery(slug).queryKey,
      });
      toast(
        !approve
          ? {
              title: "Wider reach rejected",
              description: "The previous definition keeps running.",
              tone: "bad",
            }
          : result.ok
            ? {
                title: "Wider reach approved",
                description: "The factory now runs the files on disk.",
                tone: "ok",
              }
            : {
                title: "Approved, but the files changed again",
                description: "Review what they add now.",
                tone: "bad",
              },
      );
    },
    onError: (error) =>
      toast({
        title: "Decision failed",
        description: error.message,
        tone: "bad",
      }),
  });
  const busy = validate.isPending || reload.isPending || decide.isPending;

  return (
    <section className="grid gap-xl">
      <div className="flex flex-wrap items-start gap-md">
        <div className="grid gap-xs">
          <h1 className="text-heading font-semibold">Factory definition</h1>
          {data && (
            <p className="text-small text-muted">
              {data.dir}
              {data.running &&
                ` · ${data.running.schemaVersion} · loaded ${timeOfDay(data.running.loadedAt)}`}
            </p>
          )}
        </div>
        <div className="ml-auto flex flex-wrap gap-sm">
          {data?.mode === "repo" && (
            <AdoptDefinition slug={slug} dir={data.dir} />
          )}
          <button
            type="button"
            className="ghost flex items-center gap-sm"
            disabled={busy}
            onClick={() => validate.mutate()}
          >
            <Icon name="check-check" className="icon" />
            {validate.isPending ? "Validating…" : "Validate"}
          </button>
          <button
            type="button"
            className="primary flex items-center gap-sm"
            disabled={busy}
            onClick={() => reload.mutate()}
          >
            <Icon name="refresh" className="icon" />
            {reload.isPending ? "Reloading…" : "Reload definition"}
          </button>
        </div>
      </div>

      {!data ? (
        <p role="status" className="text-muted">
          {isError
            ? "Definition unavailable. Retrying…"
            : "Loading definition…"}
        </p>
      ) : (
        <>
          {data.pendingReach && (
            <section
              className="banner attention grid gap-sm"
              aria-label="Wider reach waits for approval"
            >
              <p className="font-semibold">
                These files let agents reach more than the running definition
                does. Nothing changes until you approve.
              </p>
              <ul className="grid gap-xs">
                {data.pendingReach.map((line) => (
                  <li key={line}>
                    <code>+ {line}</code>
                  </li>
                ))}
              </ul>
              <div className="flex flex-wrap gap-sm">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => decide.mutate(true)}
                >
                  Approve and apply
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy}
                  onClick={() => decide.mutate(false)}
                >
                  Reject
                </button>
              </div>
            </section>
          )}
          {data.errors.length > 0 && !data.pendingReach && (
            <ProblemBanner role="alert" tone="bad" problems={data.errors}>
              {data.running
                ? `Reload failed: ${plural(data.errors.length, "error")}. The last valid definition (${timeOfDay(data.running.loadedAt)}) is still running.`
                : `No valid definition is loaded: ${plural(data.errors.length, "error")}. The factory starts no work until a reload succeeds.`}
            </ProblemBanner>
          )}
          {validation && (
            <ProblemBanner
              role="status"
              tone={validation.ok ? "ok" : "bad"}
              problems={validation.errors}
              onDismiss={() => setValidation(null)}
            >
              {validation.ok
                ? "Validation passed. Nothing was applied; Reload definition applies the files on disk."
                : `Validation found ${plural(validation.errors.length, "error")}. Nothing was applied.`}
            </ProblemBanner>
          )}
          {data.security.length > 0 && (
            <section aria-label="Security warnings" className="banner bad">
              <div className="flex items-start gap-sm">
                <Icon name="circle-alert" className="icon" />
                <p className="font-semibold">
                  Agents have more power than they should
                </p>
              </div>
              <ul className="grid gap-xs">
                {data.security.map((warning) => (
                  <li key={warning} className="problem">
                    {warning}
                  </li>
                ))}
              </ul>
            </section>
          )}
          <div className="definition-body">
            <div className="grid content-start gap-lg">
              <Box title="Repositories">
                {data.repositories.length === 0 && (
                  <p className="box-row text-muted">No repositories.</p>
                )}
                {data.repositories.map((repo) => (
                  <Repository key={repo.slug} repo={repo} />
                ))}
                <p className="box-row flex-wrap">
                  <Icon name="key-round" className="icon" />
                  <span className="text-muted">Agents push with</span>
                  <span>
                    {data.agentToken.source === "none"
                      ? "no token: docker agent runs fail"
                      : data.agentToken.label}
                  </span>
                </p>
              </Box>
              <Box title="agentDefaults">
                {data.agentDefaults.map((row) => (
                  <div key={row.key} className="box-row">
                    <span className="w-key shrink-0 text-muted">{row.key}</span>
                    <span>{row.value}</span>
                  </div>
                ))}
              </Box>
              <Box title="mcpServers">
                {data.mcpServers.length === 0 && (
                  <p className="box-row text-muted">No MCP servers.</p>
                )}
                {data.mcpServers.map((server) => (
                  <div key={server.name} className="box-row">
                    <span className="w-key shrink-0">{server.name}</span>
                    <span className="text-muted">
                      {server.kind} · {server.target}
                    </span>
                  </div>
                ))}
              </Box>
            </div>
            <div className="grid content-start gap-lg">
              <Box title="Files">
                <ul aria-label="Definition files">
                  {data.files.map((file) => (
                    <li
                      key={file.path}
                      className={[
                        "file box-row",
                        `depth-${file.depth}`,
                        file.error && "broken",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                    >
                      <Icon
                        name={file.kind === "folder" ? "folder" : "file-text"}
                        className="icon"
                      />
                      <span>{file.label}</span>
                      {file.error && (
                        <span className="sr-only">(has errors)</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Box>
              <p className="flex gap-sm rounded-control bg-surface-muted p-md text-small">
                <Icon name="commit" className="icon" />
                Edit these files on disk and commit them with git. Validate
                checks them; Reload definition applies them. Nakara never pushes
                the definition.
              </p>
            </div>
          </div>
          {data.warnings.length > 0 && (
            <Box title="Warnings">
              {data.warnings.map((warning, index) => (
                <p
                  key={problemKey(warning, index)}
                  className="box-row text-small"
                >
                  <code>{problemLocation(warning)}</code>
                  <span className="text-muted">{warning.message}</span>
                </p>
              ))}
            </Box>
          )}
        </>
      )}
    </section>
  );
}

function ProblemBanner({
  role,
  tone,
  problems,
  onDismiss,
  children,
}: {
  /** A failed reload is an alert; a validation result is a status. */
  role: "alert" | "status";
  tone: "ok" | "bad";
  problems: Problem[];
  onDismiss?: () => void;
  children: string;
}) {
  return (
    <div role={role} className={`banner ${tone}`}>
      <div className="flex items-start gap-sm">
        <Icon
          name={tone === "bad" ? "circle-alert" : "check-check"}
          className="icon"
        />
        <p className="font-semibold">{children}</p>
        {onDismiss && (
          <button
            type="button"
            className="ml-auto"
            aria-label="Dismiss"
            onClick={onDismiss}
          >
            ×
          </button>
        )}
      </div>
      {problems.length > 0 && (
        <ul className="grid gap-xs">
          {problems.map((problem, index) => (
            <li key={problemKey(problem, index)} className="problem">
              <code>{problemLocation(problem)}</code> {problem.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Box({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="box" aria-label={title}>
      <h2 className="box-row font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function Repository({ repo }: { repo: Definition["repositories"][number] }) {
  const status =
    repo.state === "cloned"
      ? `cloned · fetched ${relativeTime(repo.fetchedAt ?? "")}`
      : repo.state === "error"
        ? repo.error
        : repo.state === "deferred"
          ? "deferred · cloned when an item needs it"
          : "not checked yet";
  return (
    <div className="box-row flex-wrap">
      <Icon name="github" className="icon" />
      <span className="repo-slug">{repo.slug}</span>
      {repo.defaultBranch && (
        <span className="text-muted">{repo.defaultBranch}</span>
      )}
      <span className={`repo-status ${repo.state}`}>
        <span className="dot" aria-hidden="true" />
        {status}
      </span>
    </div>
  );
}
