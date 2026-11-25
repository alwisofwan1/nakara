import assert from "node:assert/strict";
import type { SQLInputValue } from "node:sqlite";
import { test } from "node:test";

import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { inboxCount, readInbox } from "../web/inbox.ts";
import { readItem } from "../web/item-detail.ts";
import { readActivity } from "../web/items.ts";
import { readStatus } from "../web/status.ts";
import { seed } from "./seed.ts";

const store = new Store(":memory:", { defaultBudgetUsd: 15 });
seed(store.db, { items: 5000, runs: 50000 });

/** The statements `read` runs, with the parameters of each. */
function statements(read: () => void) {
  const seen: { sql: string; params: SQLInputValue[] }[] = [];
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = (sql: string) => {
    const statement = prepare(sql);
    const record =
      (run: (...params: SQLInputValue[]) => unknown) =>
      (...params: SQLInputValue[]) => {
        seen.push({ sql, params });
        return run(...params);
      };
    statement.all = record(
      statement.all.bind(statement),
    ) as typeof statement.all;
    statement.get = record(
      statement.get.bind(statement),
    ) as typeof statement.get;
    return statement;
  };
  try {
    read();
  } finally {
    store.db.prepare = prepare;
  }
  return seen;
}

// Every work item is listed on the Inbox and Activity pages, so work_items may be scanned.
const LARGE = ["runs", "messages", "approvals", "events", "evidence"];
// A partial index holds only the rows it is for, so scanning one is cheap.
const PARTIAL = (
  store.db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND sql LIKE '% WHERE %'",
    )
    .all() as { name: string }[]
).map((i) => i.name);

function assertIndexed(read: () => void) {
  const seen = statements(read);
  assert.ok(seen.length > 0);
  for (const { sql, params } of seen) {
    const plan = (
      store.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as {
        detail: string;
      }[]
    ).map((r) => r.detail);
    const scans = plan.filter(
      (d) =>
        LARGE.some((t) => new RegExp(`^SCAN ${t}\\b`).test(d)) &&
        !PARTIAL.some((i) => d.endsWith(`USING INDEX ${i}`)),
    );
    assert.deepEqual(scans, [], `${sql}\n${plan.join("\n")}`);
  }
}

const openItem = 10;

test("the scheduler's queries use indexes", () => {
  assertIndexed(() => {
    for (const id of store.itemsWithPendingEvents()) store.pendingEvents(id);
    store.runningRuns();
    store.queuedRuns();
  });
});

test("the scheduler's queries do not read run input or result", () => {
  for (const run of [...store.runningRuns(), ...store.queuedRuns()]) {
    assert.equal("input" in run, false);
    assert.equal("result" in run, false);
  }
  assert.equal(store.queuedRuns().length, 4);
});

test("the Inbox and the status footer use indexes", () => {
  const config = loadConfig({});
  assertIndexed(() => {
    readInbox(store);
    inboxCount(store);
    readStatus(store, {
      telegramConfigured: false,
      concurrency: config.concurrency,
      factories: [
        { slug: "default", loaded: true, errors: 0, repositories: 0 },
      ],
      backup: config.backup,
    });
  });
});

test("the Activity page's outcome metrics use indexes", () => {
  assertIndexed(() => readActivity(store));
});

test("posting proof uses indexes", () => {
  assertIndexed(() => {
    store.itemsWithUnpostedEvidence();
    store.latestEvidence(openItem);
    store.evidenceAfter(0);
  });
});

test("the Work Item page uses indexes", () => {
  assertIndexed(() => {
    readItem(store, openItem);
    store.events(openItem);
  });
});
