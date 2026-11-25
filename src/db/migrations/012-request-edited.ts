// Flags a work item whose GitHub issue was edited after labelling by someone
// without write access (#115). Existing items were never checked, so they stay
// unflagged.
import type { Migration } from "../migrate.ts";

export const requestEdited: Migration = {
  version: 12,
  name: "request-edited",
  up(db) {
    db.exec(
      "ALTER TABLE work_items ADD COLUMN request_edited INTEGER NOT NULL DEFAULT 0;",
    );
  },
  down(db) {
    db.exec("ALTER TABLE work_items DROP COLUMN request_edited;");
  },
};
