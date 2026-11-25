import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpBindings } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { type Run, Store, stubFactorySeed } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { RUNS_LIMIT, type RunsDto, readRuns } from "./runs.ts";
import { createApp } from "./test-support.ts";

function seed(store: Store) {
  const first = store.createItem({
    title: "First item",
    request: "Test",
    source: "manual",
  });
  const second = store.createItem({
    title: "Second item",
    request: "Test",
    source: "manual",
  });
  const run = (
    itemId: number,
    agent: string,
    agentType: Run["agent_type"],
    status: Run["status"],
  ) =>
    store.createRun({
      item_id: itemId,
      role: agentType === "FOREMAN" ? "foreman" : "agent",
      agent,
      agent_type: agentType,
      harness: "claude",
      model: agentType === "REVIEW" ? "opus" : null,
      input: "",
      session_id: null,
      status,
    }).id;
  const foreman = run(first.id, "foreman", "FOREMAN", "running");
  const implement = run(first.id, "implement", "IMPLEMENT", "running");
  store.finishRun(implement, {
    status: "failed",
    result: null,
    error: "Boom",
    cost_usd: 0.42,
    num_turns: 3,
    duration_ms: 65_000,
    session_id: null,
    log_path: null,
  });
  const review = run(second.id, "review", "REVIEW", "queued");
  const live = run(second.id, "implement", "IMPLEMENT", "running");
  return { first, second, foreman, implement, review, live };
}

test("runs projection lists runs across items newest first with item titles", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  assert.deepEqual(readRuns(store), {
    runs: [],
    agents: [],
    truncated: false,
  });
  const ids = seed(store);
  const dto = readRuns(store);
  assert.deepEqual(
    dto.runs.map((run) => run.id),
    [ids.live, ids.review, ids.implement, ids.foreman],
  );
  assert.deepEqual(dto.agents, ["foreman", "implement", "review"]);
  const failed = dto.runs.find((run) => run.id === ids.implement);
  assert.deepEqual(
    { ...failed, startedAt: undefined, endedAt: undefined },
    {
      id: ids.implement,
      itemId: ids.first.id,
      itemTitle: "First item",
      factory: "default",
      role: "agent",
      agent: "implement",
      agentType: "IMPLEMENT",
      harness: "claude",
      model: null,
      status: "failed",
      costUsd: 0.42,
      startedAt: undefined,
      endedAt: undefined,
      durationMs: 65_000,
    },
  );
  assert.ok(failed?.endedAt);
  const live = dto.runs.find((run) => run.id === ids.live);
  assert.equal(live?.durationMs, null);
  assert.equal(live?.endedAt, null);
  assert.ok(!JSON.stringify(dto).includes("Boom"));
  assert.deepEqual(readRuns(store), dto);
  store.db.close();
});

test("runs projection derives durations only from a run's own start and end", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const ids = seed(store);
  // A run that ended without a reported duration, e.g. failed on restart.
  store.finishRun(ids.live, {
    status: "failed",
    result: null,
    error: "Nakara restarted while this run was in progress.",
    cost_usd: 0,
    num_turns: null,
    duration_ms: null,
    session_id: null,
    log_path: null,
  });
  store.db
    .prepare("UPDATE runs SET started_at = ?, ended_at = ? WHERE id = ?")
    .run("2026-10-22T12:00:00.000Z", "2026-10-22T12:01:30.000Z", ids.live);
  // Queued time is not run time: a run cancelled before it started has no duration.
  store.cancelQueuedRuns(ids.second.id);
  const runs = readRuns(store).runs;
  assert.equal(runs.find((run) => run.id === ids.live)?.durationMs, 90_000);
  const cancelled = runs.find((run) => run.id === ids.review);
  assert.equal(cancelled?.status, "cancelled");
  assert.ok(cancelled?.endedAt);
  assert.equal(cancelled?.durationMs, null);
  store.db.close();
});

test("runs projection flags results beyond the latest RUNS_LIMIT", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({
    title: "Busy item",
    request: "Test",
    source: "manual",
  });
  const create = () =>
    store.createRun({
      item_id: item.id,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "",
      session_id: null,
      status: "succeeded",
    }).id;
  for (let i = 0; i < RUNS_LIMIT; i++) create();
  assert.equal(readRuns(store).runs.length, RUNS_LIMIT);
  assert.equal(readRuns(store).truncated, false);
  const newest = create();
  const dto = readRuns(store);
  assert.equal(dto.runs.length, RUNS_LIMIT);
  assert.equal(dto.runs[0]?.id, newest);
  assert.equal(dto.truncated, true);
  assert.equal(readRuns(store, { status: "running" }).truncated, false);
  store.db.close();
});

test("runs projection combines status and agent filters", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const ids = seed(store);
  const pick = (query: Parameters<typeof readRuns>[1]) =>
    readRuns(store, query).runs.map((run) => run.id);
  assert.deepEqual(pick({ status: "running" }), [ids.live, ids.foreman]);
  assert.deepEqual(pick({ agent: "implement" }), [ids.live, ids.implement]);
  assert.deepEqual(pick({ status: "running", agent: "implement" }), [ids.live]);
  assert.deepEqual(pick({ status: "succeeded", agent: "implement" }), []);
  // Agent options stay complete while a filter is applied.
  assert.deepEqual(readRuns(store, { agent: "review" }).agents, [
    "foreman",
    "implement",
    "review",
  ]);
  store.db.close();
});

test("GET /api/runs validates filters and returns the projection", async () => {
  const config = loadConfig({ NAKARA_TELEGRAM_BOT_TOKEN: "" });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, config);
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "token",
  );
  const ids = seed(store);
  const bindings = {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  } as HttpBindings;
  const get = (path: string) =>
    app.request(`http://localhost${path}`, {}, bindings);
  const response = await get("/api/runs?status=running&agent=implement");
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    readRuns(store, { status: "running", agent: "implement" }),
  );
  assert.equal(
    ((await (await get("/api/runs")).json()) as { runs: unknown[] }).runs
      .length,
    4,
  );
  for (const query of ["status=done", "agent="]) {
    const invalid = await get(`/api/runs?${query}`);
    assert.equal(invalid.status, 400);
    assert.equal(
      ((await invalid.json()) as { error: { code: string } }).error.code,
      "invalid_input",
    );
  }
  const page = await get("/runs");
  assert.notEqual(page.status, 404);
  assert.equal((await get(`/runs/${ids.live}`)).status, 200);
  store.db.close();
});

test("run writes emit a runs change; other writes do not", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const events: unknown[] = [];
  store.changes.on("change", (event) => events.push(event));
  store.setKv("github:lastPoll", "{}");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, [{ type: "status", id: "global" }]);
  events.length = 0;
  seed(store);
  await new Promise((resolve) => setImmediate(resolve));
  // Per-item and per-run notifications are covered by the run page tests.
  assert.deepEqual(
    events.filter((e) => (e as { id: string }).id === "global"),
    [
      { type: "status", id: "global" },
      { type: "items", id: "global" },
      { type: "runs", id: "global" },
    ],
  );
  store.db.close();
});

test("runs span factories and filter by one", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const harbor = store.repos.factories.createFactory({
      ...stubFactorySeed(),
      slug: "harbor",
      name: "Harbor",
    });
    const runIn = (factoryId?: number) =>
      store.createRun({
        item_id: store.createItem({
          title: "Work",
          request: "r",
          source: "manual",
          factoryId,
        }).id,
        role: "agent",
        agent: "implement",
        agent_type: "IMPLEMENT",
        harness: "claude",
        model: null,
        session_id: null,
        input: "Build it",
        status: "queued",
      });
    const mine = runIn();
    const theirs = runIn(harbor.id);
    const rows = (dto: { runs: { id: number; factory: string }[] }) =>
      dto.runs.map((r) => [r.id, r.factory]);

    assert.deepEqual(rows(readRuns(store)), [
      [theirs.id, "harbor"],
      [mine.id, "default"],
    ]);
    assert.deepEqual(rows(readRuns(store, { factoryId: harbor.id })), [
      [theirs.id, "harbor"],
    ]);
    const config = loadConfig({});
    const registry = new FactoryRegistry(store, config);
    const app = createApp(
      registry,
      new GithubPoller(registry.default),
      config,
      "token",
    );
    const get = (path: string) =>
      app.request(path, {}, {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      } as HttpBindings);
    const filtered = await get("/api/runs?factory=default&status=queued");
    assert.deepEqual(rows((await filtered.json()) as RunsDto), [
      [mine.id, "default"],
    ]);
    assert.equal((await get("/api/runs?factory=missing")).status, 404);
  } finally {
    store.close();
  }
});
