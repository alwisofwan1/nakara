import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../db.ts";

function setup() {
  const store = new Store(":memory:", { defaultBudgetUsd: 5 });
  const item = store.createItem({ title: "T", request: "R", source: "manual" });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "reflect",
    agent_type: "REVIEW",
    harness: "codex",
    model: null,
    input: "Reflect",
    session_id: null,
    status: "succeeded",
  });
  return { store, item, run };
}

const proposal = {
  lines: ["Run the linter before the PR."],
  mistake: "lint errors in the PR",
  suggestCheck: true,
};

test("an item holds one pending lesson at a time; a decided one frees the slot", () => {
  const { store, item, run } = setup();
  const id = store.addLearning(item.id, run.id, proposal);
  assert.ok(id);
  assert.equal(store.addLearning(item.id, run.id, proposal), null);
  assert.deepEqual(
    store.pendingLearnings().map((l) => l.id),
    [id],
  );

  assert.ok(store.resolveLearning(id, "rejected", { reason: "too vague" }));
  assert.equal(store.learning(id)?.reason, "too vague");
  assert.ok(store.addLearning(item.id, run.id, proposal));
  store.close();
});

test("approving keeps the Operator's edited lines and decides only once", () => {
  const { store, item, run } = setup();
  const id = store.addLearning(item.id, run.id, proposal) ?? 0;
  assert.ok(
    store.resolveLearning(id, "approved", {
      lines: ["Run npm run check first."],
    }),
  );
  assert.equal(store.resolveLearning(id, "rejected", {}), false);
  const [approved] = store.approvedLearnings();
  assert.equal(approved?.status, "approved");
  assert.deepEqual(JSON.parse(approved?.lines ?? ""), [
    "Run npm run check first.",
  ]);
  assert.equal(approved?.suggest_check, 1);
  assert.ok(approved?.resolved_at);
  assert.deepEqual(store.pendingLearnings(), []);
  store.close();
});
