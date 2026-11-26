import { cp, rm } from "node:fs/promises";

import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import {
  type Definition,
  HARNESS_FALLBACK,
  type LoadResult,
  loadDefinition,
  type Problem,
  repoClaims,
} from "../definition/load.ts";
import {
  type AgentEdit,
  appendLearning,
  type AutomationEdit,
  createAgent,
  createAutomation,
  deleteAgent,
  deleteAutomation,
  type NewAgent,
  type NewAutomation,
  type WriteResult,
  writeAgent,
  writeAutomation,
} from "../definition/write.ts";
import { commitDefinition, ensureHistory } from "../definition/history.ts";
import { RUNNER_LINE, reachOf, widening } from "../definition/reach.ts";
import { checkRepositories, type RepoProbe } from "../runner/repos.ts";
import { ensureBareClone } from "../runner/workspace.ts";

/** A definition write: refused and untouched, or written (`reload` is null when nothing changed). */
export type DefinitionWrite =
  | (WriteResult & { ok: false })
  | { ok: true; reload: LoadResult | null; revision?: string | undefined };

/** Holds the applied factory definition: loads, reloads, and edits it on disk, and checks its repositories. */
export class DefinitionService {
  definition: Definition | undefined;
  definitionProblems: { errors: Problem[]; warnings: Problem[] } = {
    errors: [],
    warnings: [],
  };
  private saving: Promise<unknown> = Promise.resolve();
  private repoCheck: Promise<void> | undefined;
  private repoRecheck = false;
  /** Clones or fetches one repository; replaced in tests to stay offline. */
  probeRepository: RepoProbe = ensureBareClone;

  private readonly store: Store;
  private readonly config: Config;
  /** The reload a write that changed files runs; reloadDefinition unless the owner routes it. */
  private readonly reload: () => Promise<LoadResult>;
  /** The name of another factory that owns an `owner/name` repository. */
  private readonly repoOwner: (repo: string) => string | undefined;
  /** Whether the definition is Nakara-managed, so each write is a commit. */
  private readonly managed: () => boolean;
  /** Told when a written edit could not be committed; the edit stands. */
  private readonly historyFailed: (error: unknown) => void;
  /** The kv key of this factory's approved reach; `<key>:pending` holds a widening that waits. */
  private readonly reachKey: string;
  /** Where a copy of the last applied definition survives a restart; none for an unregistered factory. */
  private readonly appliedDir: string | undefined;

  constructor(
    store: Store,
    config: Config,
    reload: () => Promise<LoadResult> = () => this.reloadDefinition(),
    repoOwner: (repo: string) => string | undefined = () => undefined,
    history: {
      managed: () => boolean;
      failed: (error: unknown) => void;
    } = { managed: () => false, failed: () => {} },
    reach: { key: string; appliedDir?: string | undefined } = {
      key: "reach:default",
    },
  ) {
    this.reachKey = reach.key;
    this.appliedDir = reach.appliedDir;
    this.store = store;
    this.config = config;
    this.reload = reload;
    this.repoOwner = repoOwner;
    this.managed = history.managed;
    this.historyFailed = history.failed;
  }

  /**
   * Load the definition from disk without applying it. A load that fails
   * outright (an unreadable file, a missing directory) is an error of the
   * result, so it stops only this factory. A repository is owned by one
   * factory: claiming one that another factory owns, in factory.yaml or in a
   * GitHub trigger's repos filter, is an error of that file naming the owner.
   */
  async validateDefinition(): Promise<LoadResult> {
    try {
      const result = await loadDefinition(
        this.config.definitionDir,
        HARNESS_FALLBACK,
      );
      if (!result.ok) return result;
      const errors = new Map<string, Problem>();
      for (const { repo, path } of repoClaims(result.definition)) {
        const factory = this.repoOwner(repo);
        if (factory !== undefined)
          errors.set(`${path}\n${repo.toLowerCase()}`, {
            path,
            message: `repository ${repo} is already owned by the factory "${factory}"`,
          });
      }
      return errors.size
        ? { ok: false, errors: [...errors.values()], warnings: result.warnings }
        : result;
    } catch (error) {
      return {
        ok: false,
        errors: [
          {
            path: this.config.definitionDir,
            message: `The definition could not be read: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        warnings: [],
      };
    }
  }

  /**
   * Write an agent's settings and prompt, then reload so the next run uses them.
   * Saves run one at a time; an invalid or stale edit leaves the files untouched,
   * and an edit that changes nothing skips the reload (`reload` is null).
   */
  saveAgent(
    name: string,
    edit: AgentEdit,
    revision: string,
  ): Promise<DefinitionWrite> {
    return this.writeDefinition(`Edit agent ${name}`, () =>
      writeAgent(
        this.config.definitionDir,
        name,
        edit,
        revision,
        HARNESS_FALLBACK,
      ),
    );
  }

  /** Create agents/<name>/agent.md and reload; an invalid or taken agent writes nothing. */
  createAgent(agent: NewAgent): Promise<DefinitionWrite> {
    return this.writeDefinition(`Create agent ${agent.name}`, () =>
      createAgent(this.config.definitionDir, agent, HARNESS_FALLBACK),
    );
  }

  /**
   * Delete an agent's folder and reload; refused when the definition would no
   * longer load without it. A run still queued for it fails when it starts.
   */
  deleteAgent(name: string, revision: string): Promise<DefinitionWrite> {
    return this.writeDefinition(`Delete agent ${name}`, () =>
      deleteAgent(this.config.definitionDir, name, revision, HARNESS_FALLBACK),
    );
  }

  /**
   * Write an automation's switch, instructions, name, agent or trigger, then reload so the
   * triggers and the next work item use them. Saved like an agent edit.
   */
  saveAutomation(
    name: string,
    edit: AutomationEdit,
    revision: string,
  ): Promise<DefinitionWrite> {
    return this.writeDefinition(`Edit automation ${name}`, () =>
      writeAutomation(
        this.config.definitionDir,
        name,
        edit,
        revision,
        HARNESS_FALLBACK,
      ),
    );
  }

  /** Create automations/<name>/automation.md and reload; an invalid or taken automation writes nothing. */
  createAutomation(automation: NewAutomation): Promise<DefinitionWrite> {
    return this.writeDefinition(`Create automation ${automation.name}`, () =>
      createAutomation(this.config.definitionDir, automation, HARNESS_FALLBACK),
    );
  }

  /**
   * Delete an automation's folder and reload, so its triggers stop; the work
   * items it created stay.
   */
  deleteAutomation(name: string, revision: string): Promise<DefinitionWrite> {
    return this.writeDefinition(`Delete automation ${name}`, () =>
      deleteAutomation(
        this.config.definitionDir,
        name,
        revision,
        HARNESS_FALLBACK,
      ),
    );
  }

  /** Append Operator-approved lessons to the shared learnings skill, then reload. */
  saveLearning(lines: string[]): Promise<DefinitionWrite> {
    return this.writeDefinition("Add learnings", () =>
      appendLearning(this.config.definitionDir, lines, HARNESS_FALLBACK),
    );
  }

  /**
   * Writes run one at a time; a write that changed files reloads the
   * definition. A Nakara-managed definition commits the write as `message`.
   */
  private writeDefinition(
    message: string,
    write: () => Promise<WriteResult>,
  ): Promise<DefinitionWrite> {
    const save = this.saving.then(async () => {
      const dir = this.config.definitionDir;
      const managed = this.managed();
      if (managed) await ensureHistory(dir).catch(this.historyFailed);
      const written = await write();
      if (!written.ok) return written;
      if (managed && written.changed)
        await commitDefinition(dir, message).catch(this.historyFailed);
      return {
        ok: true as const,
        reload: written.changed ? await this.reload() : null,
        revision: written.revision,
      };
    });
    this.saving = save.catch(() => {});
    return save;
  }

  /**
   * Point the service at the definition in `dir`, after the writes in
   * progress, and reload it from there. `prepare` runs first, in the same
   * turn, so no write lands between the copy it makes and the switch.
   */
  relocate<T>(
    prepare: () => Promise<T>,
    dir: (prepared: T) => string | null,
  ): Promise<T> {
    const move = this.saving.then(async () => {
      const prepared = await prepare();
      const target = dir(prepared);
      if (target !== null) {
        this.config.definitionDir = target;
        await this.reload();
      }
      return prepared;
    });
    this.saving = move.catch(() => {});
    return move;
  }

  async reloadDefinition(): Promise<LoadResult> {
    const loaded = await this.validateDefinition();
    let result = loaded;
    if (loaded.ok) {
      // The first load sets the approved reach; after that, wider reach waits.
      const reach = reachOf(loaded.definition);
      const approved = this.store.getKv(this.reachKey);
      const known: string[] = approved ? JSON.parse(approved) : [];
      // Reach approved before runners counted: where agents run now is taken as approved.
      if (approved && !known.some((l) => RUNNER_LINE.test(l)))
        known.push(...reach.filter((l) => RUNNER_LINE.test(l)));
      const added = approved ? widening(known, reach) : [];
      this.putKv(
        `${this.reachKey}:pending`,
        added.length ? JSON.stringify({ added, reach }) : "",
      );
      if (added.length)
        result = {
          ok: false,
          errors: [
            {
              path: "agents/",
              message: `this change widens what agents can reach, so it waits for your approval on the Definition page: ${added.join("; ")}`,
            },
          ],
          warnings: loaded.warnings,
        };
      else this.putKv(this.reachKey, JSON.stringify(reach));
    }
    // A restart lost the definition a held reload kept: run the last applied copy.
    if (loaded.ok && !result.ok && !this.definition && this.appliedDir) {
      const copy = await loadDefinition(
        this.appliedDir,
        HARNESS_FALLBACK,
      ).catch(() => undefined);
      if (copy?.ok) {
        this.definition = copy.definition;
        this.store.notify({ type: "status", id: "global" });
      }
    }
    // Applied as a unit: a broken definition keeps the last valid one running.
    if (result.ok) {
      this.definition = result.definition;
      // Through the notifier, so the reach write's status change coalesces with it.
      this.store.notify({ type: "status", id: "global" });
    }
    this.definitionProblems = {
      errors: result.ok ? [] : result.errors,
      warnings: result.warnings,
    };
    this.store.notify({ type: "definition", id: "global" });
    // After the notices, so the copy's wait does not split their coalescing.
    if (result.ok) await this.keepApplied();
    return result;
  }

  /** Copy the applied files; a failed copy only loses the fallback. */
  private async keepApplied(): Promise<void> {
    const dir = this.appliedDir;
    if (!dir) return;
    await rm(dir, { recursive: true, force: true })
      .then(() =>
        cp(this.config.definitionDir, dir, {
          recursive: true,
          filter: (src) => !/[/\\]\.git([/\\]|$)/.test(src),
        }),
      )
      .catch(() => undefined);
  }

  /** A write is a change event; an unchanged value is not written. */
  private putKv(key: string, value: string): void {
    if ((this.store.getKv(key) ?? "") !== value) this.store.setKv(key, value);
  }

  /** The reach lines a held reload adds, or null when nothing waits. */
  pendingReach(): string[] | null {
    const pending = this.store.getKv(`${this.reachKey}:pending`);
    return pending ? (JSON.parse(pending) as { added: string[] }).added : null;
  }

  /** Approve exactly the reach that was shown, then reload; anything wider since waits again. */
  approveReach(): Promise<LoadResult> | null {
    const pending = this.store.getKv(`${this.reachKey}:pending`);
    if (!pending) return null;
    const { reach } = JSON.parse(pending) as { reach: string[] };
    this.store.setKv(this.reachKey, JSON.stringify(reach));
    return this.reload();
  }

  /** Keep the running definition; the files stay as they are until someone changes them. */
  rejectReach(): boolean {
    if (!this.store.getKv(`${this.reachKey}:pending`)) return false;
    this.store.setKv(`${this.reachKey}:pending`, "");
    this.definitionProblems = {
      ...this.definitionProblems,
      errors: [
        {
          path: "agents/",
          message:
            "the wider reach was rejected, so the previous definition keeps running; change the files, or reload to ask again",
        },
      ],
    };
    this.store.notify({ type: "definition", id: "global" });
    return true;
  }

  /** Clone or fetch every factory repository and record its access status. */
  /** A check requested while one runs (e.g. after a reload) runs again once it finishes. */
  checkRepositories(): Promise<void> {
    if (this.repoCheck) {
      this.repoRecheck = true;
      return this.repoCheck;
    }
    this.repoCheck = (async () => {
      try {
        do {
          this.repoRecheck = false;
          if (!this.definition) break;
          await checkRepositories(
            this.store,
            this.definition,
            this.config.repoCacheDir,
            this.probeRepository,
          );
        } while (this.repoRecheck);
      } finally {
        this.repoCheck = undefined;
      }
    })();
    return this.repoCheck;
  }
}
