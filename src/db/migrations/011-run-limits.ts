// Caps the runs of a work item (#156): every foreman turn and agent run counts,
// failed and interrupted ones included, so an item on a harness that bills
// nothing per token still stops. Existing items get the default limit and the
// runs they already have.
import { DEFAULT_MAX_RUNS } from "../../domain/policy.ts";
import type { Migration } from "../migrate.ts";

export const runLimits: Migration = {
  version: 11,
  name: "run-limits",
  up(db, { defaultMaxRuns = DEFAULT_MAX_RUNS }) {
    if (!(Number.isInteger(defaultMaxRuns) && defaultMaxRuns > 0))
      throw new Error("The default run limit must be a positive integer.");
    db.exec(`
ALTER TABLE work_items ADD COLUMN max_runs INTEGER NOT NULL DEFAULT ${defaultMaxRuns};
ALTER TABLE work_items ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
UPDATE work_items SET run_count = (SELECT COUNT(*) FROM runs WHERE runs.item_id = work_items.id);`);
  },
  // Losing the limits and counts is all a rollback costs.
  down(db) {
    db.exec(`
ALTER TABLE work_items DROP COLUMN run_count;
ALTER TABLE work_items DROP COLUMN max_runs;`);
  },
};
