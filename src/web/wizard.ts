// Read models and inputs of the New factory wizard: the gh login, the owners
// and repositories it can list, what the agent token can see, the slug a
// factory name would get, the preview of the files Create writes, and the
// progress of a creation job. Nothing here writes; FactoryCreation does.
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

import type { Store } from "../db.ts";
import type { FactoryRepository } from "../db/factories.ts";
import { HANDLE, type ScaffoldDeps, scaffold } from "../definition/scaffold.ts";
import { slugify } from "../definition/seed.ts";
import { parseCron } from "../intake/schedule.ts";
import {
  CREATION_STEPS,
  type CreationJob,
  type CreationRequest,
  type CreationStep,
  loadCreation,
  ownedElsewhere,
  staleCreation,
} from "../orchestrator/creation.ts";
import type { FactoryRegistry } from "../orchestrator/registry.ts";
import {
  type AgentToken,
  agentTokenOf,
  agentTokenSecret,
  type Gh,
  type GhResult,
  pushAccess,
} from "../runner/agent-token.ts";
import { problemDto } from "./definition.ts";

export { type Gh, type GhResult, runGh } from "../runner/agent-token.ts";

export interface WizardDeps {
  gh: Gh;
  /** Where NAKARA_AGENT_GH_TOKEN and the factories' own tokens are read from. */
  env: NodeJS.ProcessEnv;
  /** Templates; the Warp examples clone is cached by default. */
  scaffold?: ScaffoldDeps;
  /** The bare clone of a repository agents work from; ensureBareClone by default. */
  clone?: (cacheDir: string, owner: string, name: string) => Promise<unknown>;
}

/** `gh repo clone` with a working tree, for a definition kept in a repository. */
export const ghCheckout =
  (gh: Gh) =>
  async (repo: string, dest: string): Promise<void> => {
    await mkdir(dirname(dest), { recursive: true });
    const result = await gh(["repo", "clone", repo, dest, "--", "--quiet"]);
    if (!result.ok)
      throw new Error(result.stderr.trim() || "gh repo clone failed");
  };

export interface GhLoginDto {
  loggedIn: boolean;
  account: string | null;
  /** How gh is logged in (e.g. "keyring, scopes repo, read:org"), or why it is not. */
  detail: string;
}

/**
 * `gh auth status --hostname github.com`. gh 2.40+ prints "account <login>"
 * on stdout, older releases "as <login>" on stderr.
 */
export function ghLogin(result: GhResult): GhLoginDto {
  const text = `${result.stdout}\n${result.stderr}`;
  const match =
    /Logged in to github\.com (?:as|account) ([A-Za-z0-9-]+)(?: \(([^)]*)\))?/.exec(
      text,
    );
  if (!result.ok || !match?.[1])
    return {
      loggedIn: false,
      account: null,
      detail:
        text
          .split("\n")
          .map((line) => line.replace(/^[\s✓X!-]+/, "").trim())
          .find(Boolean) ?? "gh is not logged in to github.com",
    };
  const scopes = /Token scopes: (.+)/
    .exec(text)?.[1]
    ?.replaceAll("'", "")
    .trim();
  return {
    loggedIn: true,
    account: match[1],
    detail: [match[2], scopes && scopes !== "none" && `scopes ${scopes}`]
      .filter(Boolean)
      .join(", "),
  };
}

export interface OwnerDto {
  login: string;
  kind: "user" | "org";
}

/** The account first, then the organizations of `gh api user/orgs --paginate --jq .[].login`. */
export function owners(account: string, orgs: GhResult): OwnerDto[] {
  const names = orgs.ok
    ? orgs.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter((login) => login && login !== account)
    : [];
  return [
    { login: account, kind: "user" },
    ...[...new Set(names)].map((login) => ({ login, kind: "org" as const })),
  ];
}

export interface AgentTokenDto {
  /** `personal`: no agent token, and agents get the operator's gh token. */
  state: "set" | "personal" | "unset";
  fineGrained: boolean;
}

export function agentToken(env: NodeJS.ProcessEnv): AgentTokenDto {
  const token = env.NAKARA_AGENT_GH_TOKEN;
  if (token)
    return { state: "set", fineGrained: token.startsWith("github_pat_") };
  return {
    state: env.NAKARA_ALLOW_PERSONAL_GH_TOKEN === "1" ? "personal" : "unset",
    fineGrained: false,
  };
}

export const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

export const reposQuery = z.object({
  owner: z.string().regex(OWNER, "owner must be a GitHub user or organization"),
});
export const accessQuery = z.object({
  /** Comma-separated `owner/name`. */
  repos: z
    .string()
    .transform((value) => [
      ...new Set(value.split(",").map((repo) => repo.trim())),
    ])
    .pipe(
      z
        .array(z.string().regex(REPO, "repos must be owner/name"))
        .min(1)
        .max(100),
    ),
  /** The slug the new factory gets, so its own token is checked when it has one. */
  slug: z.string().regex(HANDLE, "slug must be a factory slug").optional(),
});
export const nameQuery = z.object({ name: z.string().max(200) });

const REPO_FIELDS = "nameWithOwner,isPrivate,primaryLanguage,updatedAt";
export const repoListArgs = (owner: string) => [
  "repo",
  "list",
  owner,
  "--limit",
  "1000",
  "--json",
  REPO_FIELDS,
];

export interface RepoDto {
  repo: string;
  private: boolean;
  language: string | null;
  updatedAt: string;
}

/** `gh repo list --json`, most recently updated first; null when gh printed something else. */
export function repoList(stdout: string): RepoDto[] | null {
  let rows: {
    nameWithOwner: string;
    isPrivate: boolean;
    primaryLanguage: { name: string } | null;
    updatedAt: string;
  }[];
  try {
    rows = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return rows
    .map((row) => ({
      repo: row.nameWithOwner,
      private: row.isPrivate,
      language: row.primaryLanguage?.name ?? null,
      updatedAt: row.updatedAt,
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export interface RepoAccessDto {
  repo: string;
  /** Whether agents can reach the repository with the token they get. */
  visible: boolean;
  /** Why not, when they can't. */
  message: string | null;
}

/**
 * Asks GitHub for each repository with the token agents push with: the
 * factory's own token (by the slug the factory gets) or the shared agent token
 * when one is set, otherwise the operator's gh login, which agents running
 * outside Docker use (runner-specific limits are for the agents step).
 * A repository counts only with push permission: any token can read a public one.
 * Returns where the token came from, never its value.
 */
export async function repoAccess(
  deps: WizardDeps,
  repos: string[],
  slug?: string,
): Promise<{ repos: RepoAccessDto[]; token: AgentToken }> {
  const token = agentTokenOf(slug, deps.env);
  const who = token.variable ? "agent token" : "gh login";
  const access = await pushAccess(
    deps.gh,
    agentTokenSecret(slug, deps.env),
    who,
    repos,
  );
  return {
    repos: access.map(({ repo, canPush, message }) => ({
      repo,
      visible: canPush,
      message,
    })),
    token,
  };
}

export interface FactoryNameDto {
  name: string;
  slug: string;
  /** The foreman's suggested `@handle`. */
  handle: string;
  available: boolean;
  /** Why the name can't be used. */
  message: string | null;
}

/** The slug and handle a factory name suggests, and whether another factory has them. */
export function readFactoryName(
  factories: FactoryRepository,
  input: string,
): FactoryNameDto {
  const name = input.trim();
  const slug = slugify(name);
  const result = { name, slug, handle: slug };
  const refuse = (message: string) => ({
    ...result,
    available: false,
    message,
  });
  if (!name) return refuse("Enter a factory name.");
  if (!HANDLE.test(slug))
    return refuse(
      `The slug "${slug}" is too long; use a name of at most 40 letters and digits.`,
    );
  const bySlug = factories.factory(slug);
  if (bySlug)
    return refuse(
      `The slug "${slug}" is taken by the factory ${bySlug.name}. Choose another name.`,
    );
  const byHandle = factories
    .factories()
    .find((factory) => factory.foreman_handle === slug);
  if (byHandle)
    return refuse(
      `The handle @${slug} is taken by the foreman of ${byHandle.name}. Choose another name.`,
    );
  return { ...result, available: true, message: null };
}

const HARNESS = z.enum(["claude", "codex", "qwen"]);
const ROLE = z.enum(["foreman", "triage", "spec", "implement", "review"]);
/** A folder inside a repository: relative, no `..` and no hidden segments. */
export const FOLDER =
  /^(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/(?!\.)[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

export const templateInput = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("nakara") }),
  z.object({
    kind: z.literal("warp"),
    example: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "example must be a folder name")
      .optional(),
  }),
  z.object({
    kind: z.literal("import"),
    from: z.string().startsWith("/", "from must be an absolute path").max(4096),
  }),
  z.object({ kind: z.literal("blank") }),
]);
/** The template query of step 3: `kind`, plus `example` or `from`. */
export const templateQuery = z
  .object({
    kind: z.enum(["nakara", "warp", "import", "blank"]),
    example: z.string().optional(),
    from: z.string().optional(),
  })
  .transform((query, ctx) => {
    const parsed = templateInput.safeParse(
      query.kind === "warp"
        ? { kind: "warp", ...(query.example && { example: query.example }) }
        : query.kind === "import"
          ? { kind: "import", from: query.from ?? "" }
          : { kind: query.kind },
    );
    if (parsed.success) return parsed.data;
    ctx.addIssue({
      code: "custom",
      message: parsed.error.issues[0]?.message ?? "Invalid template",
    });
    return z.NEVER;
  });

/** Every choice of the wizard: what Review shows and what Create writes. */
export const creationInput = z
  .object({
    name: z.string().trim().min(1, "Enter a factory name").max(200),
    handle: z
      .string()
      .regex(
        HANDLE,
        "handle must be lowercase letters, digits and inner dashes",
      )
      .optional(),
    description: z.string().max(2000).optional(),
    avatarColor: z
      .string()
      .regex(/^#[0-9a-f]{6}$/i, "avatarColor must be #rrggbb"),
    repositories: z
      .array(z.string().regex(REPO, "repositories must be owner/name"))
      .min(1, "Pick at least one repository")
      .max(100),
    template: templateInput,
    location: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("managed") }),
      z.object({
        mode: z.literal("repo"),
        repo: z.string().regex(REPO, "repo must be owner/name"),
        folder: z
          .string()
          .max(200)
          .regex(FOLDER, "folder must be a relative path such as factory"),
      }),
    ]),
    agents: z
      .partialRecord(
        ROLE,
        z.object({
          enabled: z.boolean().optional(),
          harness: HARNESS.optional(),
        }),
      )
      .optional(),
    /** An omitted source keeps the template's default, or an import's automations. */
    intake: z.object({
      github: z.boolean().optional(),
      telegram: z.boolean().optional(),
      schedule: z
        .object({
          cron: z
            .string()
            .max(100)
            .refine(
              (cron) => {
                try {
                  parseCron(cron);
                  return true;
                } catch {
                  return false;
                }
              },
              {
                message:
                  "schedule must be a 5-field UTC cron or a macro such as @daily",
              },
            ),
        })
        .nullable()
        .optional(),
    }),
  })
  .refine(
    (input) =>
      input.location.mode === "managed" ||
      input.repositories.includes(input.location.repo),
    {
      message:
        "location: the definition's repository must be one of the factory's",
      path: ["location"],
    },
  );
export type CreationInput = z.output<typeof creationInput>;

export function creationRequest(input: CreationInput): CreationRequest {
  return {
    choices: {
      name: input.name,
      ...(input.handle && { handle: input.handle }),
      ...(input.description?.trim() && { description: input.description }),
      repositories: input.repositories.map((repo) => {
        const [owner = "", name = ""] = repo.split("/");
        return { owner, name };
      }),
      template: input.template,
      ...(input.agents && { agents: input.agents }),
      intake: {
        ...(input.intake.github !== undefined && {
          github: input.intake.github,
        }),
        ...(input.intake.telegram !== undefined && {
          telegram: input.intake.telegram,
        }),
        ...(input.intake.schedule !== undefined && {
          schedule: input.intake.schedule,
        }),
      },
    },
    avatarColor: input.avatarColor.toLowerCase(),
    location: input.location,
  };
}

/** Why the name or handle can't be used by a new factory; null when both are free. */
export function nameRefusal(
  factories: FactoryRepository,
  input: Pick<CreationInput, "name" | "handle">,
): string | null {
  const name = readFactoryName(factories, input.name);
  if (!name.available) return name.message;
  const handle = input.handle ?? name.handle;
  const taken = factories
    .factories()
    .find((f) => f.foreman_handle === handle || f.slug === handle);
  return taken
    ? `The handle @${handle} is taken by ${taken.name}. Choose another handle.`
    : null;
}

export interface PreviewDto {
  ok: boolean;
  /** Relative paths of the files Create writes, sorted. */
  files: string[];
  /** Where they are written. */
  dir: string;
  label: string;
  errors: ReturnType<typeof problemDto>[];
  warnings: ReturnType<typeof problemDto>[];
}

/**
 * Review and create: the scaffolded tree, validated in memory, and refused
 * where Create would fail at Validate (a repository another factory owns).
 * Nothing is written.
 */
export async function previewCreation(
  factories: FactoryRepository,
  registry: Pick<FactoryRegistry, "claimedBy">,
  dir: string,
  request: CreationRequest,
  deps: ScaffoldDeps,
): Promise<PreviewDto> {
  const result = await scaffold(request.choices, deps);
  const refusal = nameRefusal(factories, {
    name: request.choices.name,
    handle: request.choices.handle,
  });
  const errors = [
    ...(refusal ? [{ path: "name", message: refusal }] : []),
    ...(result.ok
      ? ownedElsewhere(result.claims, registry, slugify(request.choices.name))
      : result.errors),
  ].map(problemDto);
  return {
    ok: errors.length === 0,
    files: result.ok ? [...result.files.keys()].sort() : [],
    dir,
    label: `factory:${request.choices.name.trim()}`,
    errors,
    warnings: result.warnings.map(problemDto),
  };
}

export interface CreationStepDto {
  key: CreationStep["key"];
  label: string;
  status: CreationStep["status"];
  detail: string | null;
  error: string | null;
}
export interface CreationDto {
  id: string;
  name: string;
  slug: string;
  status: CreationJob["status"];
  steps: CreationStepDto[];
}

/**
 * A creation job's progress. A job whose Nakara stopped mid-step reads as
 * failed at that step, so Retry resumes it.
 */
export function readCreation(
  store: Store,
  id: string,
): CreationDto | undefined {
  const job = loadCreation(store, id);
  if (!job) return undefined;
  const stale = staleCreation(store, job);
  let interrupted = false;
  const steps = job.steps.map((step): CreationStepDto => {
    const label =
      CREATION_STEPS.find((s) => s.key === step.key)?.label ?? step.key;
    if (stale && !interrupted && step.status !== "done") {
      interrupted = true;
      return {
        key: step.key,
        label,
        status: "failed",
        detail: step.detail,
        error: "Nakara stopped during this step. Retry resumes it.",
      };
    }
    return { label, ...step };
  });
  return {
    id: job.id,
    name: job.name,
    slug: job.slug,
    status: stale ? "failed" : job.status,
    steps,
  };
}

/**
 * Clone once, then copy the clone for each use; the clone is refreshed after
 * `ttlMs`. The Warp examples are cloned for every preview otherwise.
 */
export function cachedClone(
  clone: (dest: string) => Promise<void>,
  ttlMs = 10 * 60_000,
): (dest: string) => Promise<void> {
  let cached: { at: number; dir: Promise<string> } | undefined;
  return async (dest) => {
    if (!cached || Date.now() - cached.at > ttlMs) {
      const old = cached;
      const dir = mkdtemp(join(tmpdir(), "nakara-clone-cache-")).then(
        async (root) => {
          await clone(join(root, "repo"));
          return join(root, "repo");
        },
      );
      const entry = { at: Date.now(), dir };
      cached = entry;
      dir.catch(() => {
        if (cached === entry) cached = undefined;
      });
      // Copies from the old clone may still run; remove it a minute later.
      old?.dir.then(
        (path) =>
          setTimeout(
            () => void rm(dirname(path), { recursive: true, force: true }),
            60_000,
          ).unref(),
        () => {},
      );
    }
    await cp(await cached.dir, dest, { recursive: true });
  };
}
