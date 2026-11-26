// `npm run downgrade` against the real script: it refuses while a Nakara
// holds the lock, and otherwise leaves a database the older release accepts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Store, stubFactorySeed } from "../db.ts";
import { MIGRATIONS, schemaVersion } from "../db/migrate.ts";

const DOWNGRADE = join(import.meta.dirname, "downgrade.ts");

function fixture(t: { after: (fn: () => void) => void }) {
  const dataDir = mkdtempSync(join(tmpdir(), "nakara-downgrade-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const dbPath = join(dataDir, "nakara.db");
  new Store(dbPath, { factory: stubFactorySeed, defaultBudgetUsd: 15 }).close();
  const version = () => {
    const db = new DatabaseSync(dbPath);
    try {
      return schemaVersion(db);
    } finally {
      db.close();
    }
  };
  const downgrade = (...args: string[]) =>
    spawnSync(process.execPath, [DOWNGRADE, ...args], {
      env: { ...process.env, NAKARA_DATA_DIR: dataDir },
      encoding: "utf8",
    });
  return { dbPath, version, downgrade };
}

test("downgrade refuses while a Nakara holds the lock", (t) => {
  const { dbPath, version, downgrade } = fixture(t);
  const live = new Store(dbPath, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  t.after(() => live.close());
  const result = downgrade("8");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /downgrade failed: /);
  assert.equal(version(), MIGRATIONS.length);
});

test("downgrade takes a stopped database to the version an older release knows", (t) => {
  const { version, downgrade } = fixture(t);
  const usage = downgrade();
  assert.equal(usage.status, 1);
  assert.match(
    usage.stdout,
    /reversible: 9, 10, 11, 12, 13, 14, 15, 16, 17, 18/,
  );
  const result = downgrade("8");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /schema version 18 -> 8/);
  assert.equal(version(), 8);
});
