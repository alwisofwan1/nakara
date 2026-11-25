import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { quietTelemetry } from "../telemetry/metrics.ts";
import { RunControl } from "./run-support.ts";
import { Scheduler, type SchedulerHooks } from "./scheduler.ts";

/** A scheduler over an in-memory store; `hooks` start the work, `logged` collects what it logs. */
function fixture(t: TestContext, hooks: Partial<SchedulerHooks>) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const logged: [string, Record<string, unknown>][] = [];
  const log = quietTelemetry().log;
  t.mock.method(
    log,
    "error",
    (event: string, fields: Record<string, unknown> = {}) => {
      logged.push([event, fields]);
    },
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  t.after(() => process.off("unhandledRejection", onUnhandled));
  const scheduler = new Scheduler(
    store,
    loadConfig({ NAKARA_DATA_DIR: "/tmp/nakara-scheduler-test" }),
    new RunControl(),
    {
      ready: () => true,
      pump: async () => {},
      foremanTurn: async () => {},
      agentRun: async () => {},
      ...hooks,
    },
    log,
  );
  const item = (title: string) => {
    const created = store.createItem({
      title,
      request: title,
      source: "manual",
    });
    store.addEvent(created.id, "human_message", { message: title });
    return created;
  };
  // Lets rejections that nobody handles surface before the test asserts.
  const settle = async () => {
    for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
  };
  return { store, scheduler, item, logged, unhandled, settle };
}

test("a foreman turn that throws synchronously ends nothing: the item pauses and the other items still start", async (t) => {
  const started: number[] = [];
  let bad = 0;
  const { store, scheduler, item, logged, unhandled, settle } = fixture(t, {
    foremanTurn: (itemId) => {
      if (itemId === bad) throw new Error("Work item has no factory.");
      started.push(itemId);
      return Promise.resolve();
    },
  });
  bad = item("broken").id;
  const good = item("fine").id;
  await scheduler.pump();
  await settle();
  assert.deepEqual(started, [good]);
  assert.equal(unhandled.length, 0);
  assert.equal(store.item(bad)?.status, "paused");
  // Its events are handled, so the next pump does not retry the turn in a loop.
  assert.ok(!store.itemsWithPendingEvents().includes(bad));
  const [event, fields] =
    logged.find(([e]) => e === "scheduler.track_failed") ?? [];
  assert.equal(event, "scheduler.track_failed");
  assert.equal(fields?.item_id, bad);
});

test("an agent run whose promise rejects is failed, frees its slot and is not an unhandled rejection", async (t) => {
  const { store, scheduler, item, logged, unhandled, settle } = fixture(t, {
    agentRun: () => Promise.reject(new Error("failCrashed threw")),
  });
  const created = item("agent");
  const queued = store.createRun({
    item_id: created.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    input: "Build it",
    session_id: null,
    status: "queued",
  });
  await scheduler.pump();
  await settle();
  assert.equal(unhandled.length, 0);
  assert.equal(store.runById(queued.id)?.status, "failed");
  assert.deepEqual(store.queuedRuns(), []);
  assert.deepEqual(store.runningRuns(), []);
  // The foreman hears about the failed run, as it does when the factory fails one.
  assert.ok(
    store
      .pendingEvents(created.id)
      .some((e) => e.kind === "agent_report" && e.payload.includes("failed")),
  );
  const [, fields] = logged.find(([e]) => e === "scheduler.track_failed") ?? [];
  assert.equal(fields?.item_id, created.id);
  assert.equal(fields?.run_id, queued.id);
});

test("when recording the failure throws too, nothing is unhandled and the scheduler keeps going", async (t) => {
  const started: number[] = [];
  const { store, scheduler, item, logged, unhandled, settle } = fixture(t, {
    foremanTurn: (itemId) => {
      if (itemId === first) throw new Error("boom");
      started.push(itemId);
      return Promise.resolve();
    },
  });
  const first = item("first").id;
  const second = item("second").id;
  // SQLite busy: the error path cannot write.
  store.markEventsProcessed = () => {
    throw new Error("database is locked");
  };
  await scheduler.pump();
  await settle();
  assert.equal(unhandled.length, 0);
  assert.deepEqual(started, [second]);
  assert.ok(logged.some(([e]) => e === "scheduler.recover_failed"));
  // No immediate re-pump: the item's events are still pending, and the interval retries.
  assert.equal(store.itemsWithPendingEvents().includes(first), true);
});

test("a crashed foreman turn keeps the events that arrived while it ran, and fails its foreman run", async (t) => {
  let id = 0;
  const { store, scheduler, item, settle } = fixture(t, {
    foremanTurn: () => {
      // A message arrives mid-turn, then the hook throws.
      store.addEvent(id, "human_message", { message: "while you ran" });
      throw new Error("boom");
    },
  });
  id = item("busy").id;
  const run = store.createRun({
    item_id: id,
    role: "foreman",
    agent: "foreman",
    agent_type: "FOREMAN",
    harness: "claude",
    model: null,
    input: "",
    session_id: null,
    status: "running",
  });
  await scheduler.pump();
  await settle();
  assert.equal(store.runById(run.id)?.status, "failed");
  assert.equal(store.pendingEvents(id).length, 1);
});

test("when failing the run throws, nothing is unhandled and the run is left for the interval", async (t) => {
  const { store, scheduler, item, logged, unhandled, settle } = fixture(t, {
    agentRun: () => Promise.reject(new Error("boom")),
  });
  const created = item("agent");
  store.createRun({
    item_id: created.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    input: "Build it",
    session_id: null,
    status: "queued",
  });
  store.finishRun = () => {
    throw new Error("database is locked");
  };
  await scheduler.pump();
  await settle();
  assert.equal(unhandled.length, 0);
  assert.ok(logged.some(([e]) => e === "scheduler.recover_failed"));
});
