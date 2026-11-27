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
