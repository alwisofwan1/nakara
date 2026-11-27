// Table rebuilds and id sequences for the migrations that make ids
// AUTOINCREMENT (023, 024): a table keeps its rows and ids, and its
// sqlite_sequence starts at the highest id the database still shows.
import type { DatabaseSync } from "node:sqlite";

export const PLAIN = "id INTEGER PRIMARY KEY,";
export const AUTO = "id INTEGER PRIMARY KEY AUTOINCREMENT,";

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
export const parseId = (text: string | undefined): number | undefined => {
  if (!text || !/^[1-9]\d{0,15}$/.test(text)) return undefined;
  const id = Number(text);
  return id >= 1 && id <= Number.MAX_SAFE_INTEGER ? id : undefined;
};

/** The highest id among `texts`; malformed ones are ignored. */
export const highestOf = (texts: Iterable<string | undefined>): number => {
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
export function* idsInKeys(db: DatabaseSync, prefixes: string[]) {
  const keys = db.prepare("SELECT key FROM kv").all() as { key: string }[];
  for (const { key } of keys)
    for (const prefix of prefixes)
      if (key.startsWith(prefix))
        yield /^([^:]*)(:|$)/.exec(key.slice(prefix.length))?.[1];
}

/** `expression` over the kv rows whose key starts with `prefix`, as text. */
export const kvTexts = (
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
