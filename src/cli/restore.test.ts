// `npm run restore` against the real script: it takes the database's lock
// before it touches anything, and refuses while a Nakara holds it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { listSnapshots, snapshot } from "../backup.ts";
import { Store, stubFactorySeed } from "../db.ts";

const RESTORE = join(import.meta.dirname, "restore.ts");

function fixture(t: { after: (fn: () => void) => void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "nakara-restore-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = join(dataDir, "nakara.db");
  const backup = { dir: join(dataDir, "backups"), keep: 14 };
  const store = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  store.createItem({
    title: "In the snapshot",
    request: "R",
    source: "manual",
  });
  const taken = snapshot(store.db, { ...backup, reason: "manual" });
  store.createItem({
    title: "After the snapshot",
    request: "R",
    source: "manual",
  });
  store.close();
  return { dataDir, dbPath, backup, taken };
}

const restore = (dataDir: string, file: string) =>
  spawnSync(process.execPath, [RESTORE, file], {
    env: { ...process.env, NAKARA_DATA_DIR: dataDir },
    encoding: "utf8",
  });

const titles = (store: Store) =>
  store
    .items()
    .map((i) => i.title)
    .sort();

test("restore refuses while a Nakara holds the lock and leaves the database untouched", (t) => {
  const { dataDir, dbPath, backup, taken } = fixture(t);
  const live = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  t.after(() => live.close());
  const files = readdirSync(dataDir).sort();

  const result = restore(dataDir, taken.path);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(
      `restore failed: Another Nakara \\(PID ${process.pid} on this host`,
    ),
  );
  // Nothing was replaced, moved aside or snapshotted.
  assert.deepEqual(titles(live), ["After the snapshot", "In the snapshot"]);
  assert.deepEqual(readdirSync(dataDir).sort(), files);
  assert.deepEqual(listSnapshots(backup.dir), [taken]);
  assert.ok(!existsSync(`${dbPath}.restore`));
});

test("restore with no Nakara running replaces the database and releases the lock", (t) => {
  const { dataDir, dbPath, backup, taken } = fixture(t);
  const result = restore(dataDir, taken.path);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\(1 work items\)/);
  assert.deepEqual(
    listSnapshots(backup.dir)
      .map((s) => s.reason)
      .sort(),
    ["manual", "pre-restore"],
  );
  // The lock is free again: Nakara can start on the restored database.
  const store = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  t.after(() => store.close());
  assert.deepEqual(titles(store), ["In the snapshot"]);
});
