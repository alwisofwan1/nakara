// The Operator can pause a factory (ADR-0006 rule 4): its Work Items start no
// Foreman Turn or Agent Run until it resumes, while intake keeps creating them.
// paused_at holds when it was paused; NULL means it runs.
import type { Migration } from "../migrate.ts";

export const factoryPaused: Migration = {
  version: 17,
  name: "factory-paused",
  up(db) {
    db.exec("ALTER TABLE factory_settings ADD COLUMN paused_at TEXT;");
  },
  // A rollback only loses which factories were paused.
  down(db) {
    db.exec("ALTER TABLE factory_settings DROP COLUMN paused_at;");
  },
};
