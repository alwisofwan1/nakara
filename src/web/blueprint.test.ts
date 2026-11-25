import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { Store, stubFactorySeed } from "../db.ts";
import type { AgentType } from "../domain/policy.ts";
import { DESIGNED_TRANSITIONS, readBlueprint } from "./blueprint.ts";

function setup(t: TestContext) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const harbor = store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "harbor",
    name: "Harbor",
  });
  const item = (factoryId = harbor.id) =>
    store.createItem({ title: "W", request: "r", source: "manual", factoryId })
      .id;
  const run = (itemId: number, agentType: AgentType) =>
    store.createRun({
      item_id: itemId,
      role: "agent",
      agent: agentType.toLowerCase(),
      agent_type: agentType,
      harness: "claude",
      model: null,
      session_id: null,
      input: "go",
      status: "queued",
    });
  return { store, harbor, item, run };
}

test("every stage a work item enters is recorded, whichever write moved it", (t) => {
  const { store, item } = setup(t);
  const id = item();
  store.updateItem(id, { stage: "triage" });
  store.updateItem(id, { status: "waiting_human" }); // no stage change
  store.updateItem(id, { stage: "triage" }); // same stage
  store.updateItem(id, { stage: "cancelled", status: "done" });
  const rows = store.db
    .prepare(
      "SELECT from_stage, to_stage FROM stage_transitions WHERE item_id = ? ORDER BY id",
    )
    .all(id)
    .map((r) => [r.from_stage, r.to_stage]);
  assert.deepEqual(rows, [
    [null, "intake"],
    ["intake", "triage"],
    ["triage", "cancelled"],
  ]);
});

test("the blueprint counts one factory's moves, runs and open items", (t) => {
  const { store, harbor, item, run } = setup(t);
  const a = item();
  const b = item();
  item(store.repos.factories.defaultFactory().id); // another factory's
  for (const stage of ["triage", "building", "reviewing", "building"] as const)
    store.updateItem(a, { stage });
  store.updateItem(b, { stage: "building" });
  store.updateItem(b, { stage: "cancelled" });
  run(a, "TRIAGE");
  run(a, "IMPLEMENT");
  run(a, "IMPLEMENT");
  run(a, "REVIEW");
  run(b, "IMPLEMENT");

  const blueprint = readBlueprint(store, harbor.id);
  const stage = (s: string) => blueprint.stages.find((x) => x.stage === s);
  assert.deepEqual(stage("building"), {
    stage: "building",
    runs: 3,
    open: 1,
    entered: 3,
  });
  assert.deepEqual(stage("intake"), {
    stage: "intake",
    runs: 0,
    open: 0,
    entered: 2,
  });
  assert.equal(stage("cancelled")?.entered, 1);

  const edge = (from: string, to: string) =>
    blueprint.transitions.find((x) => x.from === from && x.to === to);
  // Every designed move is listed, recorded or not.
  assert.equal(
    blueprint.transitions.filter((x) => x.designed).length,
    DESIGNED_TRANSITIONS.length,
  );
  assert.equal(edge("reviewing", "building")?.count, 1);
  assert.equal(edge("planning", "building")?.count, 0);
  // Recorded moves off the designed path follow, most frequent first.
  assert.deepEqual(
    blueprint.transitions.filter((x) => !x.designed),
    [{ from: "building", to: "cancelled", count: 1, designed: false }],
  );
});
