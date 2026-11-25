// Records the git trees of a run's worktrees when it starts and ends, so the
// run page can show what the run changed (see src/runner/snapshot.ts). Runs
// before this migration have none and show the edits from their log.
import type { Migration } from "../migrate.ts";

export const runSnapshots: Migration = {
  version: 6,
  name: "run-snapshots",
  up(db) {
    db.exec("ALTER TABLE runs ADD COLUMN snapshots TEXT");
  },
};
