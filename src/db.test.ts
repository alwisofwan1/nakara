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

test("an interrupted review keeps its count; the run that resumes it gives it back if it fails", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({
    title: "T",
    request: "R",
    source: "manual",
  });
  store.updateItem(item.id, { review_count: 1 });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "review",
    agent_type: "REVIEW",
    harness: "claude",
    model: null,
    session_id: null,
    status: "queued",
    input: "Review",
    counts_review: 1,
  });
  store.markRunStarted(run.id, "log");
  const { status, resume } = store.transaction(() =>
    store.interruptRun(
      run.id,
      {
        result: null,
        cost_usd: 0,
        num_turns: null,
        duration_ms: null,
        session_id: "s-1",
      },
      "Restarted.",
    ),
  );
  assert.equal(status, "interrupted");
  assert.equal(resume?.counts_review, 1);
  assert.equal(store.item(item.id)?.review_count, 1);
  assert.ok(resume);
  store.markRunStarted(resume.id, "log");
  store.finishRun(resume.id, {
    status: "failed",
    result: null,
    error: "boom",
    cost_usd: 0,
    num_turns: null,
    duration_ms: 0,
    session_id: "s-1",
    log_path: "log",
  });
  assert.equal(store.item(item.id)?.review_count, 0);
  store.db.close();
});
