import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import type { HttpBindings } from "@hono/node-server";

import {
  Backups,
  backupHealth,
  integrityCheck,
  latestSnapshot,
  listSnapshots,
  restoreSnapshot,
  snapshot,
} from "./backup.ts";
import { loadConfig } from "./config.ts";
import { Store, stubFactorySeed } from "./db.ts";
import { GithubPoller } from "./intake/github.ts";
import { FactoryRegistry } from "./orchestrator/registry.ts";
import { createApp } from "./web/test-support.ts";

function tempDir(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-backup-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const count = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true });
  const row = db.prepare("SELECT count(*) AS n FROM work_items").get();
  db.close();
  return Number(row?.n);
};

const item = { title: "T", request: "R", source: "manual" } as const;

test("scheduled snapshots stay consistent while another connection writes", async (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "nakara.db");
  const backupDir = join(dir, "backups");
  const store = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  // A second connection inserts work items in a tight loop on another thread.
  const writer = new Worker(
    `const { DatabaseSync } = require("node:sqlite");
     const { workerData, parentPort } = require("node:worker_threads");
     const db = new DatabaseSync(workerData);
     db.exec("PRAGMA busy_timeout = 5000");
     const insert = db.prepare("INSERT INTO work_items (title, request, source, budget_usd, factory_id, created_at, updated_at) VALUES ('W', 'R', 'manual', 1, (SELECT MIN(id) FROM factories), 'now', 'now')");
     let stop = false;
     parentPort.on("message", () => { stop = true; });
     const loop = () => {
       for (let i = 0; i < 50; i++) insert.run();
       if (stop) { db.close(); parentPort.postMessage("done"); } else setImmediate(loop);
     };
     loop();`,
    { eval: true, workerData: dbPath },
  );
  const backups = new Backups(store.db, {
    dir: backupDir,
    keep: 50,
    intervalHours: 0.2 / 3600,
  });
  backups.start();
  await sleep(1500);
  backups.stop();
  const done = new Promise((resolve) => writer.once("message", resolve));
  writer.postMessage("stop");
  await done;
  await writer.terminate();

  const snapshots = listSnapshots(backupDir).reverse();
  assert.ok(snapshots.length >= 3, `only ${snapshots.length} snapshots`);
  const counts = snapshots.map((s) => {
    assert.equal(integrityCheck(s.path), "ok");
    assert.match(s.path, /-scheduled\.db$/);
    return count(s.path);
  });
  assert.ok(Math.max(...counts) > Math.min(...counts), `no writes: ${counts}`);
  assert.deepEqual(
    counts,
    [...counts].sort((a, b) => a - b),
  );
  store.close();
});

test("snapshot prunes only scheduled copies and names them by time and reason", async (t) => {
  const dir = tempDir(t);
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  // Unrelated files in the directory are neither listed nor pruned.
  writeFileSync(join(dir, "notes.txt"), "keep me");
  const take = async (reason: string) => {
    store.createItem(item);
    const taken = snapshot(store.db, { dir, keep: 2, reason });
    await sleep(5);
    return taken;
  };
  const restore = await take("pre-restore");
  const first = await take("scheduled");
  const migration = await take("pre migration 3");
  const second = await take("scheduled");
  const third = await take("scheduled");
  const manual = await take("manual");
  assert.match(migration.path, /nakara-\d{4}-.+Z-pre-migration-3\.db$/);
  // Newest first; only the scheduled snapshot beyond `keep` is gone, every
  // reason-tagged one stays however old.
  assert.deepEqual(listSnapshots(dir), [
    manual,
    third,
    second,
    migration,
    restore,
  ]);
  assert.ok(!existsSync(first.path));
  assert.ok(existsSync(join(dir, "notes.txt")));
  assert.equal(count(manual.path), 6);
  assert.throws(
    () => snapshot(store.db, { dir, keep: 0, reason: "none" }),
    /whole number ≥ 1/,
  );
  store.close();
});

test("the backup interval must be at least a minute", () => {
  assert.equal(
    loadConfig({ NAKARA_BACKUP_INTERVAL_HOURS: "0.5" }).backup.intervalHours,
    0.5,
  );
  assert.throws(() => loadConfig({ NAKARA_BACKUP_INTERVAL_HOURS: "0.001" }));
  assert.throws(() => loadConfig({ NAKARA_BACKUP_KEEP: "0" }));
});

test("restore drill: a snapshot replaces the database and a Store boots on it", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "nakara.db");
  const backup = { dir: join(dir, "backups"), keep: 14, intervalHours: 24 };
  const store = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  const kept = store.createItem({ ...item, title: "Before the snapshot" });
  const taken = snapshot(store.db, { ...backup, reason: "manual" });
  store.createItem({ ...item, title: "After the snapshot" });
  store.close();

  const { previous } = restoreSnapshot(taken.path, dbPath, backup);
  assert.ok(previous);
  assert.match(previous.path, /-pre-restore\.db$/);
  // The replaced database is kept, with the item the snapshot did not have.
  assert.equal(count(previous.path), 2);
  assert.ok(!existsSync(`${dbPath}-wal`));
  // The pre-restore copy is not a backup of the running database: the age
  // and the schedule still follow the restored snapshot.
  assert.deepEqual(latestSnapshot(backup.dir), taken);
  assert.equal(backupHealth(backup).at, taken.at);

  const restored = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  assert.equal(restored.item(kept.id)?.title, "Before the snapshot");
  assert.equal(restored.item(kept.id + 1), undefined);
  assert.equal(integrityCheck(dbPath), "ok");
  // The restored database accepts writes again.
  assert.equal(restored.createItem(item).id, kept.id + 1);
  restored.close();
});

const LIVE_WRITE =
  "INSERT INTO work_items (title, request, source, budget_usd, factory_id, created_at, updated_at) VALUES ('Live', 'R', 'manual', 1, (SELECT MIN(id) FROM factories), 'now', 'now')";

for (const [holder, open] of [
  [
    "a running Store",
    (path: string) => {
      const { db } = new Store(path, {
        factory: stubFactorySeed,
        defaultBudgetUsd: 15,
      });
      db.exec(LIVE_WRITE);
      return db;
    },
  ],
  // Litestream keeps its own connection with a read transaction open.
  [
    "a reader such as Litestream",
    (path: string) => {
      const db = new DatabaseSync(path);
      db.exec(LIVE_WRITE);
      db.exec("BEGIN; SELECT count(*) FROM work_items;");
      return db;
    },
  ],
] as const)
  test(`restore refuses while ${holder} has the database open`, (t) => {
    const dir = tempDir(t);
    const dbPath = join(dir, "nakara.db");
    const backup = { dir: join(dir, "backups"), keep: 14, intervalHours: 24 };
    const store = new Store(dbPath, {
      factory: stubFactorySeed,
      defaultBudgetUsd: 15,
    });
    const taken = snapshot(store.db, { ...backup, reason: "manual" });
    store.close();
    const live = open(dbPath);
    assert.throws(
      () => restoreSnapshot(taken.path, dbPath, backup),
      /in use by another process: stop Nakara and Litestream first/,
    );
    // Nothing was touched: the live write survives and no temp file is left.
    assert.equal(count(dbPath), 1);
    assert.ok(!existsSync(`${dbPath}.restore`));
    assert.deepEqual(listSnapshots(backup.dir), [taken]);
    live.close();
    assert.equal(count(dbPath), 1);
  });

test("restore moves an unreadable database aside and continues", (t) => {
  const dir = tempDir(t);
  const dbPath = join(dir, "nakara.db");
  const backup = { dir: join(dir, "backups"), keep: 14, intervalHours: 24 };
  const store = new Store(join(dir, "good.db"), {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  store.createItem(item);
  const taken = snapshot(store.db, { ...backup, reason: "manual" });
  store.close();
  writeFileSync(dbPath, "garbage that is not a database");
  writeFileSync(`${dbPath}-wal`, "stale wal");

  const { previous, unreadable } = restoreSnapshot(taken.path, dbPath, backup);
  assert.equal(previous, null);
  assert.ok(unreadable);
  assert.match(unreadable.error, /not a database/);
  assert.match(unreadable.path, /nakara\.db\.pre-restore-.+Z$/);
  assert.equal(
    readFileSync(unreadable.path, "utf8"),
    "garbage that is not a database",
  );
  assert.equal(readFileSync(`${unreadable.path}-wal`, "utf8"), "stale wal");
  assert.ok(!existsSync(`${dbPath}-wal`));
  assert.ok(!readdirSync(dir).some((name) => name.endsWith(".restore")));
  const restored = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  assert.equal(count(dbPath), 1);
  restored.close();
});

test("restore refuses a file that is not a sound database", (t) => {
  const dir = tempDir(t);
  const bad = join(dir, "bad.db");
  writeFileSync(bad, "not a database");
  assert.throws(() =>
    restoreSnapshot(bad, join(dir, "nakara.db"), {
      dir: join(dir, "backups"),
      keep: 14,
      intervalHours: 24,
    }),
  );
  assert.ok(!existsSync(join(dir, "nakara.db")));
});

test("/healthz reports the age of the last backup and flags it when stale", async (t) => {
  const dir = tempDir(t);
  const config = loadConfig({
    NAKARA_DATA_DIR: dir,
    NAKARA_GITHUB_MIRROR: "false",
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, config);
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "test",
  );
  const health = async () =>
    (await (
      await app.request("/healthz", {}, {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      } as HttpBindings)
    ).json()) as {
      backup: ReturnType<typeof backupHealth>;
      schemaVersion: number;
    };

  assert.equal((await health()).schemaVersion, store.schemaVersion);
  assert.deepEqual((await health()).backup, {
    at: null,
    ageSeconds: null,
    stale: true,
  });
  const taken = snapshot(store.db, { ...config.backup, reason: "manual" });
  const fresh = (await health()).backup;
  assert.equal(fresh.at, taken.at);
  assert.ok(fresh.ageSeconds !== null && fresh.ageSeconds < 60);
  assert.equal(fresh.stale, false);

  const later = Date.parse(taken.at) + 49 * 3_600_000;
  assert.deepEqual(backupHealth(config.backup, later), {
    at: taken.at,
    ageSeconds: 49 * 3600,
    stale: true,
  });
  store.close();
});
