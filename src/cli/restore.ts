// Usage: npm run restore -- <snapshot.db>   (stop Nakara first)
// Restores into $NAKARA_DATA_DIR/nakara.db after snapshotting the current one.
import { resolve } from "node:path";

import { listSnapshots, restoreSnapshot } from "../backup.ts";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { lockDatabase, unlockDatabase } from "../db/instance.ts";
import { lazyFactorySeed } from "../definition/seed.ts";

const config = loadConfig();
const file = process.argv[2];
if (!file) {
  console.log("Usage: npm run restore -- <snapshot.db>");
  console.log(`Snapshots in ${config.backup.dir}:`);
  for (const s of listSnapshots(config.backup.dir)) console.log(`  ${s.path}`);
  process.exit(1);
}
function fail(error: unknown): never {
  console.error(
    `restore failed: ${error instanceof Error ? error.message : error}`,
  );
  process.exit(1);
}
// Take the lock first: a running Nakara refuses the restore before any file is touched.
const lock = (() => {
  try {
    return lockDatabase(config.dbPath);
  } catch (error) {
    return fail(error);
  }
})();
let result: ReturnType<typeof restoreSnapshot>;
try {
  result = restoreSnapshot(resolve(file), config.dbPath, config.backup);
} catch (error) {
  unlockDatabase(lock);
  fail(error);
}
const { previous, unreadable } = result;
if (previous) console.log(`previous database saved as ${previous.path}`);
if (unreadable)
  console.warn(
    `previous database was unreadable (${unreadable.error}); moved to ${unreadable.path}`,
  );
// Boot a Store on the result: schema and migrations must accept it. It keeps
// the lock until close, so no Nakara starts before the check is done.
const store = new Store(config.dbPath, {
  defaultBudgetUsd: config.limits.budgetUsd,
  defaultMaxRuns: config.limits.maxRuns,
  backup: config.backup,
  lock,
  // A snapshot from before the factory registry migrates like a normal start.
  factory: await lazyFactorySeed(config),
});
const items = store.db.prepare("SELECT count(*) AS n FROM work_items").get();
store.close();
console.log(`restored ${file} to ${config.dbPath} (${items?.n} work items)`);
