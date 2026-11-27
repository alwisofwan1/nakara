// Evidence ids are never handed out again. The Slack bridge keeps a global
// cursor in kv (`slack:evidence`, see intake/slack.ts) and posts only proof
// with a higher id. Without AUTOINCREMENT, deleting a factory whose items held
// the newest proof freed its id, the next proof got it again, and Slack never
// posted it. The table is rebuilt with AUTOINCREMENT as migration 023 rebuilt
// factories and work_items, and its sequence starts at the highest evidence id
// the database still shows: the rows' and the cursor's.
import type { Migration } from "../migrate.ts";
import {
  AUTO,
  highestIn,
  PLAIN,
  parseId,
  rebuild,
  seedSequence,
  swap,
} from "./023-no-id-reuse.ts";

export const noEvidenceIdReuse: Migration = {
  version: 24,
  name: "no-evidence-id-reuse",
  up(db) {
    const cursor = db
      .prepare("SELECT CAST(value AS TEXT) AS v FROM kv WHERE key = ?")
      .get("slack:evidence") as { v: string | null } | undefined;
    const used = Math.max(
      highestIn(db, "evidence", "id"),
      parseId(cursor?.v ?? undefined) ?? 0,
    );
    rebuild(db, "evidence", swap(PLAIN, AUTO));
    seedSequence(db, "evidence", used);
  },
  // A rollback only loses the memory of freed ids.
  down(db) {
    rebuild(db, "evidence", swap(AUTO, PLAIN));
  },
};
