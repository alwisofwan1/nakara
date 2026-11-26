// A Work Item created by an Automation keeps a copy of the Automation's
// instructions and display name (ADR-0006, like its limits), so deleting,
// editing or recreating the Automation never changes work it already created.
// NULL for items no Automation created and for items created before this
// migration; those render the instructions found by name, as before.
import type { Migration } from "../migrate.ts";

export const automationSnapshot: Migration = {
  version: 20,
  name: "automation-snapshot",
  up(db) {
    db.exec(`
ALTER TABLE work_items ADD COLUMN automation_instructions TEXT;
ALTER TABLE work_items ADD COLUMN automation_display_name TEXT;`);
  },
  // A rollback only loses the copies; the items fall back to the lookup by name.
  down(db) {
    db.exec(`
ALTER TABLE work_items DROP COLUMN automation_display_name;
ALTER TABLE work_items DROP COLUMN automation_instructions;`);
  },
};
