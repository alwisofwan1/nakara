// A move keeps a Nakara-managed definition's git history in an archive
// folder. archive_dir records it on the factory that moved, so "Let Nakara
// manage it" continues only that factory's own history: a new factory that
// reuses a deleted factory's slug never picks up the old archive. NULL means
// no archive is recorded, as for moves made before this migration.
import type { Migration } from "../migrate.ts";

export const factoryArchive: Migration = {
  version: 18,
  name: "factory-archive",
  up(db) {
    db.exec("ALTER TABLE factories ADD COLUMN archive_dir TEXT;");
  },
  // A rollback only forgets which archive belongs to which factory.
  down(db) {
    db.exec("ALTER TABLE factories DROP COLUMN archive_dir;");
  },
};
