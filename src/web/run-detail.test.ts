import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { type Run, Store } from "../db.ts";
import { Factory } from "../orchestrator/factory.ts";
import { type RunContext, readRun } from "./runs.ts";

const context: RunContext = {
  workDir: "/data/work",
  systemPrompt: null,
  verifyLog: false,
  agent: (name) =>
    name === "implement"
      ? { type: "IMPLEMENT", runner: "docker · nakara-agent", docker: true }
      : name === "lint"
        ? // A runner named like docker but without an image runs on the host.
          { type: "CUSTOM", runner: "docker-host", docker: false }
        : undefined,
};

function fixture() {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({
    title: "Retry button",
    request: "Add it",
    source: "manual",
  });
  const run = (patch: Partial<Run> & Pick<Run, "role" | "agent">) => {
    const created = store.createRun({
      item_id: item.id,
      agent_type: patch.role === "foreman" ? "FOREMAN" : "IMPLEMENT",
      harness: "codex",
      model: null,
      input: "Build the retry button",
      session_id: null,
      status: "running",
      ...patch,
    });
    if (patch.status && patch.status !== "running" && patch.status !== "queued")
      store.finishRun(created.id, {
        status: patch.status,
        result: patch.result ?? null,
        error: patch.error ?? null,
        cost_usd: patch.cost_usd ?? 0,
        num_turns: null,
        duration_ms: patch.duration_ms ?? null,
        session_id: patch.session_id ?? null,
        log_path: null,
      });
    return created;
  };
  return { store, item, run };
}

test("readRun projects metadata, attempts and the item's other runs", () => {
  const { store, item, run } = fixture();
  assert.equal(readRun(store, 99, context), undefined);
  const foreman = run({
    role: "foreman",
    agent: "foreman",
    status: "succeeded",
  });
  const first = run({
    role: "agent",
    agent: "implement",
    status: "succeeded",
    session_id: "7f3c0000a91",
    result: "Opened PR",
    cost_usd: 0.5,
    duration_ms: 372_000,
  });
  const followUp = run({
    role: "agent",
    agent: "implement",
    session_id: "7f3c0000a91",
    input: "Also add a test",
  });
  const dto = readRun(store, followUp.id, context);
  assert.ok(dto);
  assert.deepEqual(
    { ...dto, startedAt: undefined },
    {
      id: followUp.id,
      role: "agent",
      agent: "implement",
      harness: "codex",
      model: null,
      status: "running",
      costUsd: 0,
      item: { id: item.id, title: "Retry button" },
      factory: "default",
      agentType: "IMPLEMENT",
      attempt: 2,
      sessionId: "7f3c0000a91",
      startedAt: undefined,
      endedAt: null,
      durationMs: null,
      numTurns: null,
      runner: "docker · nakara-agent",
      docker: true,
      worktree: `/data/work/item-${item.id}`,
      logPath: null,
      input: "Also add a test",
      systemPrompt: null,
      verifyLog: false,
      report: null,
      error: null,
      fallback: null,
      tools: [],
      followUp: {
        allowed: true,
        reason: null,
        countsAsRevision: false,
        revisions: { used: 0, max: 2 },
      },
      otherRuns: [foreman, first].map((r) => ({
        id: r.id,
        role: r.role,
        agent: r.agent,
        harness: "codex",
        model: null,
        status: "succeeded",
        costUsd: r.id === first.id ? 0.5 : 0,
      })),
    },
  );
  const foremanDto = readRun(store, foreman.id, context);
  assert.equal(foremanDto?.runner, "local");
  assert.equal(foremanDto?.docker, false);
  const lint = run({ role: "agent", agent: "lint", status: "succeeded" });
  assert.deepEqual(
    [
      readRun(store, lint.id, context)?.runner,
      readRun(store, lint.id, context)?.docker,
    ],
    ["docker-host", false],
  );
  assert.equal(foremanDto?.followUp.allowed, false);
  assert.match(foremanDto?.followUp.reason ?? "", /Foreman turns cannot/);
  store.db.close();
});

test("follow-up policy on the run page matches the foreman's follow_up rules", () => {
  const { store, item, run } = fixture();
  const fresh = run({ role: "agent", agent: "implement" });
  assert.match(
    readRun(store, fresh.id, context)?.followUp.reason ?? "",
    /no session to continue yet/,
  );
  store.setRunSession(fresh.id, "abc");
  assert.equal(readRun(store, fresh.id, context)?.followUp.allowed, true);

  // After a review, implementation follow-ups are revisions.
  store.updateItem(item.id, { stage: "reviewing", review_count: 1 });
  assert.deepEqual(readRun(store, fresh.id, context)?.followUp, {
    allowed: true,
    reason: null,
    countsAsRevision: true,
    revisions: { used: 0, max: 2 },
  });
  store.updateItem(item.id, { revision_count: 2 });
  const capped = readRun(store, fresh.id, context)?.followUp;
  assert.equal(capped?.allowed, false);
  assert.match(capped?.reason ?? "", /Revision limit reached \(2\)/);

  store.updateItem(item.id, { revision_count: 0 });
  run({ role: "agent", agent: "implement", status: "queued" });
  assert.match(
    readRun(store, fresh.id, context)?.followUp.reason ?? "",
    /already queued/,
  );
  const removed = run({ role: "agent", agent: "retired", session_id: "s" });
  assert.match(
    readRun(store, removed.id, context)?.followUp.reason ?? "",
    /no longer in the factory definition/,
  );
  store.db.close();
});

test("Factory.followUp queues into the agent's session under the policy", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const item = store.createItem({
    title: "Follow up",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, {
    stage: "reviewing",
    review_count: 1,
    revision_count: 1,
  });
  const done = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: "session-1",
    status: "running",
  });
  assert.deepEqual(factory.followUp(999, "Hi"), {
    ok: false,
    code: "not_found",
    reason: "Run not found.",
  });

  // While the run is still going, the follow-up queues behind it.
  const queued = factory.followUp(done.id, "Also add a test");
  assert.ok(queued.ok);
  assert.equal(queued.run.status, "queued");
  assert.equal(queued.run.session_id, "session-1");
  assert.equal(queued.run.input, "Also add a test");
  const after = store.item(item.id);
  assert.equal(after?.revision_count, 2);
  assert.equal(after?.stage, "building");
  assert.ok(
    store
      .messages(item.id)
      .some((m) => m.author === "human" && m.body.includes("Also add a test")),
  );
  await factory.pump();
  assert.equal(store.runById(queued.run.id)?.status, "queued");

  // The cap holds: no second revision, no new run.
  store.finishRun(done.id, {
    status: "succeeded",
    result: "Done",
    error: null,
    cost_usd: 0,
    num_turns: null,
    duration_ms: 1,
    session_id: "session-1",
    log_path: null,
  });
  store.cancelQueuedRuns(item.id);
  const refused = factory.followUp(done.id, "One more");
  assert.equal(refused.ok, false);
  assert.ok(!refused.ok && refused.code === "policy");
  assert.match(!refused.ok ? refused.reason : "", /Revision limit reached/);
  assert.equal(store.runs(item.id).length, 2);
  store.db.close();
});
