// Lessons a reflect run proposed after a correction (#162). Each waits for the
// Operator in the Inbox; approved lines are written to the factory's
// skills/learnings/SKILL.md, so the row is the proposal and its decision.
import type { Migration } from "../migrate.ts";

export const learnings: Migration = {
  version: 13,
  name: "learnings",
  up(db) {
    db.exec(`
CREATE TABLE learnings (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  lines TEXT NOT NULL,
  mistake TEXT NOT NULL,
  suggest_check INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  reason TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE UNIQUE INDEX learnings_one_pending ON learnings(item_id) WHERE status = 'pending';
CREATE INDEX learnings_status ON learnings(status);`);
  },
  // The skill file keeps every approved line; only the proposals are lost.
  down(db) {
    db.exec("DROP TABLE learnings;");
  },
};
