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

export const PLAIN = "id INTEGER PRIMARY KEY,";
export const AUTO = "id INTEGER PRIMARY KEY AUTOINCREMENT,";

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
export function rebuild(
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
export const swap = (from: string, to: string) => (sql: string) => {
  const at = sql.indexOf(from);
  if (at < 0 || sql.indexOf(from, at + 1) >= 0)
    throw new Error(`Expected one "${from}" in: ${sql}`);
  return sql.slice(0, at) + to + sql.slice(at + from.length);
};

/**
 * An id written as Nakara writes one, decimal digits without leading zeros,
 * from 1 up to Number.MAX_SAFE_INTEGER; anything else is no id. Ids read from free-form text (kv keys and values)
 * must neither fail the read nor start the sequence near SQLite's limit.
 */
const parseId = (text: string | undefined): number | undefined => {
  if (!text || !/^[1-9]\d{0,15}$/.test(text)) return undefined;
  const id = Number(text);
  return id >= 1 && id <= Number.MAX_SAFE_INTEGER ? id : undefined;
};

/** The highest id among `texts`; malformed ones are ignored. */
const highestOf = (texts: Iterable<string | undefined>): number => {
  let max = 0;
  for (const text of texts) max = Math.max(max, parseId(text) ?? 0);
  return max;
};

/** The highest in-range integer in `column` of `table`; other values are ignored. */
export const highestIn = (
  db: DatabaseSync,
  table: string,
  column: string,
): number =>
  Number(
    (
      db
        .prepare(
          `SELECT max(${column}) AS n FROM ${table}
           WHERE typeof(${column}) = 'integer' AND ${column} BETWEEN 1 AND ?`,
        )
        .get(Number.MAX_SAFE_INTEGER) as { n: number | null } | undefined
    )?.n ?? 0,
  );

/** The ids in the kv keys under `prefixes`: `<prefix><id>` or `<prefix><id>:…`. */
function* idsInKeys(db: DatabaseSync, prefixes: string[]) {
  const keys = db.prepare("SELECT key FROM kv").all() as { key: string }[];
  for (const { key } of keys)
    for (const prefix of prefixes)
      if (key.startsWith(prefix))
        yield /^([^:]*)(:|$)/.exec(key.slice(prefix.length))?.[1];
}

/** `expression` over the kv rows whose key starts with `prefix`, as text. */
const kvTexts = (
  db: DatabaseSync,
  prefix: string,
  expression: string,
  where = "1",
): string[] =>
  (
    db
      .prepare(
        `SELECT CAST(${expression} AS TEXT) AS v FROM kv
         WHERE substr(key, 1, ?) = ? AND ${where}`,
      )
      .all(prefix.length, prefix) as { v: string | null }[]
  ).flatMap((r) => (r.v === null ? [] : [r.v]));

/** Start `table`'s ids after `used`, unless they already start later. */
export function seedSequence(
  db: DatabaseSync,
  table: string,
  used: number,
): void {
  // Set by the rebuild from the rows' own ids.
  const seq = Number(
    (
      db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as
        | { seq: number }
        | undefined
    )?.seq ?? 0,
  );
  if (used <= seq) return;
  db.prepare("DELETE FROM sqlite_sequence WHERE name = ?").run(table);
  db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)").run(
    table,
    used,
  );
}

const ITEM_ID_COLUMNS: [string, string][] = [
  ["work_items", "id"],
  ...[
    "runs",
    "approvals",
    "messages",
    "events",
    "stage_transitions",
    "evidence",
    "learnings",
  ].map((t): [string, string] => [t, "item_id"]),
];
const FACTORY_ID_COLUMNS: [string, string][] = [
  ["factories", "id"],
  ["factory_settings", "factory_id"],
  ["work_items", "factory_id"],
];

export const noIdReuse: Migration = {
  version: 23,
  name: "no-id-reuse",
  up(db) {
    const factoryHigh = Math.max(
      ...FACTORY_ID_COLUMNS.map(([t, c]) => highestIn(db, t, c)),
      highestOf(idsInKeys(db, FACTORY_KEY_PREFIXES)),
    );
    const itemHigh = Math.max(
      ...ITEM_ID_COLUMNS.map(([t, c]) => highestIn(db, t, c)),
      highestOf(idsInKeys(db, ITEM_KEY_PREFIXES)),
      // A Slack thread's item: the value, all digits.
      highestOf(kvTexts(db, "slack:thread:", "value")),
      // A Telegram message's item: a JSON integer, never a string or real.
      highestOf(
        kvTexts(
          db,
          "tg:m:",
          "json_extract(value, '$.item')",
          "json_valid(value) AND json_type(value, '$.item') = 'integer'",
        ),
      ),
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
