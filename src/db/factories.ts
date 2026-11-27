import { now, Repository, transaction } from "./repository.ts";

/** Where a factory's definition lives: under the data directory, or a folder in a repository. */
export type DefinitionMode = "managed" | "repo";

export interface FactoryRecord {
  id: number;
  slug: string;
  name: string;
  description: string;
  avatar_color: string;
  foreman_handle: string;
  definition_dir: string;
  definition_mode: DefinitionMode;
  /**
   * Where this factory's last move left its managed git history: the
   * archive, or the managed folder itself when archiving failed. Set only
   * while the definition is in a repository; NULL otherwise, and for moves
   * made before migration 018.
   */
  archive_dir: string | null;
  created_at: string;
}

/** The first factory of a database that has none; migration 005 assigns existing items to it. */
export type FactorySeed = Omit<
  FactoryRecord,
  "id" | "created_at" | "archive_dir"
>;

/** Reads and writes the factories table. Migration 005 guarantees at least one factory. */
export class FactoryRepository extends Repository {
  /** Register a factory; its slug must be unused. */
  createFactory(seed: FactorySeed): FactoryRecord {
    const id = this.run(
      `INSERT INTO factories (slug, name, description, avatar_color, foreman_handle, definition_dir, definition_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      seed.slug,
      seed.name,
      seed.description,
      seed.avatar_color,
      seed.foreman_handle,
      seed.definition_dir,
      seed.definition_mode,
      now(),
    );
    // biome-ignore lint/style/noNonNullAssertion: The synchronous insert guarantees the row.
    return this.get<FactoryRecord>("SELECT * FROM factories WHERE id = ?", id)!;
  }

  factories(): FactoryRecord[] {
    return this.all<FactoryRecord>("SELECT * FROM factories ORDER BY id");
  }

  factoryById(id: number): FactoryRecord | undefined {
    return this.get<FactoryRecord>("SELECT * FROM factories WHERE id = ?", id);
  }

  factory(slug: string): FactoryRecord | undefined {
    return this.get<FactoryRecord>(
      "SELECT * FROM factories WHERE slug = ?",
      slug,
    );
  }

  /** Change what the factory shows as; its slug, and so its URLs, stay. */
  renameFactory(
    id: number,
    edit: Pick<FactoryRecord, "name" | "avatar_color">,
  ): void {
    this.run(
      "UPDATE factories SET name = ?, avatar_color = ? WHERE id = ?",
      edit.name,
      edit.avatar_color,
      id,
    );
    this.notifier.notify({ type: "factories", id: "global" });
  }

  /** Point the factory at its definition's new folder; a recorded archive is forgotten. */
  moveDefinition(id: number, dir: string, mode: DefinitionMode): void {
    this.run(
      "UPDATE factories SET definition_dir = ?, definition_mode = ?, archive_dir = NULL WHERE id = ?",
      dir,
      mode,
      id,
    );
    this.notifier.notify({ type: "factories", id: "global" });
  }

  /** Record where the factory's managed history was left by its move. */
  recordArchive(id: number, dir: string): void {
    this.run("UPDATE factories SET archive_dir = ? WHERE id = ?", dir, id);
  }

  /** The number of the factory's items that are neither complete nor cancelled. */
  activeItems(id: number): number {
    return (
      this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM work_items WHERE factory_id = ? AND stage NOT IN ('complete','cancelled')",
        id,
      )?.n ?? 0
    );
  }

  /**
   * The number of the factory's active items that target the `owner/name`
   * repository, compared as GitHub does (case-insensitively). An item without
   * a repository is not counted.
   */
  activeItemsFor(id: number, repo: string): number {
    return (
      this.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM work_items WHERE factory_id = ? AND lower(repo) = lower(?) AND stage NOT IN ('complete','cancelled')",
        id,
        repo,
      )?.n ?? 0
    );
  }

  /**
   * Remove the factory with its closed items and their runs, events,
   * messages, approvals and per-item settings (Telegram links, and the kv
   * keys under `itemKeyPrefixes` that other modules own), its saved limits,
   * its repository status (`repo:<slug>`, see runner/repos.ts), and its
   * approved and pending reach (`reach:<id>` and `reach:<id>:…`, see
   * DefinitionService), which a factory reusing the id must not inherit. The caller refuses a factory
   * with active items; the foreign keys refuse what is left behind.
   */
  deleteFactory(id: number, itemKeyPrefixes: readonly string[] = []): void {
    const items = "SELECT id FROM work_items WHERE factory_id = ?";
    transaction(this.db, () => {
      this.run(
        `DELETE FROM kv WHERE key IN (
         SELECT 'tg:approval:' || id FROM approvals WHERE item_id IN (${items})
         UNION ALL SELECT 'repo:' || slug FROM factories WHERE id = ?)`,
        id,
        id,
      );
      this.run(
        "DELETE FROM kv WHERE key = ? OR substr(key, 1, length(?)) = ?",
        `reach:${id}`,
        `reach:${id}:`,
        `reach:${id}:`,
      );
      // Per-item state owned elsewhere: `<prefix><item>` or `<prefix><item>:…`.
      for (const prefix of itemKeyPrefixes)
        this.run(
          `DELETE FROM kv WHERE EXISTS (
           SELECT 1 FROM work_items w WHERE w.factory_id = ?
           AND (kv.key = ? || w.id OR substr(kv.key, 1, length(? || w.id) + 1) = ? || w.id || ':'))`,
          id,
          prefix,
          prefix,
          prefix,
        );
      for (const table of [
        "approvals",
        "messages",
        "events",
        "runs",
        "stage_transitions",
      ])
        this.run(`DELETE FROM ${table} WHERE item_id IN (${items})`, id);
      this.run("DELETE FROM work_items WHERE factory_id = ?", id);
      this.run("DELETE FROM factory_settings WHERE factory_id = ?", id);
      this.run("DELETE FROM factories WHERE id = ?", id);
    });
    for (const type of ["factories", "items", "runs", "status"] as const)
      this.notifier.notify({ type, id: "global" });
  }

  /** The first factory: the target of old page links and of work without one. */
  defaultFactory(): FactoryRecord {
    // biome-ignore lint/style/noNonNullAssertion: Migration 005 seeds a factory.
    return this.factories()[0]!;
  }
}
