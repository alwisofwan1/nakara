// Evidence ids are never handed out again. The Slack bridge keeps a global
// cursor in kv (`slack:evidence`, see intake/slack.ts) and posts only proof
// with a higher id. Without AUTOINCREMENT, deleting a factory whose items held
// the newest proof freed its id, the next proof got it again, and Slack never
// posted it. The table is rebuilt with AUTOINCREMENT as migration 023 rebuilt
// factories and work_items, and its sequence starts at the highest evidence id
// the database still shows: the rows' and the cursor's. The cursor is made
// canonical first, so Slack reads the id the sequence was seeded from: one
// Slack reads as a whole number (Number(), as intake/slack.ts does) is
// rewritten as that number; any other (empty, not a number, negative, a
// fraction, beyond Number.MAX_SAFE_INTEGER) is deleted, and Slack starts it
// again from the newest proof.
import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "../migrate.ts";
import {
  AUTO,
  highestIn,
  PLAIN,
  rebuild,
  seedSequence,
  swap,
} from "./023-no-id-reuse.ts";

const CURSOR = "slack:evidence";

/** The Slack evidence cursor as Slack reads it, stored canonically; 0 when none. */
function slackCursor(db: DatabaseSync): number {
  const row = db
    .prepare("SELECT CAST(value AS TEXT) AS v FROM kv WHERE key = ?")
    .get(CURSOR) as { v: string | null } | undefined;
  if (!row) return 0;
  const id = row.v ? Number(row.v) : Number.NaN;
  if (!Number.isSafeInteger(id) || id < 0) {
    db.prepare("DELETE FROM kv WHERE key = ?").run(CURSOR);
    return 0;
  }
  db.prepare("UPDATE kv SET value = ? WHERE key = ?").run(String(id), CURSOR);
  return id;
}

export const noEvidenceIdReuse: Migration = {
  version: 24,
  name: "no-evidence-id-reuse",
  up(db) {
    const used = Math.max(highestIn(db, "evidence", "id"), slackCursor(db));
    rebuild(db, "evidence", swap(PLAIN, AUTO));
    seedSequence(db, "evidence", used);
  },
  // A rollback only loses the memory of freed ids.
  down(db) {
    rebuild(db, "evidence", swap(AUTO, PLAIN));
  },
};
