// Message, approval, evidence, run and event ids are never handed out again
// either (see 023 for factories and items). A factory delete removes its
// items' messages, approvals, events and runs; when they were the newest
// rows, SQLite gave their ids to the next ones, and what holds such an id
// went wrong: the Slack and Telegram relays skipped every new message at or
// below their cursor (slack:cursor, tg:cursor; slack:evidence for evidence),
// and state keyed by an approval (tg:approval:<id>, …) would attach itself to
// a newcomer. The tables are rebuilt with AUTOINCREMENT, keeping every row,
// id, index and the REFERENCES of evidence and learnings to runs, and each
// sqlite_sequence starts at the highest id the database still shows: the
// rows, the ids other tables refer to, the relay cursors and the ids in kv
// keys and values.
import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "../migrate.ts";
import {
  AUTO,
  highestIn,
  highestOf,
  idsInKeys,
  kvTexts,
  PLAIN,
  rebuild,
  seedSequence,
  swap,
} from "./id-sequence.ts";

/** The value of each kv key in `keys` that exists, as text. */
const kvValues = (db: DatabaseSync, keys: string[]): string[] =>
  keys.flatMap((key) => {
    const row = db
      .prepare("SELECT CAST(value AS TEXT) AS v FROM kv WHERE key = ?")
      .get(key) as { v: string | null } | undefined;
    return row?.v == null ? [] : [row.v];
  });

const TABLES = ["messages", "approvals", "evidence", "runs", "events"];

export const noRowIdReuse: Migration = {
  version: 24,
  name: "no-row-id-reuse",
  up(db) {
    const used: Record<string, number> = {
      messages: Math.max(
        highestIn(db, "messages", "id"),
        // The last message each relay sent, all digits.
        highestOf(kvValues(db, ["slack:cursor", "tg:cursor"])),
      ),
      approvals: Math.max(
        highestIn(db, "approvals", "id"),
        // Left behind by a factory delete before #51.
        highestOf(
          idsInKeys(db, ["tg:approval:", "slack:approval:", "slack:reject:"]),
        ),
      ),
      evidence: Math.max(
        highestIn(db, "evidence", "id"),
        // The last evidence the Slack relay posted, all digits.
        highestOf(kvValues(db, ["slack:evidence"])),
      ),
      runs: Math.max(
        highestIn(db, "runs", "id"),
        highestIn(db, "evidence", "run_id"),
        highestIn(db, "learnings", "run_id"),
      ),
      events: Math.max(
        highestIn(db, "events", "id"),
        // The last event of an item a reflect run considered: reflect:<item>:event.
        highestOf(
          kvTexts(db, "reflect:", "value", "key GLOB 'reflect:[0-9]*:event'"),
        ),
      ),
    };
    for (const table of TABLES) rebuild(db, table, swap(PLAIN, AUTO));
    for (const table of TABLES) seedSequence(db, table, used[table] ?? 0);
  },
  // A rollback only loses the memory of freed ids; sqlite_sequence keeps
  // the rows of 023's tables.
  down(db) {
    for (const table of TABLES.toReversed())
      rebuild(db, table, swap(AUTO, PLAIN));
  },
};
