// The Handoff Gate checks a factory adds (ADR-0006 rules 1 and 2): besides
// the fixed part (the work pushed to the Pull Request and its CI passing), a
// factory may also require an accepted Review and a passed Verification. Each
// is a factory_settings switch, NULL meaning off. A Work Item snapshots the
// factory's checks at creation as a JSON array of "review" | "verification",
// so changing Settings never touches work in flight; existing items keep '[]'.
import type { Migration } from "../migrate.ts";

export const handoffGateChecks: Migration = {
  version: 21,
  name: "handoff-gate-checks",
  up(db) {
    db.exec(`
ALTER TABLE factory_settings ADD COLUMN gate_review INTEGER;
ALTER TABLE factory_settings ADD COLUMN gate_verification INTEGER;
ALTER TABLE work_items ADD COLUMN gate_checks TEXT NOT NULL DEFAULT '[]';`);
  },
  // A rollback only loses the saved switches and the items' snapshots.
  down(db) {
    db.exec(`
ALTER TABLE work_items DROP COLUMN gate_checks;
ALTER TABLE factory_settings DROP COLUMN gate_verification;
ALTER TABLE factory_settings DROP COLUMN gate_review;`);
  },
};
