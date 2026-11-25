import assert from "node:assert/strict";
import { uncheckedKey } from "../db/learnings.ts";
import { test } from "node:test";
import { type Run, Store, type WorkItem } from "../db.ts";
import type { AgentType } from "../domain/policy.ts";
import { CLOSED_LIMIT, itemView, readActivity, stateLabel } from "./items.ts";

const SPEC_PR = "https://github.com/acme/app/pull/12";
const PR = "https://github.com/acme/app/pull/14";

function agentRun(
  store: Store,
  item: WorkItem,
  agent: string,
  type: AgentType,
  status: Run["status"],
) {
  const run = store.createRun({
    item_id: item.id,
    role: type === "FOREMAN" ? "foreman" : "agent",
    agent,
    agent_type: type,
    harness: "claude",
    model: null,
    session_id: null,
    input: "",
    status: status === "queued" ? "queued" : "running",
  });
  if (status !== "queued" && status !== "running")
    store.finishRun(run.id, {
      status,
      result: null,
      error: status === "failed" ? "exit 1" : null,
      cost_usd: 0,
      num_turns: null,
      duration_ms: null,
      session_id: null,
      log_path: null,
    });
}

type Case = {
  name: string;
  setup: (store: Store, item: WorkItem) => void;
  expected: {
    group: string;
    /** The one-line state notifications use. */
    state: string;
    agent: [name: string, icon: string, tone: string, running: boolean];
    needsYou: [kind: string, label: string | null];
    actionCard: string;
    chips: string[];
    exhausted?: boolean;
  };
};

const cases: Case[] = [
  {
    name: "intake",
    setup: () => {},
    expected: {
      group: "triage",
      state: "Triage",
      agent: ["foreman", "sparkles", "accent", false],
      needsYou: ["none", null],
      actionCard: "none",
      chips: ["app#5"],
    },
  },
  {
    name: "triage running",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "triage" });
      agentRun(store, item, "triage", "TRIAGE", "running");
    },
    expected: {
      group: "triage",
      state: "Triage",
      agent: ["triage", "scan-search", "muted", true],
      needsYou: ["none", null],
      actionCard: "live",
      chips: ["app#5"],
    },
  },
  {
    name: "spec awaiting approval",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "planning",
        status: "waiting_human",
        spec_state: "awaiting_approval",
      });
      agentRun(store, item, "spec", "SPEC", "succeeded");
      store.addApproval(item.id, "spec", "Approve?", SPEC_PR);
    },
    expected: {
      group: "planning",
      state: "Needs you · spec",
      agent: ["spec", "file-text", "attention", false],
      needsYou: ["spec", "Spec needs approval"],
      actionCard: "spec",
      chips: ["Spec #12", "app#5"],
    },
  },
  {
    name: "question pending",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "planning", status: "waiting_human" });
      agentRun(store, item, "foreman", "FOREMAN", "succeeded");
      store.addApproval(item.id, "question", "Which option?", null);
    },
    expected: {
      group: "planning",
      state: "Needs you · question",
      agent: ["foreman", "sparkles", "accent", false],
      needsYou: ["question", "Asked you a question"],
      actionCard: "question",
      chips: ["app#5"],
    },
  },
  {
    name: "building",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "building", cost_usd: 3 });
      agentRun(store, item, "implement", "IMPLEMENT", "running");
      // The foreman's own turn does not hide the building agent.
      agentRun(store, item, "foreman", "FOREMAN", "running");
    },
    expected: {
      group: "building",
      state: "Building",
      agent: ["implement", "code-xml", "building", true],
      needsYou: ["none", null],
      actionCard: "live",
      chips: ["app#5"],
    },
  },
  {
    name: "review findings",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "reviewing",
        review_count: 1,
        pr_url: PR,
      });
      agentRun(store, item, "implement", "IMPLEMENT", "succeeded");
      agentRun(store, item, "review", "REVIEW", "succeeded");
    },
    expected: {
      group: "reviewing",
      state: "Reviewing · PR #14",
      agent: ["review", "git-pull-request", "reviewing", false],
      needsYou: ["none", null],
      actionCard: "none",
      chips: ["PR #14", "app#5"],
    },
  },
  {
    name: "PR handoff",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "handoff",
        status: "waiting_human",
        pr_url: PR,
      });
      agentRun(store, item, "review", "REVIEW", "succeeded");
    },
    expected: {
      group: "handoff",
      state: "Handoff · PR #14",
      agent: ["review", "git-pull-request", "reviewing", false],
      needsYou: ["pr", "Ready to merge"],
      actionCard: "pr",
      chips: ["app#5"],
    },
  },
  {
    name: "PR handoff over budget",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "handoff",
        status: "waiting_human",
        pr_url: PR,
        cost_usd: 16,
      });
      agentRun(store, item, "review", "REVIEW", "succeeded");
    },
    expected: {
      group: "handoff",
      state: "Handoff · PR #14",
      agent: ["review", "git-pull-request", "reviewing", false],
      needsYou: ["pr", "Ready to merge"],
      actionCard: "pr",
      chips: ["app#5"],
      exhausted: true,
    },
  },
  {
    name: "budget exhausted",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "building", cost_usd: 15 });
      agentRun(store, item, "implement", "IMPLEMENT", "succeeded");
    },
    expected: {
      group: "building",
      state: "Needs you · failed",
      agent: ["implement", "code-xml", "building", false],
      needsYou: ["failed", "Budget exhausted"],
      actionCard: "failed",
      chips: ["app#5"],
      exhausted: true,
    },
  },
  {
    name: "run failed",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "building" });
      agentRun(store, item, "implement", "IMPLEMENT", "failed");
    },
    expected: {
      group: "building",
      state: "Needs you · failed",
      agent: ["implement", "code-xml", "building", false],
      needsYou: ["failed", "Run failed"],
      actionCard: "failed",
      chips: ["app#5"],
    },
  },
  {
    name: "complete",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "complete",
        status: "done",
        pr_url: PR,
        pr_merged: 1,
        cost_usd: 16,
      });
      agentRun(store, item, "review", "REVIEW", "succeeded");
      // A stale pending approval no longer needs the human.
      store.addApproval(item.id, "question", "Old?", null);
    },
    expected: {
      group: "complete",
      state: "Complete · PR #14",
      agent: ["review", "git-pull-request", "reviewing", false],
      needsYou: ["none", null],
      actionCard: "complete",
      chips: ["PR #14", "app#5"],
      exhausted: true,
    },
  },
  {
    name: "cancelled",
    setup: (store, item) => {
      agentRun(store, item, "implement", "IMPLEMENT", "failed");
      store.updateItem(item.id, { stage: "cancelled", status: "done" });
    },
    expected: {
      group: "complete",
      state: "Cancelled",
      agent: ["implement", "code-xml", "building", false],
      needsYou: ["none", null],
      actionCard: "cancelled",
      chips: ["app#5"],
    },
  },
];

for (const { name, setup, expected } of cases) {
  test(`item view model: ${name}`, () => {
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    const created = store.createItem({
      title: name,
      request: "Test",
      source: "github",
      sourceUrl: "https://github.com/acme/app/issues/5",
    });
    setup(store, created);
    // biome-ignore lint/style/noNonNullAssertion: The fixture item was just created.
    const item = store.item(created.id)!;
    const view = itemView(item, store.runs(item.id), store.approvals(item.id));
    assert.equal(view.group, expected.group);
    assert.equal(stateLabel(item, view), expected.state);
    assert.deepEqual(
      [view.agent.name, view.agent.icon, view.agent.tone, view.agent.running],
      expected.agent,
    );
    assert.deepEqual(
      [view.needsYou.kind, view.needsYou.label],
      expected.needsYou,
    );
    assert.equal(view.actionCard, expected.actionCard);
    assert.deepEqual(
      view.chips.map((chip) => chip.label),
      expected.chips,
    );
    assert.equal(view.budget.exhausted, expected.exhausted ?? false);
    assert.equal(view.budget.usedUsd, item.cost_usd);
    assert.equal(view.budget.ratio, Math.min(1, item.cost_usd / 15));
    assert.deepEqual(readActivity(store).items, [view]);
    store.db.close();
  });
}

test("source chips name the origin of each item", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  for (const input of [
    { source: "manual" },
    { source: "telegram" },
    { source: "schedule", automation: "weekly-health-check" },
  ] as const)
    store.createItem({ title: "Source", request: "Test", ...input });
  assert.deepEqual(
    readActivity(store)
      .items.map(({ source, chips }) => [source, chips])
      .sort(),
    [
      [
        "manual",
        [{ kind: "source", label: "Manual", icon: "user", url: null }],
      ],
      [
        "schedule",
        [
          {
            kind: "source",
            label: "weekly-health-check",
            icon: "clock",
            url: null,
          },
        ],
      ],
      [
        "telegram",
        [{ kind: "source", label: "Telegram", icon: "send", url: null }],
      ],
    ],
  );
  store.db.close();
});

test("Activity measures outcomes: merge rate, revisions, cost per merged PR, cycle time", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const finish = (
    title: string,
    fields: Partial<WorkItem>,
    mergedAfterHours?: number,
  ) => {
    const item = store.createItem({ title, request: "r", source: "manual" });
    store.db
      .prepare("UPDATE work_items SET created_at = ? WHERE id = ?")
      .run("2026-11-01T00:00:00.000Z", item.id);
    store.updateItem(item.id, {
      stage: "complete",
      status: "done",
      ...fields,
    });
    if (mergedAfterHours !== undefined) {
      // A spec PR merged earlier does not end the cycle; the last merge does.
      for (const hours of [mergedAfterHours / 2, mergedAfterHours]) {
        const id = store.addEvent(item.id, "pr_merged", {});
        store.db
          .prepare("UPDATE events SET created_at = ? WHERE id = ?")
          .run(
            new Date(
              Date.parse("2026-11-01T00:00:00.000Z") + hours * 3_600_000,
            ).toISOString(),
            id,
          );
      }
    }
  };
  // No PR merged yet: nothing to measure.
  assert.deepEqual(readActivity(store).outcomes, {
    prs: 0,
    merged: 0,
    closedUnmerged: 0,
    revisionsPerItem: null,
    costPerMergedPrUsd: null,
    medianCycleHours: null,
  });
  finish("a", { pr_url: PR, pr_merged: 1, revision_count: 0, cost_usd: 3 }, 1);
  finish("b", { pr_url: PR, pr_merged: 1, revision_count: 2, cost_usd: 5 }, 4);
  finish("c", { pr_url: PR, pr_merged: 1, revision_count: 1, cost_usd: 4 }, 2);
  finish("closed", {
    stage: "cancelled",
    pr_url: SPEC_PR,
    pr_merged: 0,
    revision_count: 1,
    cost_usd: 6,
  });
  // Work that ended without a PR still cost money toward the merged ones.
  finish("no pr", { stage: "cancelled", cost_usd: 2 });
  // Open work is not an outcome yet.
  const open = store.createItem({ title: "o", request: "r", source: "manual" });
  store.updateItem(open.id, { pr_url: PR, revision_count: 5, cost_usd: 50 });

  assert.deepEqual(readActivity(store).outcomes, {
    prs: 4,
    merged: 3,
    closedUnmerged: 1,
    revisionsPerItem: 1,
    costPerMergedPrUsd: (3 + 5 + 4 + 6 + 2) / 3,
    medianCycleHours: 2,
  });
  store.db.close();
});

test("Activity keeps every open item and counts from all items", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const waiting = store.createItem({
    title: "Old question",
    request: "Test",
    source: "manual",
  });
  store.addApproval(waiting.id, "question", "Which?", null);
  store.updateItem(waiting.id, { cost_usd: 2 });
  // Push the open item behind more than CLOSED_LIMIT newer closed items.
  store.db
    .prepare("UPDATE work_items SET updated_at = ? WHERE id = ?")
    .run("2000-01-01T00:00:00.000Z", waiting.id);
  for (let i = 0; i <= CLOSED_LIMIT; i++) {
    const done = store.createItem({
      title: `Done ${i}`,
      request: "Test",
      source: "manual",
    });
    store.updateItem(done.id, {
      stage: "complete",
      status: "done",
      cost_usd: 1,
    });
  }
  const activity = readActivity(store);
  assert.equal(activity.items.length, CLOSED_LIMIT + 1);
  assert.equal(activity.items[0]?.id, waiting.id);
  assert.equal(activity.items[0]?.needsYou.kind, "question");
  assert.deepEqual(activity.summary, {
    open: 1,
    needsYou: 1,
    costUsd: 2 + CLOSED_LIMIT + 1,
  });
  store.db.close();
});

test("Activity lists approved lessons with their recurrences, of the factory asked for", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({ title: "T", request: "R", source: "manual" });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "reflect",
    agent_type: "REFLECT",
    harness: "claude",
    model: null,
    input: "",
    session_id: null,
    status: "succeeded",
  });
  const proposal = {
    lines: ["Run lint."],
    mistake: "lint",
    suggestCheck: false,
  };
  const pending = store.addLearning(item.id, run.id, proposal) ?? 0;
  assert.deepEqual(readActivity(store).lessons, []);
  store.resolveLearning(pending, "approved", {});
  store.addRecurrences([pending], item.factory_id);
  assert.deepEqual(readActivity(store, item.factory_id).lessons, [
    {
      id: pending,
      lines: ["Run lint."],
      mistake: "lint",
      recurrences: 1,
      approvedAt: store.learning(pending)?.resolved_at ?? null,
    },
  ]);
  assert.deepEqual(readActivity(store, item.factory_id + 1).lessons, []);
  assert.equal(readActivity(store).uncheckedCorrections, 0);
  store.setKv(uncheckedKey(item.factory_id), "2");
  assert.equal(readActivity(store, item.factory_id).uncheckedCorrections, 2);
  assert.equal(
    readActivity(store, item.factory_id + 1).uncheckedCorrections,
    0,
  );
  store.db.close();
});
