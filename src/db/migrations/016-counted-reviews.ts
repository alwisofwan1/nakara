// Which runs used up one of their work item's reviews (#21): a dispatched
// review run counts toward max_reviews when it is queued, and gives the review
// back when it ends without a verdict (stopped, cancelled or failed), so only
// a review that ran counts. Follow-ups never counted, so they carry 0.
import type { Migration } from "../migrate.ts";

export const countedReviews: Migration = {
  version: 16,
  name: "counted-reviews",
  up(db) {
    db.exec(
      "ALTER TABLE runs ADD COLUMN counts_review INTEGER NOT NULL DEFAULT 0;",
    );
  },
  down(db) {
    db.exec("ALTER TABLE runs DROP COLUMN counts_review;");
  },
};
