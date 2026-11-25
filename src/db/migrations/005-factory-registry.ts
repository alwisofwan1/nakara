// The factory registry: a factories table, and a non-null work_items.factory_id.
// The first factory comes from the running definition (see
// src/definition/seed.ts), and every existing item is assigned to it. SQLite
// cannot add a NOT NULL foreign key column, so work_items is rebuilt with its
// rows; ids are kept, so item ids stay global and old links keep working.
import type { Migration } from "../migrate.ts";
import { now } from "../repository.ts";

export const factoryRegistry: Migration = {
  version: 5,
  name: "factory-registry",
  up(db, context) {
    if (!context.factory)
      throw new Error(
        "The first factory needs a seed from the factory definition.",
      );
    const seed = context.factory();
    db.exec(`
      CREATE TABLE factories (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        avatar_color TEXT NOT NULL,
        foreman_handle TEXT NOT NULL,
        definition_dir TEXT NOT NULL,
        definition_mode TEXT NOT NULL CHECK (definition_mode IN ('managed', 'repo')),
        created_at TEXT NOT NULL
      );
    `);
    const factoryId = Number(
      db
        .prepare(
          `INSERT INTO factories (slug, name, description, avatar_color, foreman_handle, definition_dir, definition_mode, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seed.slug,
          seed.name,
          seed.description,
          seed.avatar_color,
          seed.foreman_handle,
          seed.definition_dir,
          seed.definition_mode,
          now(),
        ).lastInsertRowid,
    );
    db.exec(`
      CREATE TABLE work_items_rebuilt (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        request TEXT NOT NULL,
        requester TEXT,
        source TEXT NOT NULL,
        source_ref TEXT UNIQUE,
        source_url TEXT,
        repo TEXT,
        automation TEXT,
        stage TEXT NOT NULL DEFAULT 'intake',
        status TEXT NOT NULL DEFAULT 'active',
        spec_state TEXT NOT NULL DEFAULT 'none',
        review_count INTEGER NOT NULL DEFAULT 0,
        revision_count INTEGER NOT NULL DEFAULT 0,
        cost_usd REAL NOT NULL DEFAULT 0,
        budget_usd REAL NOT NULL,
        issue_url TEXT,
        pr_url TEXT,
        pr_merged INTEGER NOT NULL DEFAULT 0,
        foreman_session TEXT,
        foreman_turns INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        factory_id INTEGER NOT NULL REFERENCES factories(id)
      );
    `);
    db.prepare(
      `INSERT INTO work_items_rebuilt SELECT id, title, request, requester, source, source_ref, source_url,
        repo, automation, stage, status, spec_state, review_count, revision_count, cost_usd, budget_usd,
        issue_url, pr_url, pr_merged, foreman_session, foreman_turns, created_at, updated_at, ? FROM work_items`,
    ).run(factoryId);
    db.exec(`
      DROP TABLE work_items;
      ALTER TABLE work_items_rebuilt RENAME TO work_items;
      CREATE INDEX work_items_factory ON work_items(factory_id);
    `);
  },
};
