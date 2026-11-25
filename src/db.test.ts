import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { Store, stubFactorySeed } from "./db.ts";

test("items created without a budget get the configured default", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const base = { title: "T", request: "R", source: "manual" } as const;
  assert.equal(store.createItem(base).budget_usd, 15);
  assert.equal(store.createItem({ ...base, budgetUsd: 4.5 }).budget_usd, 4.5);
  store.close();
});

test("items that predate per-item budgets are migrated to the configured default", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nakara-db-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "nakara.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE work_items (
    id INTEGER PRIMARY KEY, title TEXT NOT NULL, request TEXT NOT NULL, requester TEXT,
    source TEXT NOT NULL, source_ref TEXT UNIQUE, source_url TEXT, repo TEXT, automation TEXT,
    stage TEXT NOT NULL DEFAULT 'intake', status TEXT NOT NULL DEFAULT 'active',
    spec_state TEXT NOT NULL DEFAULT 'none', review_count INTEGER NOT NULL DEFAULT 0,
    revision_count INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
    issue_url TEXT, pr_url TEXT, pr_merged INTEGER NOT NULL DEFAULT 0, foreman_session TEXT,
    foreman_turns INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO work_items (title, request, source, cost_usd, created_at, updated_at)
    VALUES ('Old', 'Request', 'manual', 3, '2026-01-01', '2026-01-01');`);
  legacy.close();

  const store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 22,
  });
  assert.equal(store.item(1)?.budget_usd, 22);
  assert.equal(
    store.createItem({
      title: "New",
      request: "R",
      source: "manual",
      budgetUsd: 5,
    }).budget_usd,
    5,
  );
  store.close();
  // Reopening with another default leaves stored budgets alone.
  const reopened = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 9,
  });
  assert.deepEqual(
    reopened
      .items()
      .map((i) => [i.title, i.budget_usd])
      .sort(),
    [
      ["New", 5],
      ["Old", 22],
    ],
  );
  reopened.close();
});
