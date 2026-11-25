// Usage: npm run downgrade -- <schema version>   (stop Nakara first)
// Run from the release that migrated the database, before switching
// `current` back to an older release: it undoes the newer migrations so the
// older release accepts the database. Snapshots the database first.
import { DatabaseSync } from "node:sqlite";

import { loadConfig } from "../config.ts";
import { lockDatabase, unlockDatabase } from "../db/instance.ts";
import { MIGRATIONS, migrateDown, schemaVersion } from "../db/migrate.ts";

const config = loadConfig();
const target = Number(process.argv[2]);
if (!process.argv[2]) {
  console.log("Usage: npm run downgrade -- <schema version>");
  console.log(
    `This release knows versions up to ${MIGRATIONS.length}; reversible: ${
      MIGRATIONS.filter((m) => m.down)
        .map((m) => m.version)
        .join(", ") || "none"
    }.`,
  );
  process.exit(1);
}
let lock: DatabaseSync | undefined;
try {
  // A running Nakara holds the lock: refuse before touching the database.
  lock = lockDatabase(config.dbPath);
  const db = new DatabaseSync(config.dbPath);
  try {
    const from = schemaVersion(db);
    migrateDown(db, target, { backup: config.backup });
    console.log(
      `schema version ${from} -> ${schemaVersion(db)} in ${config.dbPath}`,
    );
  } finally {
    db.close();
  }
} catch (error) {
  console.error(
    `downgrade failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exitCode = 1;
} finally {
  if (lock) unlockDatabase(lock);
}
