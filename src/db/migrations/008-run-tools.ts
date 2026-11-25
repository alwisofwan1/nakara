// Counts the external MCP tools each run called (#134), so the run page lists
// them. Runs before this migration have none.
import type { Migration } from "../migrate.ts";

export const runTools: Migration = {
  version: 8,
  name: "run-tools",
  up(db) {
    db.exec("ALTER TABLE runs ADD COLUMN tools TEXT");
  },
};
