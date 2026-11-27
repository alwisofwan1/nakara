// Factory and item ids are never handed out again. Without AUTOINCREMENT,
// SQLite gives a new row max(id) + 1, so deleting the newest factory, or a
// factory with the newest items, freed ids that the next one got again, and
// state keyed by them (applied/<id>, reach:<id>, run-limit-told:<id>, …)
// attached itself to the newcomer. Both tables are rebuilt with
// AUTOINCREMENT, keeping every row, id, index and trigger, and sqlite_sequence
// starts at the highest id ever used that the database still shows: the
// rows, the ids other tables refer to, and the ids in kv keys. The applied/
// folders under the data dir are counted at startup (see
// orchestrator/freed-ids.ts).
import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "../migrate.ts";

const PLAIN = "id INTEGER PRIMARY KEY,";
const AUTO = "id INTEGER PRIMARY KEY AUTOINCREMENT,";

/** kv keys `<prefix><item id>` or `<prefix><item id>:…`, as of this migration. */
const ITEM_KEY_PREFIXES = [
  "ci-wait:",
  "ci-failed:",
  "push-only:",
  "pr-closed:",
  "merge-submitted:",
  "run-limit-told:",
  "reflect:",
  "slack:item:",
];
/** kv keys `<prefix><factory id>` or `<prefix><factory id>:…`, as of this migration. */
const FACTORY_KEY_PREFIXES = ["reach:", "reflect:factory:"];

/**
 * Rebuild `table` with its CREATE TABLE text changed by `edit`, under the
 * same name, so its children's REFERENCES and its SQL stay as they were. The
 * rows go aside and back with their ids; the indexes and triggers are made
 * again after the rows are back, so no trigger fires for them. Needs foreign
 * keys off, as migrate() and migrateDown() run.
 */
function rebuild(
  db: DatabaseSync,
  table: string,
  edit: (sql: string) => string,
): void {
  const objects = db
    .prepare(
      "SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type = 'trigger', name",
    )
    .all(table) as { type: string; sql: string }[];
  const create = objects.find((o) => o.type === "table");
  if (!create) throw new Error(`No table ${table}.`);
  const sql = edit(create.sql);
  const aside = `${table}_no_id_reuse`;
  db.exec(`CREATE TABLE ${aside} AS SELECT * FROM ${table}`);
  db.exec(`DROP TABLE ${table}`);
  db.exec(sql);
  db.exec(`INSERT INTO ${table} SELECT * FROM ${aside}`);
  db.exec(`DROP TABLE ${aside}`);
  for (const o of objects) if (o.type !== "table") db.exec(o.sql);
}

/** Replace the one `from` in a CREATE TABLE text, or fail. */
const swap = (from: string, to: string) => (sql: string) => {
  const at = sql.indexOf(from);
  if (at < 0 || sql.indexOf(from, at + 1) >= 0)
    throw new Error(`Expected one "${from}" in: ${sql}`);
  return sql.slice(0, at) + to + sql.slice(at + from.length);
};

const highest = (db: DatabaseSync, query: string): number =>
  Number(
    (db.prepare(query).get() as { n: number | bigint | null } | undefined)
      ?.n ?? 0,
  );

/** The highest id in the kv keys under `prefixes`; other keys are ignored. */
function highestInKeys(db: DatabaseSync, prefixes: string[]): number {
  let max = 0;
  const keys = db.prepare("SELECT key FROM kv").all() as { key: string }[];
  for (const { key } of keys)
    for (const prefix of prefixes) {
      if (!key.startsWith(prefix)) continue;
      const id = /^(\d+)(:|$)/.exec(key.slice(prefix.length))?.[1];
      if (id) max = Math.max(max, Number(id));
    }
  return max;
}

/** Start `table`'s ids after `used`, unless they already start later. */
function seedSequence(
  db: DatabaseSync,
  table: string,
  used: number,
): void {
  const seq = highest(
    db,
    `SELECT seq AS n FROM sqlite_sequence WHERE name = '${table}'`,
  );
  if (used <= seq) return;
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(
    table,
    used,
  );
}

export const noIdReuse: Migration = {
  version: 23,
  name: "no-id-reuse",
  up(db) {
    const factoryHigh = Math.max(
      highest(
        db,
        `SELECT max(n) AS n FROM (
          SELECT max(id) AS n FROM factories
          UNION ALL SELECT max(factory_id) FROM factory_settings
          UNION ALL SELECT max(factory_id) FROM work_items)`,
      ),
      highestInKeys(db, FACTORY_KEY_PREFIXES),
    );
    const itemHigh = Math.max(
      highest(
        db,
        `SELECT max(n) AS n FROM (
          SELECT max(id) AS n FROM work_items
          ${["runs", "approvals", "messages", "events", "stage_transitions", "evidence", "learnings"]
            .map((t) => `UNION ALL SELECT max(item_id) FROM ${t}`)
            .join("\n")}
          UNION ALL SELECT max(CAST(value AS INTEGER)) FROM kv
            WHERE substr(key, 1, 13) = 'slack:thread:' AND value GLOB '[0-9]*'
          UNION ALL SELECT max(CAST(json_extract(value, '$.item') AS INTEGER)) FROM kv
            WHERE substr(key, 1, 5) = 'tg:m:' AND json_valid(value))`,
      ),
      highestInKeys(db, ITEM_KEY_PREFIXES),
    );
    rebuild(db, "factories", swap(PLAIN, AUTO));
    rebuild(db, "work_items", swap(PLAIN, AUTO));
    seedSequence(db, "factories", factoryHigh);
    seedSequence(db, "work_items", itemHigh);
  },
  // A rollback only loses the memory of freed ids; sqlite_sequence stays, empty.
  down(db) {
    rebuild(db, "work_items", swap(AUTO, PLAIN));
    rebuild(db, "factories", swap(AUTO, PLAIN));
  },
};
