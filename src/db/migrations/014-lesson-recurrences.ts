// How often an approved lesson's mistake came back (#162): a later reflect run
// names the lessons its correction repeats. T4 is done when this stays 0.
import type { Migration } from "../migrate.ts";

export const lessonRecurrences: Migration = {
  version: 14,
  name: "lesson-recurrences",
  up(db) {
    db.exec(
      "ALTER TABLE learnings ADD COLUMN recurrences INTEGER NOT NULL DEFAULT 0;",
    );
  },
  down(db) {
    db.exec("ALTER TABLE learnings DROP COLUMN recurrences;");
  },
};
