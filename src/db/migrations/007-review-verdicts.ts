// Records the verdict a review run reported (src/domain/review.ts), so the
// work item page can show the review outcome. Runs before this migration have
// none, and their items show no outcome.
import type { Migration } from "../migrate.ts";

export const reviewVerdicts: Migration = {
  version: 7,
  name: "review-verdicts",
  up(db) {
    db.exec("ALTER TABLE runs ADD COLUMN review_verdict TEXT");
  },
};
