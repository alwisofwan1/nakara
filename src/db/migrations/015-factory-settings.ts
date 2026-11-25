// Per-factory limits (ADR-0006): how Policy limits a factory lives in the
// database, not in its Definition. A NULL column falls back to the environment
// default, so an instance without settings behaves as before. Work Items
// snapshot their review and revision limits at creation, like budget_usd and
// max_runs, so a changed setting never touches work in flight; existing items
// get today's defaults.
import {
  DEFAULT_MAX_REVIEWS,
  DEFAULT_MAX_REVISIONS,
} from "../../domain/policy.ts";
import type { Migration } from "../migrate.ts";

export const factorySettings: Migration = {
  version: 15,
  name: "factory-settings",
  up(
    db,
    {
      defaultMaxReviews = DEFAULT_MAX_REVIEWS,
      defaultMaxRevisions = DEFAULT_MAX_REVISIONS,
    },
  ) {
    for (const [name, value] of [
      ["review", defaultMaxReviews],
      ["revision", defaultMaxRevisions],
    ] as const)
      if (!(Number.isFinite(value) && value >= 0))
        throw new Error(
          `The default ${name} limit must be a non-negative number.`,
        );
    db.exec(`
CREATE TABLE factory_settings (
  factory_id INTEGER PRIMARY KEY REFERENCES factories(id),
  budget_usd REAL,
  max_reviews INTEGER,
  max_revisions INTEGER,
  max_runs INTEGER,
  updated_at TEXT NOT NULL
);
ALTER TABLE work_items ADD COLUMN max_reviews INTEGER NOT NULL DEFAULT ${defaultMaxReviews};
ALTER TABLE work_items ADD COLUMN max_revisions INTEGER NOT NULL DEFAULT ${defaultMaxRevisions};`);
  },
  // The saved limits and the items' snapshots are all a rollback loses.
  down(db) {
    db.exec(`
ALTER TABLE work_items DROP COLUMN max_revisions;
ALTER TABLE work_items DROP COLUMN max_reviews;
DROP TABLE factory_settings;`);
  },
};
