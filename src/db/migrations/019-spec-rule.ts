// The Spec rule (ADR-0006 rule 3): whether a factory always writes a Spec
// before code, never does, or leaves it to the Foreman and the request
// ('when_asked', today's behaviour). The factory's rule lives in
// factory_settings, NULL meaning 'when_asked'. A Work Item snapshots it at
// creation and records whether its request asked for a Spec, so changing the
// rule never touches work in flight; existing items keep today's behaviour.
import type { Migration } from "../migrate.ts";

export const specRule: Migration = {
  version: 19,
  name: "spec-rule",
  up(db) {
    db.exec(`
ALTER TABLE factory_settings ADD COLUMN spec_rule TEXT CHECK (spec_rule IN ('always', 'when_asked', 'never'));
ALTER TABLE work_items ADD COLUMN spec_rule TEXT NOT NULL DEFAULT 'when_asked' CHECK (spec_rule IN ('always', 'when_asked', 'never'));
ALTER TABLE work_items ADD COLUMN spec_requested INTEGER NOT NULL DEFAULT 0;`);
  },
  // A rollback only loses the saved rules, the items' snapshots and requests.
  down(db) {
    db.exec(`
ALTER TABLE work_items DROP COLUMN spec_requested;
ALTER TABLE work_items DROP COLUMN spec_rule;
ALTER TABLE factory_settings DROP COLUMN spec_rule;`);
  },
};
