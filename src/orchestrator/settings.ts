// A factory's Settings: rename it, delete it, and move a Nakara-managed
// definition into a folder of one of its repositories.
import { existsSync } from "node:fs";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { snapshot } from "../backup.ts";

import {
  HARNESS_FALLBACK,
  loadDefinition,
  type Problem,
} from "../definition/load.ts";
import type { FactoryCreation } from "./creation.ts";
import type { Factory } from "./factory.ts";
import { ITEM_KEY_PREFIXES } from "./pull-request-gate.ts";
import type { FactoryRegistry } from "./registry.ts";

export type SettingsRefusal = {
  ok: false;
  /** policy: refused as the factory is; checkout: the repository could not be cloned or reused. */
  code: "policy" | "checkout";
  message: string;
  problems?: Problem[];
};

const refuse = (message: string): SettingsRefusal => ({
  ok: false,
  code: "policy",
  message,
});

const hasFiles = (dir: string) =>
  readdir(dir).then(
    (entries) => entries.length > 0,
    () => false,
  );

export class FactorySettings {
  private readonly registry: FactoryRegistry;
  private readonly creation: Pick<FactoryCreation, "checkout">;

  constructor(
    registry: FactoryRegistry,
    creation: Pick<FactoryCreation, "checkout">,
  ) {
    this.registry = registry;
    this.creation = creation;
  }

  private get factories() {
    return this.registry.store.repos.factories;
  }

  /**
   * Where a move keeps the Nakara-managed definition, with its git history:
   * `<data dir>/archive/factories/<slug>`, or `<slug>-2`, `-3`, … when an
   * earlier factory of that slug left an archive.
   */
  archiveDir(slug: string): string {
    const base = join(this.registry.config.dataDir, "archive", "factories");
    let dir = join(base, slug);
    for (let n = 2; existsSync(dir); n++) dir = join(base, `${slug}-${n}`);
    return dir;
  }

  /** The factory's queued and running runs; a move or delete waits for them. */
  private runsInFlight(id: number): number {
    const { store } = this.registry;
    return (["queued", "running"] as const).reduce(
      (n, status) => n + store.recentRuns({ status, factoryId: id }).length,
      0,
    );
  }

  /** Change the display name and avatar; the slug, the URLs and the label stay. */
  rename(
    factory: Factory,
    edit: { name: string; avatarColor: string },
  ): { ok: true } | SettingsRefusal {
    const record = factory.record;
    if (!record) return refuse("The factory is not registered.");
    const name = edit.name.trim();
    const taken = this.factories
      .factories()
      .find(
        (f) =>
          f.id !== record.id && f.name.toLowerCase() === name.toLowerCase(),
      );
    if (taken)
      return refuse(
        `Another factory is named ${taken.name}. Choose another name.`,
      );
    const avatar_color = edit.avatarColor.toLowerCase();
    this.factories.renameFactory(record.id, { name, avatar_color });
    Object.assign(record, { name, avatar_color });
    return { ok: true };
  }

  /**
   * Delete the factory with its closed work and their history. Refused for
   * the default factory, which takes Telegram and work without a factory,
   * and while the factory has active items or runs. The database is
   * snapshotted first (reason `pre-delete-<slug>`), and a failed snapshot
   * deletes nothing. A Nakara-managed definition is deleted too; a
   * repository folder is left as it is.
   */
  async delete(
    factory: Factory,
  ): Promise<{ ok: true; snapshot: string } | SettingsRefusal> {
    const record = factory.record;
    if (!record) return refuse("The factory is not registered.");
    if (factory === this.registry.default)
      return refuse(
        `${record.name} is the default factory: Telegram and work without a factory go to it, so it cannot be deleted.`,
      );
    const active = this.factories.activeItems(record.id);
    if (active)
      return refuse(
        `${record.name} has ${active} active work item${active === 1 ? "" : "s"}. Complete or cancel ${active === 1 ? "it" : "them"} first.`,
      );
    const runs = this.runsInFlight(record.id);
    if (runs)
      return refuse(
        `${record.name} has ${runs} run${runs === 1 ? "" : "s"} in progress. Wait for ${runs === 1 ? "it" : "them"} to finish.`,
      );
    let saved: string;
    try {
      saved = snapshot(this.registry.store.db, {
        ...this.registry.config.backup,
        reason: `pre-delete-${record.slug}`,
      }).path;
    } catch (error) {
      return refuse(
        `Could not snapshot the database before deleting ${record.name}; nothing was deleted: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.factories.deleteFactory(record.id, ITEM_KEY_PREFIXES);
    this.registry.unregister(factory);
    if (record.definition_mode === "managed")
      await rm(record.definition_dir, { recursive: true, force: true });
    return { ok: true, snapshot: saved };
  }

  /**
   * Move a Nakara-managed definition into `folder` of a checkout of one of
   * the factory's repositories, then run it from there. The copy must load,
   * and the folder must be empty. Nakara does not commit or push it there,
   * as for a definition the New factory wizard writes into a repository.
   * The Nakara-managed folder, with its git history, is then archived in
   * archiveDir(slug).
   */
  async move(
    factory: Factory,
    target: { repo: string; folder: string },
  ): Promise<
    | {
        ok: true;
        dir: string;
        /** Where the managed folder was archived; null when it stayed in place. */
        archive: string | null;
      }
    | SettingsRefusal
  > {
    const record = factory.record;
    if (!record) return refuse("The factory is not registered.");
    if (record.definition_mode !== "managed")
      return refuse(
        `The definition is already kept in ${record.definition_dir}.`,
      );
    const repositories = (factory.definition?.factory.repositories ?? []).map(
      (r) => `${r.owner}/${r.name}`,
    );
    if (
      !repositories.some((r) => r.toLowerCase() === target.repo.toLowerCase())
    )
      return refuse(
        factory.definition
          ? `${target.repo} is not one of the factory's repositories.`
          : "No valid definition is loaded; fix it before moving it.",
      );
    const busy = () => {
      const runs = this.runsInFlight(record.id);
      return runs
        ? refuse(
            `${record.name} has ${runs} run${runs === 1 ? "" : "s"} in progress, which read the definition. Wait for ${runs === 1 ? "it" : "them"} to finish.`,
          )
        : null;
    };
    const refused = busy();
    if (refused) return refused;
    const from = resolve(record.definition_dir);
    // The copy is made after the writes in progress, and no write lands
    // between it and the switch.
    const moved = await factory.definitions.relocate(
      async (): Promise<{ ok: true; dir: string } | SettingsRefusal> => {
        let checkout: string;
        try {
          checkout = await this.creation.checkout(target.repo);
        } catch (error) {
          return {
            ok: false,
            code: "checkout",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        const dir = join(checkout, target.folder);
        if (await hasFiles(dir))
          return refuse(
            `${dir} already has files; choose an empty or new folder.`,
          );
        try {
          await cp(from, dir, {
            recursive: true,
            // The managed history stays behind; the repository has its own.
            filter: (source) => resolve(source) !== join(from, ".git"),
          });
        } catch (error) {
          // A partial copy is not left in the repository.
          await rm(dir, { recursive: true, force: true });
          return refuse(
            `Could not copy the definition into ${dir}; nothing was moved: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const loaded = await loadDefinition(dir, HARNESS_FALLBACK);
        if (!loaded.ok) {
          await rm(dir, { recursive: true, force: true });
          return {
            ...refuse("The moved definition does not load; nothing was moved."),
            problems: loaded.errors,
          };
        }
        // A run may have been queued while the clone and the copy ran.
        const late = busy();
        if (late) {
          await rm(dir, { recursive: true, force: true });
          return late;
        }
        this.factories.moveDefinition(record.id, dir, "repo");
        Object.assign(record, { definition_dir: dir, definition_mode: "repo" });
        return { ok: true, dir };
      },
      (prepared) => (prepared.ok ? prepared.dir : null),
    );
    if (!moved.ok) return moved;
    // Archived only once the copy loaded and the factory runs it: the
    // Nakara-managed folder, with its git history, is renamed, never deleted.
    const archive = this.archiveDir(record.slug);
    try {
      await mkdir(dirname(archive), { recursive: true });
      await rename(from, archive);
    } catch (error) {
      factory.telemetry.log.warn("definition.archive_failed", {
        from,
        archive,
        error,
      });
      return { ...moved, archive: null };
    }
    return { ...moved, archive };
  }
}
