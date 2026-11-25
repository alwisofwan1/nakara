// The New factory wizard's Create: a job that writes the scaffolded
// definition, validates it, clones the repositories, creates the factory's
// label in each, then registers the factory and starts its intake. The job is
// kept in the kv table, so its progress survives a page reload; a failed step
// keeps the steps before it, and a retry resumes from the failed step.
import { randomUUID } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import {
  HARNESS_FALLBACK,
  loadDefinition,
  type Problem,
  repoClaims,
} from "../definition/load.ts";
import {
  type ScaffoldChoices,
  type ScaffoldDeps,
  scaffold,
  writeTree,
} from "../definition/scaffold.ts";
import { ensureHistory } from "../definition/history.ts";
import { slugify } from "../definition/seed.ts";
import type { FactoryRegistry } from "./registry.ts";

export const CREATION_STEPS = [
  { key: "write", label: "Write definition" },
  { key: "validate", label: "Validate" },
  { key: "clone", label: "Clone repositories" },
  { key: "labels", label: "Create labels" },
  { key: "register", label: "Register and start intake" },
] as const;
export type CreationStepKey = (typeof CREATION_STEPS)[number]["key"];

/** Under the data directory, or a folder of a checkout of one of the factory's repositories. */
export type DefinitionLocation =
  | { mode: "managed" }
  | { mode: "repo"; repo: string; folder: string };

export interface CreationRequest {
  choices: ScaffoldChoices;
  avatarColor: string;
  location: DefinitionLocation;
}

export interface CreationStep {
  key: CreationStepKey;
  status: "pending" | "running" | "done" | "failed";
  /** What the step did or is doing, e.g. "2 of 3". */
  detail: string | null;
  error: string | null;
}

export interface CreationJob {
  id: string;
  request: CreationRequest;
  name: string;
  slug: string;
  handle: string;
  /** Where the definition is written. */
  dir: string;
  status: "running" | "failed" | "done";
  /** The Store instance running the job; another one means Nakara restarted during it. */
  instance: string;
  steps: CreationStep[];
  /** Repositories cloned so far; a retry skips them. */
  cloned: string[];
  /** The folder holds what a superseded failed job of the same slug wrote; writing replaces it. */
  replace?: boolean;
  createdAt: string;
}

export interface CreationDeps {
  /** Runs `gh` with `args`. */
  gh: (
    args: string[],
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  scaffold?: ScaffoldDeps;
  /** Clones or fetches the bare clone agents work from (ensureBareClone). */
  clone: (cacheDir: string, owner: string, name: string) => Promise<unknown>;
  /** Clones `owner/name` with a working tree into `dest`, for a definition kept in a repository. */
  checkout: (repo: string, dest: string) => Promise<void>;
  /** Runs `git` in `cwd` and returns its stdout. */
  git: (args: string[], cwd: string) => Promise<string>;
}

export type CreationRefusal = {
  ok: false;
  code: "not_found" | "policy";
  message: string;
};

const CREATION_PREFIX = "creation:";
const creationKey = (id: string) => `${CREATION_PREFIX}${id}`;

export function loadCreation(
  store: Store,
  id: string,
): CreationJob | undefined {
  const value = store.getKv(creationKey(id));
  return value ? (JSON.parse(value) as CreationJob) : undefined;
}

/** A job is stale when the Nakara that ran it stopped: nothing will finish its running step. */
export const staleCreation = (store: Store, job: CreationJob) =>
  job.status === "running" && job.instance !== store.instance.id;

/**
 * The claimed repositories another factory's running definition owns, one
 * problem per file and repository, as the reload of a definition reports them.
 */
export function ownedElsewhere(
  claims: { repo: string; path: string }[],
  registry: Pick<FactoryRegistry, "claimedBy">,
  slug: string,
): Problem[] {
  const owned = new Map<string, Problem>();
  for (const { repo, path } of claims) {
    const owner = registry.claimedBy(repo)?.record;
    if (owner && owner.slug !== slug)
      owned.set(`${path}\n${repo.toLowerCase()}`, {
        path,
        message: `repository ${repo} is already owned by the factory "${owner.name}"`,
      });
  }
  return [...owned.values()];
}

const problems = (errors: Problem[]) =>
  errors.map((e) => `${e.path}: ${e.message}`).join("\n");

/** The stderr of a failed command, else its message. */
const commandError = (error: unknown) =>
  String(
    (error as { stderr?: unknown }).stderr ||
      (error instanceof Error ? error.message : error),
  )
    .trim()
    .slice(0, 1000);

const hasFiles = (dir: string) =>
  readdir(dir).then(
    (entries) => entries.length > 0,
    () => false,
  );

export class FactoryCreation {
  private readonly registry: FactoryRegistry;
  private readonly config: Pick<Config, "dataDir" | "repoCacheDir">;
  private readonly deps: CreationDeps;
  /** Jobs this process is running, by id. */
  private readonly running = new Map<string, Promise<void>>();

  constructor(
    registry: FactoryRegistry,
    config: Pick<Config, "dataDir" | "repoCacheDir">,
    deps: CreationDeps,
  ) {
    this.registry = registry;
    this.config = config;
    this.deps = deps;
  }

  private get store(): Store {
    return this.registry.store;
  }

  /** The working tree a repository definition is kept in. */
  checkoutDir(repo: string): string {
    return join(this.config.dataDir, "checkouts", ...repo.split("/"));
  }

  /** Where the definition of the factory with `slug` is written. */
  definitionDir(slug: string, location: DefinitionLocation): string {
    return location.mode === "managed"
      ? join(this.config.dataDir, "factories", slug)
      : join(this.checkoutDir(location.repo), location.folder);
  }

  /** Start creating the factory; refused when its definition folder has files already. */
  async start(
    request: CreationRequest,
  ): Promise<{ ok: true; job: CreationJob } | CreationRefusal> {
    const name = request.choices.name.trim();
    const slug = slugify(name);
    const dir = this.definitionDir(slug, request.location);
    const held = this.unfinished(slug, dir);
    if (held && !held.supersede) return held;
    const superseded = held?.supersede;
    // The folder a superseded job wrote is replaced; other files are refused.
    const replace =
      superseded !== undefined && resolve(superseded.dir) === resolve(dir);
    if (!replace && (await hasFiles(dir)))
      return {
        ok: false,
        code: "policy",
        message: `${dir} already has files; choose another name or folder.`,
      };
    // Another start may have saved or superseded a job while this one checked the folder.
    const raced = this.unfinished(slug, dir);
    if (raced && !raced.supersede) return raced;
    if (raced?.supersede?.id !== superseded?.id)
      return {
        ok: false,
        code: "policy",
        message: `${name} is being created; wait for it to finish.`,
      };
    if (superseded) this.store.repos.kv.deleteKv(creationKey(superseded.id));
    const job: CreationJob = {
      id: randomUUID(),
      request,
      name,
      slug,
      handle: request.choices.handle?.trim() || slug,
      dir,
      status: "running",
      instance: this.store.instance.id,
      steps: CREATION_STEPS.map(({ key }) => ({
        key,
        status: "pending",
        detail: null,
        error: null,
      })),
      cloned: [],
      ...(replace && { replace: true }),
      createdAt: new Date().toISOString(),
    };
    this.save(job);
    this.run(job);
    return { ok: true, job };
  }

  /**
   * The unfinished job (running or failed) that holds the slug or folder of a
   * start. A failed job of the same slug that never registered its factory is
   * superseded: the new start replaces it, and reuses the folder it wrote.
   * Any other holder refuses the start.
   */
  private unfinished(
    slug: string,
    dir: string,
  ):
    | (CreationRefusal & { supersede?: undefined })
    | { supersede: CreationJob }
    | undefined {
    const job = this.store.repos.kv
      .kvValues(CREATION_PREFIX)
      .map((value) => JSON.parse(value) as CreationJob)
      .find(
        (j) =>
          j.status !== "done" &&
          (j.slug === slug || resolve(j.dir) === resolve(dir)),
      );
    if (!job) return undefined;
    const running = job.status === "running" && !staleCreation(this.store, job);
    if (
      !running &&
      job.slug === slug &&
      !this.store.repos.factories.factory(slug)
    )
      return { supersede: job };
    return {
      ok: false,
      code: "policy",
      message: running
        ? `${job.name} is being created in ${job.dir}; wait for it to finish.`
        : `Creating ${job.name} in ${job.dir} failed; open its progress and Retry it.`,
    };
  }

  /** Resume a failed job (or one a restart stopped) from its first unfinished step. */
  retry(id: string): { ok: true; job: CreationJob } | CreationRefusal {
    const job = loadCreation(this.store, id);
    if (!job)
      return { ok: false, code: "not_found", message: "Creation not found" };
    if (
      this.running.has(id) ||
      (job.status === "running" && !staleCreation(this.store, job))
    )
      return {
        ok: false,
        code: "policy",
        message: "The factory is still being created.",
      };
    if (job.status === "done")
      return {
        ok: false,
        code: "policy",
        message: `${job.name} has been created.`,
      };
    for (const step of job.steps)
      if (step.status !== "done")
        Object.assign(step, { status: "pending", error: null });
    job.status = "running";
    job.instance = this.store.instance.id;
    this.save(job);
    this.run(job);
    return { ok: true, job };
  }

  /** Resolves once the job's current run ends; tests wait on it. */
  settled(id: string): Promise<void> {
    return this.running.get(id) ?? Promise.resolve();
  }

  private save(job: CreationJob): void {
    this.store.setKv(creationKey(job.id), JSON.stringify(job));
    this.store.notify({ type: "creation", id: job.id });
  }

  private run(job: CreationJob): void {
    const done = this.steps(job).finally(() => this.running.delete(job.id));
    this.running.set(job.id, done);
  }

  private async steps(job: CreationJob): Promise<void> {
    for (const step of job.steps) {
      if (step.status === "done") continue;
      Object.assign(step, { status: "running", detail: null, error: null });
      this.save(job);
      try {
        step.detail = await this.step(job, step);
        step.status = "done";
      } catch (error) {
        step.status = "failed";
        step.error = error instanceof Error ? error.message : String(error);
        job.status = "failed";
        this.save(job);
        return;
      }
    }
    job.status = "done";
    this.save(job);
  }

  private step(job: CreationJob, step: CreationStep): Promise<string> {
    switch (step.key) {
      case "write":
        return this.write(job);
      case "validate":
        return this.validate(job);
      case "clone":
        return this.clone(job, step);
      case "labels":
        return this.labels(job);
      case "register":
        return this.register(job);
    }
  }

  /** Scaffold the tree again (nothing was kept from the preview) and write it in one move. */
  private async write(job: CreationJob): Promise<string> {
    const result = await scaffold(job.request.choices, this.deps.scaffold);
    if (!result.ok) throw new Error(problems(result.errors));
    const { location } = job.request;
    if (location.mode === "repo") await this.checkout(location.repo);
    await writeTree(job.dir, result.files, { replace: job.replace === true });
    // A managed definition keeps its history in a local git repository.
    if (location.mode === "managed") await ensureHistory(job.dir);
    return `${result.files.size} files in ${job.dir}`;
  }

  /**
   * Clone the repository with a working tree for a definition kept in it, or
   * reuse the clone an earlier factory or job left; returns its folder.
   */
  async checkout(repo: string): Promise<string> {
    const checkout = this.checkoutDir(repo);
    const cloned = await stat(join(checkout, ".git")).then(
      () => true,
      () => false,
    );
    if (!cloned)
      await this.deps.checkout(repo, checkout).catch((error) => {
        throw new Error(`Could not clone ${repo}: ${commandError(error)}`);
      });
    else await this.reuseCheckout(checkout);
    return checkout;
  }

  /**
   * A checkout an earlier factory or job left: fetch it, and refuse it while
   * it has uncommitted changes, which the new folder would be mixed with.
   */
  private async reuseCheckout(checkout: string): Promise<void> {
    await this.deps
      .git(["fetch", "--quiet", "origin"], checkout)
      .catch((error) => {
        throw new Error(`Could not fetch ${checkout}: ${commandError(error)}`);
      });
    const changes = await this.deps
      .git(["status", "--porcelain"], checkout)
      .catch((error) => {
        throw new Error(
          `Could not read the status of ${checkout}: ${commandError(error)}`,
        );
      });
    if (changes.trim())
      throw new Error(
        `${checkout} has uncommitted changes; commit or discard them, then Retry:\n${changes.trim().slice(0, 500)}`,
      );
  }

  /** Load the written tree; a repository another factory owns is refused, as on reload. */
  private async validate(job: CreationJob): Promise<string> {
    const loaded = await loadDefinition(job.dir, HARNESS_FALLBACK);
    if (!loaded.ok) throw new Error(problems(loaded.errors));
    const owned = ownedElsewhere(
      repoClaims(loaded.definition),
      this.registry,
      job.slug,
    );
    if (owned.length) throw new Error(problems(owned));
    const warnings = loaded.warnings.length;
    return `0 errors${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}`;
  }

  private async clone(job: CreationJob, step: CreationStep): Promise<string> {
    const repos = job.request.choices.repositories;
    const progress = () => `${job.cloned.length} of ${repos.length}`;
    for (const { owner, name } of repos) {
      const repo = `${owner}/${name}`;
      if (job.cloned.includes(repo)) continue;
      step.detail = progress();
      this.save(job);
      try {
        await this.deps.clone(this.config.repoCacheDir, owner, name);
      } catch (error) {
        throw new Error(`Could not clone ${repo}: ${commandError(error)}`);
      }
      job.cloned.push(repo);
    }
    return progress();
  }

  /** `gh label create` in every repository; a label that exists is left as it is. */
  private async labels(job: CreationJob): Promise<string> {
    const label = `factory:${job.name}`;
    let created = 0;
    let existed = 0;
    for (const { owner, name } of job.request.choices.repositories) {
      const repo = `${owner}/${name}`;
      const result = await this.deps.gh([
        "label",
        "create",
        label,
        "--repo",
        repo,
        "--color",
        job.request.avatarColor.replace("#", ""),
        "--description",
        `Work for the ${job.name} factory in Nakara`,
      ]);
      if (result.ok) created++;
      else if (/already exists/i.test(result.stderr)) existed++;
      else
        throw new Error(
          `Could not create ${label} in ${repo}: ${result.stderr.trim().slice(0, 500)}`,
        );
    }
    return `${label}: ${created} created, ${existed} already existed`;
  }

  /** Register the factory, load its definition and start its intake. */
  private async register(job: CreationJob): Promise<string> {
    const factories = this.store.repos.factories;
    let record = factories.factory(job.slug);
    if (record && resolve(record.definition_dir) !== resolve(job.dir))
      throw new Error(
        `The slug "${job.slug}" is taken by the factory ${record.name}.`,
      );
    record ??= factories.createFactory({
      slug: job.slug,
      name: job.name,
      description: job.request.choices.description?.trim() ?? "",
      avatar_color: job.request.avatarColor,
      foreman_handle: job.handle,
      definition_dir: job.dir,
      definition_mode: job.request.location.mode,
    });
    // A retry finds the factory registered with a definition that did not load.
    const existing = this.registry.get(job.slug);
    if (existing) await existing.reloadDefinition();
    const factory = existing ?? (await this.registry.register(record));
    const { definition } = factory;
    if (!definition)
      throw new Error(problems(factory.definitionProblems.errors));
    const providers = new Set(
      definition.automations
        .filter((a) => a.frontmatter.enabled)
        .flatMap((a) => a.frontmatter.triggers.map((t) => t.provider)),
    );
    // Telegram is not listed: its messages go to the default factory until
    // per-factory routing exists (#28).
    return [
      providers.has("github") && "GitHub poll",
      providers.has("schedule") && "Schedule",
      "Web",
    ]
      .filter(Boolean)
      .join(", ");
  }
}
