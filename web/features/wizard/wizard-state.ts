import type { CreationInput } from "../../../src/web/api.ts";

/** The New factory wizard's steps. */
export const STEPS = [
  "Code host",
  "Repositories and name",
  "Definition source",
  "Agents",
  "Intake",
  "Review and create",
] as const;
/** The last step that can be opened. */
export const LAST_STEP = STEPS.length;

/** Avatar colors to choose from; the first is Nakara's accent. */
export const AVATAR_COLORS = [
  "#6d4aff",
  "#2563eb",
  "#0e7490",
  "#15803d",
  "#b45309",
  "#c0267a",
  "#b91c1c",
  "#1a1a19",
] as const;

export const TEMPLATES = ["nakara", "warp", "import", "blank"] as const;
export type TemplateKind = (typeof TEMPLATES)[number];
export const ROLES = [
  "foreman",
  "triage",
  "spec",
  "implement",
  "review",
] as const;
export type Role = (typeof ROLES)[number];
/** The agents every factory keeps: work must be able to end in a pull request. */
export const LOCKED_ROLES: readonly Role[] = ["foreman", "implement"];
export const HARNESSES = ["claude", "codex", "qwen"] as const;
export type Harness = (typeof HARNESSES)[number];
export const DEFAULT_FOLDER = "factory";
export const DEFAULT_CRON = "0 6 * * 1";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const COLOR = /^#[0-9a-f]{6}$/i;
/** A foreman `@handle`, as the server checks it. */
export const HANDLE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;
/** A folder inside a repository, as the server checks it. */
export const FOLDER =
  /^(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Everything the wizard has chosen, kept in the URL query so a reload keeps it. */
export interface WizardSearch {
  step?: number | undefined;
  owner?: string | undefined;
  repos?: string[] | undefined;
  name?: string | undefined;
  description?: string | undefined;
  color?: string | undefined;
  /** Step 3: the template (Nakara default unless set) and where the definition lives. */
  template?: TemplateKind | undefined;
  example?: string | undefined;
  /** The folder an import reads. */
  from?: string | undefined;
  location?: "managed" | "repo" | undefined;
  /** The repository and folder of a definition kept in a repository. */
  defRepo?: string | undefined;
  folder?: string | undefined;
  /** Step 4: the foreman's handle, and each changed agent's toggle and harness. */
  handle?: string | undefined;
  off?: Role[] | undefined;
  harness?: Partial<Record<Role, Harness>> | undefined;
  /** Step 5: intake sources the operator changed; unset ones keep their default. */
  github?: boolean | undefined;
  /** A UTC cron, or false for no schedule. */
  cron?: string | false | undefined;
  /** Step 6: the creation job, once Create started it. */
  job?: string | undefined;
}

const text = (value: unknown, max: number) =>
  typeof value === "string" && value ? value.slice(0, max) : undefined;
const oneOf = <T extends string>(values: readonly T[], value: unknown) =>
  values.find((v) => v === value);
const flag = (value: unknown) =>
  typeof value === "boolean" ? value : undefined;

/** Parse the query; anything malformed is dropped, not rejected. */
export function wizardSearch(search: Record<string, unknown>): WizardSearch {
  const step = Number(search.step);
  const repos = Array.isArray(search.repos)
    ? [
        ...new Set(
          search.repos.filter(
            (repo): repo is string =>
              typeof repo === "string" && REPO.test(repo),
          ),
        ),
      ]
    : [];
  const rawOff: unknown[] = Array.isArray(search.off) ? search.off : [];
  const off = ROLES.filter(
    (role) => rawOff.includes(role) && !LOCKED_ROLES.includes(role),
  );
  const harness: Partial<Record<Role, Harness>> = {};
  if (search.harness && typeof search.harness === "object")
    for (const role of ROLES) {
      const value = oneOf(
        HARNESSES,
        (search.harness as Record<string, unknown>)[role],
      );
      if (value) harness[role] = value;
    }
  return {
    step: Number.isInteger(step) ? Math.min(Math.max(step, 1), LAST_STEP) : 1,
    owner:
      typeof search.owner === "string" && OWNER.test(search.owner)
        ? search.owner
        : undefined,
    repos: repos.length ? repos : undefined,
    name: text(search.name, 200),
    description: text(search.description, 2000),
    color:
      typeof search.color === "string" && COLOR.test(search.color)
        ? search.color.toLowerCase()
        : undefined,
    template: oneOf(TEMPLATES, search.template),
    example: text(search.example, 200),
    from: text(search.from, 4096),
    location: oneOf(["managed", "repo"] as const, search.location),
    defRepo:
      typeof search.defRepo === "string" && REPO.test(search.defRepo)
        ? search.defRepo
        : undefined,
    folder: text(search.folder, 200),
    handle: text(search.handle, 40),
    off: off.length ? off : undefined,
    harness: Object.keys(harness).length ? harness : undefined,
    github: flag(search.github),
    cron: search.cron === false ? false : text(search.cron, 100),
    job:
      typeof search.job === "string" && UUID.test(search.job)
        ? search.job
        : undefined,
  };
}

/** Repositories whose `owner/name` contains every word of the search, case-insensitively. */
export function matchRepos<T extends { repo: string }>(
  repos: T[],
  search: string,
): T[] {
  const words = search.toLowerCase().split(/\s+/).filter(Boolean);
  return repos.filter((r) =>
    words.every((word) => r.repo.toLowerCase().includes(word)),
  );
}

/** The template step 3 chose, as the server takes it; undefined until an import names its folder. */
export function templateOf(
  search: WizardSearch,
): CreationInput["template"] | undefined {
  switch (search.template ?? "nakara") {
    case "warp":
      return search.example
        ? { kind: "warp", example: search.example }
        : { kind: "warp" };
    case "import":
      return search.from ? { kind: "import", from: search.from } : undefined;
    case "blank":
      return { kind: "blank" };
    default:
      return { kind: "nakara" };
  }
}

/** The repository a definition kept in a repository goes to: the chosen one, else the first. */
export const definitionRepo = (search: WizardSearch) =>
  search.defRepo && search.repos?.includes(search.defRepo)
    ? search.defRepo
    : search.repos?.[0];

/** What Review previews and Create sends; null while step 2 or 3 is incomplete. */
export function creationBody(search: WizardSearch): CreationInput | null {
  const name = search.name?.trim();
  const repositories = search.repos ?? [];
  const template = templateOf(search);
  if (!name || repositories.length === 0 || !template) return null;
  const agents: NonNullable<CreationInput["agents"]> = {};
  for (const role of search.off ?? []) agents[role] = { enabled: false };
  for (const [role, harness] of Object.entries(search.harness ?? {}))
    agents[role as Role] = { ...agents[role as Role], harness };
  const repo = definitionRepo(search);
  return {
    name,
    ...(search.handle && { handle: search.handle }),
    ...(search.description?.trim() && { description: search.description }),
    avatarColor: search.color ?? AVATAR_COLORS[0],
    repositories,
    template,
    location:
      search.location === "repo" && repo
        ? { mode: "repo", repo, folder: search.folder ?? DEFAULT_FOLDER }
        : { mode: "managed" },
    ...(Object.keys(agents).length > 0 && { agents }),
    intake: {
      ...(search.github !== undefined && { github: search.github }),
      ...(search.cron !== undefined && {
        schedule: search.cron === false ? null : { cron: search.cron },
      }),
    },
  };
}
