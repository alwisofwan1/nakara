// The schema as it stood before versioned migrations, including the columns
// that used to be added ad hoc (work_items.budget_usd, approvals.options).
import { DatabaseSync } from "node:sqlite";

import type { Migration } from "../migrate.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS work_items (
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
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE INDEX IF NOT EXISTS events_pending ON events(item_id) WHERE processed_at IS NULL;
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  role TEXT NOT NULL,
  agent TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  harness TEXT NOT NULL,
  model TEXT,
  session_id TEXT,
  status TEXT NOT NULL,
  input TEXT NOT NULL,
  result TEXT,
  error TEXT,
  cost_usd REAL NOT NULL DEFAULT 0,
  num_turns INTEGER,
  duration_ms INTEGER,
  log_path TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX IF NOT EXISTS runs_agent ON runs(agent, id);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS approvals (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  kind TEXT NOT NULL,
  prompt TEXT NOT NULL,
  ref_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  answer TEXT,
  options TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const tables = (db: DatabaseSync) =>
  new Map(
    (
      db
        .prepare(
          "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as { name: string; sql: string }[]
    ).map((t) => [t.name, t.sql]),
  );

const columns = (db: DatabaseSync, table: string) =>
  (
    db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as {
      name: string;
    }[]
  ).map((c) => c.name);

/** Named indexes, not the automatic ones behind UNIQUE and PRIMARY KEY. */
const indexes = (db: DatabaseSync) =>
  db
    .prepare(
      "SELECT name, tbl_name AS tbl FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
    )
    .all() as { name: string; tbl: string }[];

export const baseline: Migration = {
  version: 1,
  name: "baseline",
  up(db, { defaultBudgetUsd }) {
    const canonical = new DatabaseSync(":memory:");
    canonical.exec(SCHEMA);
    const wanted = tables(canonical);
    const target = new Map(
      [...wanted.keys()].map((t) => [t, columns(canonical, t)]),
    );
    const wantedIndexes = new Set(indexes(canonical).map((i) => i.name));
    canonical.close();
    // A rebuild would drop what the baseline does not know: refuse instead,
    // before any change.
    const unknown = [...target].flatMap(([table, cols]) => {
      const extra = [
        ...columns(db, table)
          .filter((c) => !cols.includes(c))
          .map((c) => `column ${c}`),
        ...indexes(db)
          .filter((i) => i.tbl === table && !wantedIndexes.has(i.name))
          .map((i) => `index ${i.name}`),
      ];
      return extra.length ? [`${table}: ${extra.join(", ")}`] : [];
    });
    if (unknown.length)
      throw new Error(
        `The database has columns or indexes this Nakara does not know (${unknown.join("; ")}). Remove them, or upgrade Nakara.`,
      );
    // A pre-versioned database whose tables drifted from the baseline (columns
    // appended by ALTER TABLE, a budget default baked into the DDL) gets those
    // tables rebuilt, so it ends up with exactly the schema of a fresh one.
    const fill: Record<string, number> = {
      // Items that predate per-item budgets get the configured default.
      "work_items.budget_usd": defaultBudgetUsd,
    };
    // Renaming a parent table must not rewrite its children's REFERENCES.
    db.exec("PRAGMA legacy_alter_table = ON");
    try {
      for (const [table, sql] of tables(db)) {
        const want = wanted.get(table);
        if (!want || sql === want) continue;
        const have = new Set(columns(db, table));
        const aside = `${table}_pre_baseline`;
        db.exec(`ALTER TABLE ${table} RENAME TO ${aside}`);
        db.exec(want);
        const cols = target.get(table) ?? [];
        const params: number[] = [];
        const values = cols.map((c) => {
          if (have.has(c)) return c;
          const value = fill[`${table}.${c}`];
          if (value === undefined) return "NULL";
          params.push(value);
          return "?";
        });
        db.prepare(
          `INSERT INTO ${table} (${cols.join(", ")}) SELECT ${values.join(", ")} FROM ${aside}`,
        ).run(...params);
        db.exec(`DROP TABLE ${aside}`);
      }
    } finally {
      db.exec("PRAGMA legacy_alter_table = OFF");
    }
    // Creates every table on a fresh database, and indexes dropped by a rebuild.
    db.exec(SCHEMA);
  },
};
