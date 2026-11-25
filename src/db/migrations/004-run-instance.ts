// Records which Nakara instance started a run, so startup recovery only
// interrupts runs whose instance is gone (see src/db/instance.ts).
import type { Migration } from "../migrate.ts";

export const runInstance: Migration = {
  version: 4,
  name: "run-instance",
  up(db) {
    db.exec("ALTER TABLE runs ADD COLUMN instance_id TEXT");
  },
};
