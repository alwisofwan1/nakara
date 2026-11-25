// The New factory wizard's steps 3 to 6: definition source, agents, intake,
// and review and create with the creation job's progress.
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import type { CreationDto, TemplateInfo } from "../../../src/web/api.ts";
import {
  type CreationBody,
  creationQuery,
  retryCreation,
  wizardExamplesQuery,
  wizardPreviewQuery,
  wizardTemplateQuery,
} from "../../lib/api";
import { Icon } from "../../ui/icons";
import { defaultFactory, serverUrl } from "../../app/runtime";
import {
  DEFAULT_CRON,
  DEFAULT_FOLDER,
  definitionRepo,
  FOLDER,
  HANDLE,
  HARNESSES,
  type Harness,
  LOCKED_ROLES,
  type Role,
  type TemplateKind,
  templateOf,
  type WizardSearch,
} from "./wizard-state";

/** The example the Warp template uses unless another is chosen. */
const DEFAULT_EXAMPLE = "00-warp-default-agents";

type Update = (change: Partial<WizardSearch>) => void;

/** Shown until typing pauses, so a check runs once per pause. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/** Text typed into a field: kept in the page so the caret stays put, while the URL follows it. */
function useTyped(
  value: string | undefined,
  onChange: (value: string | undefined) => void,
) {
  const [text, setText] = useState(value ?? "");
  return [
    text,
    (next: string) => {
      setText(next);
      onChange(next || undefined);
    },
  ] as const;
}

export function Heading({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="grid gap-xs">
      <h1 className="text-heading font-semibold">{title}</h1>
      <p className="text-muted">{children}</p>
    </div>
  );
}

/** The preview of what Create writes, refetched once typing pauses. */
export function usePreview(body: CreationBody | null) {
  const debounced = useDebounced(body, 300);
  const current = JSON.stringify(debounced) === JSON.stringify(body);
  const preview = useQuery({
    ...wizardPreviewQuery(debounced as CreationBody),
    enabled: debounced !== null,
    placeholderData: keepPreviousData,
  });
  return { ...preview, current: current && !preview.isPlaceholderData };
}

export function useTemplate(search: WizardSearch) {
  const choice = templateOf(search);
  return useQuery({
    ...wizardTemplateQuery(choice ?? { kind: "nakara" }),
    enabled: choice !== undefined,
    retry: false,
  });
}

/** The intake a source starts with: an import keeps its automations, a template gets the GitHub label. */
export function intakeOf(
  search: WizardSearch,
  template: TemplateInfo | undefined,
) {
  const imported = search.template === "import";
  const base =
    imported && template ? template.intake : { github: true, schedule: null };
  return {
    github: search.github ?? base.github,
    cron:
      search.cron === undefined
        ? (base.schedule ?? undefined)
        : search.cron || undefined,
  };
}

const TEMPLATE_CHOICES: {
  kind: TemplateKind;
  label: string;
  hint: string;
}[] = [
  {
    kind: "nakara",
    label: "Nakara default",
    hint: "Foreman + triage, spec, implement, review. Matches what runs today.",
  },
  {
    kind: "warp",
    label: "Warp example",
    hint: "One of the trees in warp-factory-examples (bug-fix, docs, dependency updates…).",
  },
  {
    kind: "import",
    label: "Import existing",
    hint: "A folder on this machine that already has factory.yaml. Validated before Next.",
  },
  {
    kind: "blank",
    label: "Blank",
    hint: "Only factory.yaml and a foreman. Add agents later.",
  },
];
export const templateLabel = (search: WizardSearch) => {
  const kind = search.template ?? "nakara";
  const label = TEMPLATE_CHOICES.find((t) => t.kind === kind)?.label ?? kind;
  if (kind === "warp") return `${label} ${search.example ?? "(default)"}`;
  if (kind === "import") return `${label} from ${search.from ?? "?"}`;
  return label;
};

function Problems({
  title,
  problems,
  tone,
}: {
  title: string;
  problems: { path: string; message: string }[];
  tone: "bad" | "attention";
}) {
  if (problems.length === 0) return null;
  return (
    <div role="alert" className={`banner ${tone}`}>
      <p className="flex items-start gap-sm font-semibold">
        <Icon name="circle-alert" className="icon" />
        {title}
      </p>
      <ul className="grid gap-xs">
        {problems.map((p) => (
          <li key={`${p.path}:${p.message}`}>
            <code>{p.path}</code>: {p.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function DefinitionSource({
  search,
  update,
  preview,
}: {
  search: WizardSearch;
  update: Update;
  preview: ReturnType<typeof usePreview>;
}) {
  const kind = search.template ?? "nakara";
  const repos = search.repos ?? [];
  const examples = useQuery({
    ...wizardExamplesQuery,
    enabled: kind === "warp",
  });
  const [from, setFrom] = useTyped(search.from, (value) =>
    update({ from: value }),
  );
  const [folder, setFolder] = useTyped(search.folder, (value) =>
    update({ folder: value }),
  );
  const repo = definitionRepo(search);
  const folderOk = FOLDER.test(folder || DEFAULT_FOLDER);
  return (
    <>
      <Heading title="Where does the definition live?">
        Agents, automations and runners are files (Warp v1alpha1 format). Pick a
        starting point and where to keep them.
      </Heading>
      <section className="wizard-card" aria-label="Definition source">
        <fieldset className="grid gap-sm">
          <legend className="field-label mb-sm">Start from</legend>
          {TEMPLATE_CHOICES.map((t) => (
            <label key={t.kind} className="wizard-option">
              <input
                type="radio"
                name="template"
                checked={kind === t.kind}
                onChange={() => update({ template: t.kind })}
              />
              <span className="grid min-w-0">
                <span>{t.label}</span>
                <span className="text-small text-muted">{t.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {kind === "warp" &&
          (examples.isError ? (
            <p role="alert" className="form-error">
              {examples.error.message}
            </p>
          ) : (
            <label className="field">
              <span className="field-label">Example</span>
              <select
                className="input"
                value={search.example ?? DEFAULT_EXAMPLE}
                disabled={!examples.data}
                onChange={(event) => update({ example: event.target.value })}
              >
                {(examples.data?.examples ?? [DEFAULT_EXAMPLE]).map(
                  (example) => (
                    <option key={example} value={example}>
                      {example}
                    </option>
                  ),
                )}
              </select>
            </label>
          ))}
        {kind === "import" && (
          <label className="field">
            <span className="field-label">
              Folder to import
              <span className="field-hint">absolute path on this machine</span>
            </span>
            <input
              className="input"
              value={from}
              placeholder="/home/you/factory"
              autoComplete="off"
              onChange={(event) => setFrom(event.target.value)}
            />
          </label>
        )}
        <fieldset className="grid gap-sm">
          <legend className="field-label mb-sm">Keep it in</legend>
          <label className="wizard-option">
            <input
              type="radio"
              name="location"
              checked={search.location !== "repo"}
              onChange={() => update({ location: undefined })}
            />
            <span className="grid min-w-0">
              <span>Nakara-managed</span>
              <span className="text-small text-muted">
                Edit on the web. Kept in Nakara's data directory.
              </span>
            </span>
          </label>
          <label className="wizard-option">
            <input
              type="radio"
              name="location"
              checked={search.location === "repo"}
              onChange={() => update({ location: "repo" })}
            />
            <span className="grid min-w-0">
              <span>A repository folder</span>
              <span className="text-small text-muted">
                Git-tracked with your code. Nakara writes the folder into a
                clone of the repository on this machine; you commit and push it.
              </span>
            </span>
          </label>
        </fieldset>
        {search.location === "repo" && (
          <div className="field-row">
            <label className="field">
              <span className="field-label">Repository</span>
              <select
                className="input"
                value={repo ?? ""}
                onChange={(event) => update({ defRepo: event.target.value })}
              >
                {repos.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Folder</span>
              <input
                className="input"
                value={folder}
                placeholder={DEFAULT_FOLDER}
                autoComplete="off"
                aria-invalid={!folderOk}
                onChange={(event) => setFolder(event.target.value)}
              />
              {!folderOk && (
                <span role="alert" className="text-small text-bad">
                  A relative path such as factory or ops/factory.
                </span>
              )}
            </label>
          </div>
        )}
        {search.location === "repo" && repo && (
          <RepoNote repo={repo} dir={preview.data?.dir} />
        )}
        <PreviewStatus preview={preview} />
      </section>
    </>
  );
}

/** Where the definition goes, and whether the tree validates, for step 3. */
/** A definition kept in a repository is committed and pushed by the operator, not by Nakara. */
function RepoNote({ repo, dir }: { repo: string; dir: string | undefined }) {
  return (
    <div role="note" className="banner attention">
      <p className="flex items-start gap-sm">
        <Icon name="info" className="icon" />
        <span>
          Nakara writes the definition into its own clone of {repo}
          {dir && (
            <>
              {" "}
              at <code className="break-all">{dir}</code>
            </>
          )}
          , and does not commit or push it. Commit and push that folder yourself
          to keep it with your code; until then it exists only on this machine.
        </span>
      </p>
    </div>
  );
}

function PreviewStatus({
  preview,
}: {
  preview: ReturnType<typeof usePreview>;
}) {
  if (preview.isError)
    return (
      <p role="alert" className="form-error">
        {preview.error.message}
      </p>
    );
  if (!preview.data || !preview.current)
    return (
      <p role="status" className="text-small text-muted">
        Validating…
      </p>
    );
  return (
    <>
      <p className="flex flex-wrap items-center gap-sm text-small text-muted">
        {preview.data.ok && (
          <span className="chip bg-handoff-soft text-handoff">
            <Icon name="check" className="h-icon w-icon" />
            Validated
          </span>
        )}
        Written to <code className="break-all">{preview.data.dir}</code>
      </p>
      <Problems
        title="The definition does not validate"
        problems={preview.data.errors}
        tone="bad"
      />
    </>
  );
}

const ROLE_COPY: Record<Role, string> = {
  foreman: "Owns every work item and dispatches the agents below.",
  triage: "Checks if a request is new, a duplicate or already done.",
  spec: "Writes a spec for your approval before code changes.",
  implement: "Builds the change and opens a draft PR. Required.",
  review: "One read-only adversarial review of the PR.",
};
const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Agents({
  search,
  update,
  suggestedHandle,
}: {
  search: WizardSearch;
  update: Update;
  suggestedHandle: string;
}) {
  const template = useTemplate(search);
  const [handle, setHandle] = useTyped(search.handle, (value) =>
    update({ handle: value }),
  );
  const handleOk = !handle || HANDLE.test(handle);
  const toggle = (role: Role, on: boolean) => {
    const off = (search.off ?? []).filter((r) => r !== role);
    update({ off: on ? (off.length ? off : undefined) : [...off, role] });
  };
  const choose = (role: Role, harness: Harness, original: string) => {
    const { [role]: _, ...rest } = search.harness ?? {};
    const next = harness === original ? rest : { ...rest, [role]: harness };
    update({ harness: Object.keys(next).length ? next : undefined });
  };
  return (
    <>
      <Heading title="Configure your factory agents">
        You talk to a foreman that delegates to specialized agents for triage,
        specs, code and review.
      </Heading>
      <section className="wizard-card" aria-label="Agents">
        <label className="field">
          <span className="field-label">
            What do you want to call your foreman?
          </span>
          <span className="flex items-center gap-xs">
            <span className="text-muted">@</span>
            <input
              className="input flex-1"
              value={handle}
              placeholder={suggestedHandle}
              autoComplete="off"
              aria-invalid={!handleOk}
              aria-describedby="foreman-handle-hint"
              onChange={(event) => setHandle(event.target.value)}
            />
          </span>
          <span id="foreman-handle-hint" className="text-small text-muted">
            {handleOk ? (
              <>
                The foreman's name in this factory. Its GitHub label is{" "}
                <code>factory:{search.name?.trim()}</code>. Telegram can't
                address a factory by handle yet: its messages go to the default
                factory.
              </>
            ) : (
              <span role="alert" className="text-bad">
                Lowercase letters, digits and inner dashes, at most 40.
              </span>
            )}
          </span>
        </label>
        {template.isPending && <p role="status">Reading the template…</p>}
        {template.isError && (
          <p role="alert" className="form-error">
            {template.error.message}
          </p>
        )}
        {template.data && (
          <ul className="grid gap-sm" aria-label="Template agents">
            {template.data.agents.map((agent) => {
              const role = agent.role;
              const locked = !role || LOCKED_ROLES.includes(role);
              const on = !role || !search.off?.includes(role);
              const harness = (role && search.harness?.[role]) ?? agent.harness;
              const label = capitalize(agent.name);
              return (
                <li
                  key={agent.name}
                  className={`wizard-agent ${on ? "" : "off"}`}
                >
                  <input
                    type="checkbox"
                    role="switch"
                    className="automation-switch shrink-0"
                    aria-label={`${label} enabled`}
                    aria-checked={on}
                    checked={on}
                    disabled={locked}
                    title={locked ? "Always on" : undefined}
                    onChange={(event) =>
                      role && toggle(role, event.target.checked)
                    }
                  />
                  <span className="grid min-w-0 flex-1">
                    <span className="font-semibold">{label}</span>
                    <span className="text-small text-muted">
                      {(role && ROLE_COPY[role]) ||
                        agent.description ||
                        "A custom agent of the template; always on."}
                    </span>
                  </span>
                  {role ? (
                    <select
                      className="input w-auto"
                      aria-label={`${label} harness`}
                      value={harness}
                      disabled={!on}
                      onChange={(event) =>
                        choose(
                          role,
                          event.target.value as Harness,
                          agent.harness,
                        )
                      }
                    >
                      {HARNESSES.map((h) => (
                        <option key={h} value={h}>
                          {h === agent.harness && agent.model
                            ? `${h} · ${agent.model}`
                            : h}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="text-small text-muted">
                      {[agent.harness, agent.model].filter(Boolean).join(" · ")}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </>
  );
}

function Source({
  icon,
  title,
  children,
  meta,
  control,
}: {
  icon: Parameters<typeof Icon>[0]["name"];
  title: string;
  children: ReactNode;
  meta?: ReactNode;
  control: ReactNode;
}) {
  return (
    <li className="wizard-agent">
      <Icon name={icon} className="h-lg w-lg shrink-0 text-muted" />
      <span className="grid min-w-0 flex-1 gap-xs">
        <span className="font-semibold">{title}</span>
        <span className="text-small text-muted">{children}</span>
        {meta && <span className="text-small">{meta}</span>}
      </span>
      {control}
    </li>
  );
}

export function Intake({
  search,
  update,
}: {
  search: WizardSearch;
  update: Update;
}) {
  const template = useTemplate(search);
  const intake = intakeOf(search, template.data);
  const [cron, setCron] = useTyped(
    typeof search.cron === "string" ? search.cron : intake.cron,
    // An emptied field keeps the last cron; Review validates it.
    (value) => value && update({ cron: value }),
  );
  const toggle = (
    label: string,
    on: boolean,
    change: (on: boolean) => void,
  ) => (
    <input
      type="checkbox"
      role="switch"
      className="automation-switch shrink-0"
      aria-label={label}
      aria-checked={on}
      checked={on}
      onChange={(event) => change(event.target.checked)}
    />
  );
  return (
    <>
      <Heading title="How does work reach the factory?">
        Each source becomes an automation file. You can add or change them later
        on the Automations page.
      </Heading>
      <section className="wizard-card" aria-label="Intake">
        <ul className="grid gap-sm">
          <Source
            icon="github"
            title="GitHub issues"
            meta={
              <>
                label: <code>factory:{search.name?.trim()}</code>
              </>
            }
            control={toggle("GitHub issues", intake.github, (on) =>
              update({ github: on }),
            )}
          >
            Label an issue to send it here. Nakara creates the label in every
            selected repository.
          </Source>
          <Source
            icon="send"
            title="Telegram"
            meta={
              <span className="chip bg-surface-muted text-muted">
                Default factory only (not yet)
              </span>
            }
            control={
              <input
                type="checkbox"
                role="switch"
                className="automation-switch shrink-0"
                aria-label="Telegram"
                aria-checked={false}
                checked={false}
                disabled
                title="Not yet: Telegram messages go to the default factory"
                readOnly
              />
            }
          >
            Messages to the bot become work items of the default factory,{" "}
            {defaultFactory.name}. Sending them to this factory is not available
            yet.
          </Source>
          <Source
            icon="clock"
            title="Schedule"
            meta={
              intake.cron !== undefined && (
                <label className="flex flex-wrap items-center gap-sm">
                  <span className="text-muted">Cron (UTC)</span>
                  <input
                    className="input w-auto font-mono"
                    aria-label="Cron schedule (UTC)"
                    value={cron}
                    onChange={(event) => setCron(event.target.value)}
                  />
                </label>
              )
            }
            control={toggle("Schedule", intake.cron !== undefined, (on) => {
              if (on) setCron(cron || DEFAULT_CRON);
              else update({ cron: false });
            })}
          >
            Recurring work such as a weekly health check.
          </Source>
          <Source
            icon="inbox"
            title="Web: New work"
            control={
              <span className="chip text-tiny text-muted">Always on</span>
            }
          >
            Send work from any page with New work.
          </Source>
          <Source
            icon="message-square"
            title="Slack / Linear"
            control={<span className="text-tiny text-muted">Not yet</span>}
          >
            Not yet supported.
          </Source>
        </ul>
      </section>
    </>
  );
}

function SummaryRow({
  label,
  value,
  onEdit,
}: {
  label: string;
  value: ReactNode;
  onEdit: () => void;
}) {
  return (
    <div className="wizard-summary-row">
      <dt className="text-small text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
      <button
        type="button"
        className="ghost"
        aria-label={`Edit ${label.toLowerCase()}`}
        onClick={onEdit}
      >
        Edit
      </button>
    </div>
  );
}

export function Review({
  search,
  update,
  preview,
  handle,
}: {
  search: WizardSearch;
  update: Update;
  preview: ReturnType<typeof usePreview>;
  handle: string;
}) {
  const template = useTemplate(search);
  const intake = intakeOf(search, template.data);
  const repo = definitionRepo(search);
  const agents = (template.data?.agents ?? [])
    .filter((a) => !a.role || !search.off?.includes(a.role))
    .map(
      (a) => `${a.name} (${(a.role && search.harness?.[a.role]) ?? a.harness})`,
    );
  const files = preview.data?.files ?? [];
  return (
    <>
      <Heading title="Review and create">
        Nakara writes the definition, validates it, then prepares each
        repository. Nothing runs until you send work.
      </Heading>
      <section className="wizard-card" aria-label="Summary">
        <dl className="grid gap-sm">
          <SummaryRow
            label="Factory"
            value={`${search.name?.trim()} · @${handle}`}
            onEdit={() => update({ step: 2 })}
          />
          <SummaryRow
            label="Repositories"
            value={(search.repos ?? []).join(", ")}
            onEdit={() => update({ step: 2 })}
          />
          <SummaryRow
            label="Definition"
            value={`${templateLabel(search)} · ${
              search.location === "repo"
                ? `${repo} : ${search.folder || DEFAULT_FOLDER}/`
                : "Nakara-managed"
            }`}
            onEdit={() => update({ step: 3 })}
          />
          <SummaryRow
            label="Agents"
            value={agents.join(", ") || "…"}
            onEdit={() => update({ step: 4 })}
          />
          <SummaryRow
            label="Intake"
            value={[
              intake.github && `GitHub label factory:${search.name?.trim()}`,
              intake.cron && `Schedule ${intake.cron}`,
              "Web",
            ]
              .filter(Boolean)
              .join(", ")}
            onEdit={() => update({ step: 5 })}
          />
        </dl>
        {preview.isError && (
          <p role="alert" className="form-error">
            {preview.error.message}
          </p>
        )}
        {preview.data && (
          <>
            {search.location === "repo" && repo && (
              <RepoNote repo={repo} dir={preview.data.dir} />
            )}
            <Problems
              title="Create is not possible yet"
              problems={preview.data.errors}
              tone="bad"
            />
            <Problems
              title="Warnings"
              problems={preview.data.warnings}
              tone="attention"
            />
            <div className="grid gap-xs">
              <h2 className="font-semibold">Files to write ({files.length})</h2>
              <p className="text-small text-muted">
                In <code className="break-all">{preview.data.dir}</code>
              </p>
              <ul className="wizard-files" aria-label="Files to write">
                {files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
              </ul>
            </div>
          </>
        )}
        {!preview.data && !preview.isError && (
          <p role="status" className="text-small text-muted">
            Preparing the files…
          </p>
        )}
      </section>
    </>
  );
}

const STEP_ICON: Record<
  CreationDto["steps"][number]["status"],
  [Parameters<typeof Icon>[0]["name"], string]
> = {
  pending: ["square", "text-muted"],
  running: ["refresh", "text-building"],
  done: ["circle-check", "text-handoff"],
  failed: ["circle-x", "text-bad"],
};

/** The creation job's steps; when it finishes, the new factory's Activity opens with New work. */
export function Creation({
  id,
  onEdit,
}: {
  id: string;
  /** Back to Review: Create again replaces the failed job and reuses its folder. */
  onEdit: () => void;
}) {
  const job = useQuery(creationQuery(id));
  const retry = useMutation({ mutationFn: () => retryCreation(id) });
  const slug = job.data?.status === "done" ? job.data.slug : undefined;
  useEffect(() => {
    // A full load: the shell lists the factories it was served with.
    if (slug)
      window.location.assign(
        serverUrl(`/f/${encodeURIComponent(slug)}/activity?new=1`),
      );
  }, [slug]);
  return (
    <>
      <Heading title={`Creating ${job.data?.name ?? "the factory"}`}>
        If a step fails, it shows the error with Retry; the steps before it are
        kept. Once done, the factory's Activity page opens with New work.
      </Heading>
      <section className="wizard-card" aria-label="Creation progress">
        {job.isError && (
          <p role="alert" className="form-error">
            {job.error.message}
          </p>
        )}
        <ol className="grid gap-sm">
          {job.data?.steps.map((step) => {
            const [icon, tone] = STEP_ICON[step.status];
            return (
              <li
                key={step.key}
                className="wizard-step"
                aria-label={`${step.label}: ${step.status}`}
              >
                <Icon
                  name={icon}
                  className={`h-lg w-lg shrink-0 ${tone} ${step.status === "running" ? "animate-spin" : ""}`}
                />
                <span className="grid min-w-0 flex-1 gap-xs">
                  <span className="font-semibold">{step.label}</span>
                  {step.detail && (
                    <span className="text-small break-words text-muted">
                      {step.detail}
                    </span>
                  )}
                  {step.error && (
                    <span
                      role="alert"
                      className="text-small break-words whitespace-pre-wrap text-bad"
                    >
                      {step.error}
                    </span>
                  )}
                </span>
                {step.status === "failed" && (
                  <button
                    type="button"
                    className="primary"
                    disabled={retry.isPending}
                    onClick={() => retry.mutate()}
                  >
                    Retry
                  </button>
                )}
              </li>
            );
          })}
        </ol>
        {job.data?.status === "failed" && (
          <p className="flex flex-wrap items-center gap-sm text-small text-muted">
            <button type="button" className="ghost" onClick={onEdit}>
              Change choices
            </button>
            Create again replaces this attempt and reuses its folder.
          </p>
        )}
        {retry.isError && (
          <p role="alert" className="form-error">
            {retry.error.message}
          </p>
        )}
        {job.data?.status === "done" && (
          <p role="status">Created. Opening {job.data.name}…</p>
        )}
      </section>
    </>
  );
}
