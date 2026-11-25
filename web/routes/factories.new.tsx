import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  useCanGoBack,
  useRouter,
} from "@tanstack/react-router";
import { type ReactNode, useState } from "react";
import type { AgentTokenDto } from "../../src/web/api.ts";
import {
  startCreation,
  wizardAccessQuery,
  wizardGithubQuery,
  wizardNameQuery,
  wizardReposQuery,
} from "../lib/api";
import { relativeTime } from "../lib/format";
import { Icon } from "../ui/icons";
import { useChangeEvents } from "../app/live-events";
import {
  Agents,
  Creation,
  DefinitionSource,
  Heading,
  Intake,
  Review,
  useDebounced,
  usePreview,
} from "../features/wizard/wizard-steps";
import {
  AVATAR_COLORS,
  creationBody,
  HANDLE,
  LAST_STEP,
  matchRepos,
  STEPS,
  type WizardSearch,
  wizardSearch,
} from "../features/wizard/wizard-state";

export const Route = createFileRoute("/factories/new")({
  validateSearch: wizardSearch,
  staticData: { title: "New factory", bare: true },
  component: Wizard,
});

function Wizard() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();
  useChangeEvents();
  // Every change replaces the URL: × and the browser's Back leave the wizard.
  const update = (change: Partial<WizardSearch>) =>
    void navigate({
      search: (prev) => ({ ...prev, ...change }),
      replace: true,
    });
  const close = () => {
    if (canGoBack) router.history.back();
    else void navigate({ to: "/" });
  };
  const step = search.step ?? 1;
  const github = useQuery(wizardGithubQuery);
  const login = github.data?.login;
  const owner = search.owner ?? login?.account ?? undefined;
  const repos = search.repos ?? [];
  // Typed text lives in the page while the URL follows it, so the caret stays put.
  const [name, setName] = useState(search.name ?? "");
  const [description, setDescription] = useState(search.description ?? "");
  const checkedName = useDebounced(name.trim(), 250);
  const nameCheck = useQuery({
    ...wizardNameQuery(checkedName),
    // Once Create started, the name is the new factory's own.
    enabled: step >= 2 && checkedName !== "" && !search.job,
    placeholderData: keepPreviousData,
  });
  const nameOk =
    nameCheck.data?.name === name.trim() && nameCheck.data.available;
  const body = creationBody(search);
  const preview = usePreview(step >= 3 && !search.job ? body : null);
  const previewOk = Boolean(preview.data?.ok && preview.current);
  const handle = search.handle ?? nameCheck.data?.handle ?? "";
  const create = useMutation({
    mutationFn: startCreation,
    onSuccess: (job) => update({ job: job.id }),
  });
  const canNext =
    step === 1
      ? Boolean(login?.loggedIn && owner)
      : step === 2
        ? repos.length > 0 && nameOk
        : step === 3
          ? previewOk
          : step === 4
            ? !search.handle || HANDLE.test(search.handle)
            : step === 5;
  // Steps 3 to 6 build on the repositories and the name.
  const ready = step < 3 || (repos.length > 0 && nameOk);

  return (
    <main className="wizard">
      <div className="wizard-top">
        <div
          className="wizard-progress"
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={STEPS.length}
          aria-valuenow={step}
          aria-valuetext={`Step ${step} of ${STEPS.length}: ${STEPS[step - 1]}`}
        >
          {STEPS.map((label, index) => (
            <span key={label} className={index < step ? "done" : undefined} />
          ))}
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="Close the wizard"
          onClick={close}
        >
          <Icon name="x" className="h-lg w-lg" />
        </button>
      </div>
      {step === 1 && (
        <CodeHost owner={owner} onOwner={(o) => update({ owner: o })} />
      )}
      {step === 2 && owner && (
        <Repositories
          owner={owner}
          repos={repos}
          onRepos={(next) => update({ repos: next.length ? next : undefined })}
        >
          <FactoryDetails
            name={name}
            onName={(value) => {
              setName(value);
              update({ name: value || undefined });
            }}
            check={
              checkedName === name.trim() && name.trim()
                ? nameCheck.data
                : undefined
            }
            checkError={nameCheck.error?.message}
            description={description}
            onDescription={(value) => {
              setDescription(value);
              update({ description: value || undefined });
            }}
            color={search.color ?? AVATAR_COLORS[0]}
            onColor={(color) => update({ color })}
          />
        </Repositories>
      )}
      {step === 2 && !owner && (
        <p role="status" className="text-muted">
          {github.isPending
            ? "Checking gh…"
            : "Go back and connect GitHub first."}
        </p>
      )}
      {step >= 3 && !ready && !search.job && (
        <p role="status" className="text-muted">
          {nameCheck.isFetching && repos.length > 0
            ? "Checking the name…"
            : "Go back and pick the repositories and a name that is free first."}
        </p>
      )}
      {step === 3 && ready && (
        <DefinitionSource search={search} update={update} preview={preview} />
      )}
      {step === 4 && ready && (
        <Agents
          search={search}
          update={update}
          suggestedHandle={nameCheck.data?.handle ?? ""}
        />
      )}
      {step === 5 && ready && <Intake search={search} update={update} />}
      {step === 6 && search.job && (
        <Creation id={search.job} onEdit={() => update({ job: undefined })} />
      )}
      {step === 6 && ready && !search.job && (
        <Review
          search={search}
          update={update}
          preview={preview}
          handle={handle}
        />
      )}
      {!search.job && (
        <div className="wizard-foot">
          <button
            type="button"
            className="ghost flex items-center gap-xs"
            disabled={step === 1 || create.isPending}
            onClick={() => update({ step: step - 1 })}
          >
            <Icon name="arrow-left" className="h-lg w-lg" />
            Back
          </button>
          {create.isError && (
            <p role="alert" className="form-error flex-1">
              {create.error.message}
            </p>
          )}
          {step < LAST_STEP ? (
            <button
              type="button"
              className="primary"
              disabled={!canNext || !ready}
              // Keep the owner the step defaulted to, so a reload lists the same repositories.
              onClick={() => update({ step: step + 1, owner })}
            >
              Next
            </button>
          ) : (
            <button
              type="button"
              className="primary"
              disabled={!ready || !previewOk || !body || create.isPending}
              onClick={() => body && create.mutate(body)}
            >
              {create.isPending ? "Creating…" : "Create factory"}
            </button>
          )}
        </div>
      )}
    </main>
  );
}

function CodeHost({
  owner,
  onOwner,
}: {
  owner: string | undefined;
  onOwner: (owner: string) => void;
}) {
  const github = useQuery(wizardGithubQuery);
  const login = github.data?.login;
  return (
    <>
      <Heading title="Connect your code host">
        Nakara works through the GitHub CLI on this machine. Agents get a
        separate fine-grained token.
      </Heading>
      <section className="wizard-card" aria-label="Code host">
        {github.isPending && <p role="status">Checking gh…</p>}
        {github.isError && (
          <div role="alert" className="banner bad">
            <p>{github.error.message}</p>
            <Recheck
              busy={github.isFetching}
              onClick={() => void github.refetch()}
            />
          </div>
        )}
        {github.data && login && (
          <>
            <div className={`wizard-host ${login.loggedIn ? "connected" : ""}`}>
              <span className="wizard-logo">
                <Icon name="github" className="h-xl w-xl" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">GitHub</p>
                <p className="text-small text-muted">
                  {login.loggedIn
                    ? `gh: logged in as ${login.account}${login.detail ? ` (${login.detail})` : ""}`
                    : `gh: ${login.detail}`}
                </p>
              </div>
              {login.loggedIn ? (
                <span className="chip bg-handoff-soft text-handoff">
                  <Icon name="check" className="h-icon w-icon" />
                  Connected
                </span>
              ) : (
                <span className="chip bg-bad-bg text-bad">Not logged in</span>
              )}
            </div>
            {!login.loggedIn && (
              <div role="alert" className="banner attention">
                <p className="flex items-start gap-sm">
                  <Icon name="info" className="icon" />
                  <span>
                    gh is not logged in. Run <code>gh auth login</code> on the
                    machine Nakara runs on, then Recheck.
                  </span>
                </p>
                <Recheck
                  busy={github.isFetching}
                  onClick={() => void github.refetch()}
                />
              </div>
            )}
            {login.loggedIn && (
              <label className="field">
                <span className="field-label">Owner or organization</span>
                <select
                  className="input"
                  value={owner ?? ""}
                  onChange={(event) => onOwner(event.target.value)}
                >
                  {github.data.owners.map((o) => (
                    <option key={o.login} value={o.login}>
                      {o.login} (
                      {o.kind === "user" ? "personal" : "organization"})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <AgentToken token={github.data.agentToken} />
          </>
        )}
        <div className="flex flex-wrap gap-md">
          {(
            [
              ["gitlab", "GitLab"],
              ["cloud", "Azure DevOps"],
            ] as const
          ).map(([icon, label]) => (
            <div
              key={label}
              className="flex flex-1 items-center gap-sm rounded-control border border-line p-md text-small"
            >
              <Icon name={icon} className="h-lg w-lg text-muted" />
              <span className="flex-1">{label}</span>
              <span className="text-tiny text-muted">Not yet</span>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

function Recheck({ busy, onClick }: { busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      className="ghost justify-self-start"
      disabled={busy}
      onClick={onClick}
    >
      {busy ? "Checking…" : "Recheck"}
    </button>
  );
}

/** The agent token's chip: its label and tone. */
const tokenChip = (token: AgentTokenDto): [string, string] =>
  token.state === "set"
    ? token.fineGrained
      ? ["Set · fine-grained", "bg-handoff-soft text-handoff"]
      : ["Set · classic", "bg-attention-soft text-attention"]
    : ["Not set · gh login", "bg-attention-soft text-attention"];

function AgentToken({ token }: { token: AgentTokenDto }) {
  const [label, tone] = tokenChip(token);
  return (
    <section
      className="grid gap-sm rounded-control bg-surface-muted p-lg"
      aria-label="Agent token"
    >
      <p className="flex items-center gap-sm text-small">
        <Icon name="key-round" className="h-icon w-icon" />
        <span className="flex-1">
          Agent token (<code>NAKARA_AGENT_GH_TOKEN</code>)
        </span>
        <span className={`chip text-tiny ${tone}`}>{label}</span>
      </p>
      <p className="text-small">
        {token.state === "set"
          ? "Agents push and open PRs with this token, not your gh login. It must include every repository you pick in the next step (Contents, Pull requests, Issues: read/write)."
          : "Not set: agents running outside Docker push and open PRs with your gh login, so the repositories you pick in the next step are checked with it. To limit them, set a fine-grained token for those repositories (Contents, Pull requests, Issues: read/write) in Nakara's environment and restart Nakara."}
        {token.state === "set" &&
          !token.fineGrained &&
          " A classic token reaches every repository you can; prefer a fine-grained one."}
      </p>
    </section>
  );
}

function Repositories({
  owner,
  repos,
  onRepos,
  children,
}: {
  owner: string;
  repos: string[];
  onRepos: (repos: string[]) => void;
  children: ReactNode;
}) {
  const [filter, setFilter] = useState("");
  const tokenSet = useQuery(wizardGithubQuery).data?.agentToken.state === "set";
  const list = useQuery(wizardReposQuery(owner));
  const access = useQuery({
    ...wizardAccessQuery(repos),
    enabled: repos.length > 0,
    placeholderData: keepPreviousData,
  });
  const hidden = (access.data?.repos ?? []).filter(
    (r) => !r.visible && repos.includes(r.repo),
  );
  const toggle = (repo: string) =>
    onRepos(
      repos.includes(repo) ? repos.filter((r) => r !== repo) : [...repos, repo],
    );
  const matches = matchRepos(list.data?.repos ?? [], filter);
  return (
    <>
      <Heading title="Set up your factory">
        One factory per product. If a product spans several repositories, give
        the factory all of them.
      </Heading>
      <section className="wizard-card" aria-label="Factory">
        <div className="grid gap-xs">
          <h2 className="font-semibold">Repositories the factory can access</h2>
          <p className="text-small text-muted">
            Agents get a worktree of each. Pick repos that ship together; don't
            split the same repositories across factories by team.
          </p>
        </div>
        {repos.length > 0 && (
          <ul
            className="flex flex-wrap gap-sm"
            aria-label="Selected repositories"
          >
            {repos.map((repo) => {
              const flagged = hidden.some((h) => h.repo === repo);
              return (
                <li
                  key={repo}
                  className={`chip py-xs ${flagged ? "bg-attention-soft text-attention" : "bg-accent-soft text-accent"}`}
                >
                  {flagged && (
                    <Icon name="circle-alert" className="h-icon w-icon" />
                  )}
                  {repo}
                  <button
                    type="button"
                    className="flex"
                    aria-label={`Remove ${repo}`}
                    onClick={() => toggle(repo)}
                  >
                    <Icon name="x" className="h-icon w-icon" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {hidden.length > 0 && (
          <div role="alert" className="banner attention">
            <p className="flex items-start gap-sm font-semibold">
              <Icon name="circle-alert" className="icon" />
              Agents can't reach{" "}
              {hidden.length === 1
                ? "this repository"
                : `${hidden.length} of these repositories`}
            </p>
            <ul className="grid gap-xs">
              {hidden.map((h) => (
                <li key={h.repo}>{h.message}</li>
              ))}
            </ul>
            <p>
              {tokenSet
                ? "Give the agent token access (Contents, Pull requests, Issues: read/write) before the first run, or their runs fail."
                : "Agents running outside Docker push with your gh login; it needs push access to these repositories before the first run."}
            </p>
          </div>
        )}
        <div className="flex items-center gap-sm rounded-control border border-line px-md py-sm">
          <Icon name="search" className="h-lg w-lg text-muted" />
          <input
            className="min-w-0 flex-1 bg-bg text-body outline-none"
            aria-label="Search repositories"
            placeholder={`Search ${owner}'s repositories`}
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <button
            type="button"
            className="icon-button"
            aria-label="Refresh the repository list"
            disabled={list.isFetching}
            onClick={() => void list.refetch()}
          >
            <Icon name="refresh" className="h-icon w-icon" />
          </button>
        </div>
        <div className="grid gap-xs">
          {list.isPending && <p role="status">Listing repositories…</p>}
          {list.isError && (
            <p role="alert" className="form-error">
              {list.error.message}
            </p>
          )}
          {list.data && (
            <ul className="wizard-results" aria-label="Repositories">
              {matches.length === 0 && (
                <li className="px-md py-sm text-small text-muted">
                  No repository of {owner} matches.
                </li>
              )}
              {matches.map((r) => (
                <li key={r.repo}>
                  <label className="wizard-option">
                    <input
                      type="checkbox"
                      checked={repos.includes(r.repo)}
                      onChange={() => toggle(r.repo)}
                    />
                    <span className="grid min-w-0">
                      <span>{r.repo}</span>
                      <span className="text-small text-muted">
                        {[
                          r.private ? "private" : "public",
                          r.language,
                          `updated ${relativeTime(r.updatedAt)}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-small text-muted">
            Missing a repo? gh lists the repositories {owner} owns that your
            login can see; pick another owner in the previous step.
          </p>
        </div>
        {children}
      </section>
    </>
  );
}

function FactoryDetails({
  name,
  onName,
  check,
  checkError,
  description,
  onDescription,
  color,
  onColor,
}: {
  name: string;
  onName: (name: string) => void;
  check:
    | {
        slug: string;
        handle: string;
        available: boolean;
        message: string | null;
      }
    | undefined;
  checkError: string | undefined;
  description: string;
  onDescription: (description: string) => void;
  color: string;
  onColor: (color: string) => void;
}) {
  return (
    <>
      <div className="flex items-start gap-md">
        <span
          className="wizard-avatar"
          style={{ backgroundColor: color }}
          aria-hidden="true"
        >
          {name.trim().charAt(0).toUpperCase() || "?"}
        </span>
        <label className="field flex-1">
          <span className="field-label">
            Factory name
            <span className="field-hint">
              also the foreman's default @handle
            </span>
          </span>
          <input
            className="input"
            value={name}
            autoComplete="off"
            aria-invalid={check ? !check.available : undefined}
            aria-describedby="factory-name-check"
            onChange={(event) => onName(event.target.value)}
          />
          <span id="factory-name-check" className="text-small">
            {checkError ? (
              <span role="alert" className="text-bad">
                {checkError}
              </span>
            ) : check?.available ? (
              <span className="text-muted">
                Slug <code>{check.slug}</code> · pages at{" "}
                <code>/f/{check.slug}</code> · foreman{" "}
                <code>@{check.handle}</code>
              </span>
            ) : check?.message ? (
              <span role="alert" className="text-bad">
                {check.message}
              </span>
            ) : null}
          </span>
        </label>
      </div>
      <label className="field">
        <span className="field-label">
          Description <span className="field-hint">optional</span>
        </span>
        <input
          className="input"
          value={description}
          onChange={(event) => onDescription(event.target.value)}
        />
      </label>
      <fieldset className="grid gap-sm">
        <legend className="field-label mb-sm">Avatar color</legend>
        <div className="flex flex-wrap gap-md">
          {AVATAR_COLORS.map((c) => (
            <label
              key={c}
              className="wizard-swatch"
              style={{ backgroundColor: c }}
            >
              <input
                type="radio"
                name="avatar-color"
                aria-label={c}
                value={c}
                checked={color === c}
                onChange={() => onColor(c)}
              />
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
}
