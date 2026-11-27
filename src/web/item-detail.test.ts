import assert from "node:assert/strict";
import { test } from "node:test";
import { type Run, Store, type WorkItem } from "../db.ts";
import type { AgentType } from "../domain/policy.ts";
import { type ActionCardDto, readItem } from "./item-detail.ts";
import { pullRequestDto } from "./pull-request.ts";

const SPEC_PR = "https://github.com/acme/app/pull/12";
const PR = "https://github.com/acme/app/pull/14";

function addRun(
  store: Store,
  item: WorkItem,
  agent: string,
  type: AgentType,
  status: Run["status"],
  finish: Partial<
    Pick<Run, "result" | "error" | "cost_usd" | "review_verdict">
  > = {},
): Run {
  const run = store.createRun({
    item_id: item.id,
    role: type === "FOREMAN" ? "foreman" : "agent",
    agent,
    agent_type: type,
    harness: "claude",
    model: type === "FOREMAN" ? "sonnet" : null,
    session_id: null,
    input: "",
    status: status === "queued" ? "queued" : "running",
  });
  if (status !== "queued" && status !== "running")
    store.finishRun(run.id, {
      status,
      result: finish.result ?? null,
      error: finish.error ?? null,
      cost_usd: finish.cost_usd ?? 0,
      num_turns: null,
      duration_ms: 72_000,
      session_id: null,
      log_path: null,
      review_verdict: finish.review_verdict ?? null,
    });
  // biome-ignore lint/style/noNonNullAssertion: The run was just created.
  return store.runById(run.id)!;
}

function fixture(setup: (store: Store, item: WorkItem) => void = () => {}) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({
    title: "Support month names",
    request: "Support JAN–DEC",
    source: "github",
    sourceUrl: "https://github.com/acme/app/issues/5",
    issueUrl: "https://github.com/acme/app/issues/5",
    repo: "acme/app",
    automation: "issue-labeled",
    requester: "alwi",
  });
  setup(store, item);
  // biome-ignore lint/style/noNonNullAssertion: The item was just created.
  const dto = readItem(store, item.id)!;
  store.db.close();
  return dto;
}

type Case = {
  name: string;
  setup: (store: Store, item: WorkItem) => void;
  card: Partial<ActionCardDto> & { kind: ActionCardDto["kind"] };
  conversation?: string[];
  current: string;
  status: string;
};

const cases: Case[] = [
  {
    name: "intake waits for the foreman",
    setup: () => {},
    card: { kind: "none" },
    current: "intake",
    status: "Active",
  },
  {
    name: "question pending",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "triage", status: "waiting_human" });
      store.addApproval(item.id, "question", "Re-run review?", null);
    },
    card: { kind: "question", prompt: "Re-run review?" },
    current: "triage",
    status: "Asked you a question",
  },
  {
    name: "spec approval",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "planning",
        status: "waiting_human",
        spec_state: "awaiting_approval",
      });
      store.addApproval(item.id, "spec", "Names in cron", SPEC_PR);
    },
    card: {
      kind: "spec",
      prompt: "Names in cron",
      refUrl: SPEC_PR,
      refLabel: "Spec #12",
    },
    current: "spec",
    status: "Spec needs approval",
  },
  {
    name: "building with a live run",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "building" });
      addRun(store, item, "triage", "TRIAGE", "succeeded");
      addRun(store, item, "implement", "IMPLEMENT", "running");
    },
    card: { kind: "live" },
    // The live run is the card, not a conversation entry.
    conversation: ["message", "run:triage"],
    current: "building",
    status: "Working",
  },
  {
    name: "PR handoff",
    setup: (store, item) => {
      store.updateItem(item.id, {
        stage: "handoff",
        pr_url: PR,
        review_count: 1,
        revision_count: 1,
      });
    },
    card: {
      kind: "pr",
      prUrl: PR,
      prLabel: "PR #14",
      reviews: { used: 1, max: 1 },
      revisions: { used: 1, max: 2 },
    },
    current: "handoff",
    status: "Ready to merge",
  },
  {
    name: "failed run",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "building" });
      addRun(store, item, "implement", "IMPLEMENT", "failed", {
        error: "exit 1: tests failed",
      });
    },
    card: {
      kind: "failed",
      reason: "Run failed",
      detail: "exit 1: tests failed",
    },
    current: "building",
    status: "Run failed",
  },
  {
    name: "budget exhausted",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "building", cost_usd: 15 });
      store.addMessage(item.id, "factory", "Budget exhausted.");
    },
    card: {
      kind: "failed",
      reason: "Budget exhausted",
      detail: null,
      lastRun: null,
    },
    current: "building",
    status: "Budget exhausted",
  },
  {
    name: "complete",
    setup: (store, item) => {
      addRun(store, item, "implement", "IMPLEMENT", "succeeded");
      addRun(store, item, "review", "REVIEW", "succeeded", {
        review_verdict: "revision_needed",
      });
      addRun(store, item, "review", "REVIEW", "succeeded", {
        review_verdict: "accepted",
      });
      store.updateItem(item.id, {
        stage: "complete",
        status: "done",
        pr_url: PR,
        pr_merged: 1,
        cost_usd: 4.16,
        review_count: 1,
        revision_count: 1,
      });
    },
    card: {
      kind: "complete",
      merged: true,
      prLabel: "PR #14",
      costUsd: 4.16,
      runs: 3,
      revisions: 1,
      reviews: 1,
      // The last review's verdict is the outcome.
      reviewOutcome: "accepted",
      revised: false,
    },
    current: "none",
    status: "Complete",
  },
  {
    name: "complete before review verdicts were recorded",
    setup: (store, item) => {
      addRun(store, item, "review", "REVIEW", "succeeded", {
        result: "Verdict: accepted",
      });
      store.updateItem(item.id, {
        stage: "complete",
        status: "done",
        review_count: 1,
      });
    },
    card: {
      kind: "complete",
      reviews: 1,
      reviewOutcome: null,
      revised: false,
    },
    current: "none",
    status: "Complete",
  },
  {
    name: "complete after a follow-up review that stated no verdict",
    setup: (store, item) => {
      addRun(store, item, "review", "REVIEW", "succeeded", {
        review_verdict: "accepted",
      });
      addRun(store, item, "review", "REVIEW", "succeeded", {
        result: "Checked the fix; nothing new.",
      });
      store.updateItem(item.id, {
        stage: "complete",
        status: "done",
        review_count: 1,
      });
    },
    card: { kind: "complete", reviews: 1, reviewOutcome: "accepted" },
    current: "none",
    status: "Complete",
  },
  {
    name: "complete with a revision after a revision needed review",
    setup: (store, item) => {
      addRun(store, item, "implement", "IMPLEMENT", "succeeded");
      addRun(store, item, "review", "REVIEW", "succeeded", {
        review_verdict: "revision_needed",
      });
      // A failed revision does not count; the succeeded follow-up does.
      addRun(store, item, "implement", "IMPLEMENT", "failed");
      addRun(store, item, "implement", "IMPLEMENT", "succeeded");
      store.updateItem(item.id, {
        stage: "complete",
        status: "done",
        review_count: 1,
        revision_count: 1,
      });
    },
    card: {
      kind: "complete",
      reviewOutcome: "revision_needed",
      revised: true,
    },
    current: "none",
    status: "Complete",
  },
  {
    name: "complete without a revision after a revision needed review",
    setup: (store, item) => {
      addRun(store, item, "implement", "IMPLEMENT", "succeeded");
      addRun(store, item, "review", "REVIEW", "succeeded", {
        review_verdict: "revision_needed",
      });
      addRun(store, item, "implement", "IMPLEMENT", "failed");
      store.updateItem(item.id, {
        stage: "complete",
        status: "done",
        review_count: 1,
      });
    },
    card: {
      kind: "complete",
      reviewOutcome: "revision_needed",
      revised: false,
    },
    current: "none",
    status: "Complete",
  },
  {
    name: "cancelled",
    setup: (store, item) => {
      store.updateItem(item.id, { stage: "cancelled", status: "done" });
    },
    card: { kind: "cancelled" },
    current: "complete",
    status: "Cancelled",
  },
];

for (const { name, setup, card, current, status, conversation } of cases)
  test(`item detail: ${name}`, () => {
    const dto = fixture(setup);
    assert.equal(dto.card.kind, card.kind);
    for (const [key, value] of Object.entries(card))
      assert.deepEqual(dto.card[key as keyof typeof dto.card], value, key);
    assert.equal(
      dto.progress.find((s) => s.state === "current")?.key ?? "none",
      current,
    );
    assert.equal(dto.status.label, status);
    if (conversation)
      assert.deepEqual(
        dto.conversation.map(
          (e) => `${e.kind}${e.kind === "run" ? `:${e.agent}` : ""}`,
        ),
        conversation,
      );
  });

test("item detail: progress marks earlier stages done and a skipped spec", () => {
  const dto = fixture((store, item) =>
    store.updateItem(item.id, { stage: "reviewing" }),
  );
  assert.deepEqual(
    dto.progress.map((s) => `${s.key}:${s.state}`),
    [
      "intake:done",
      "triage:done",
      "planning:done",
      "spec:skipped",
      "building:done",
      "reviewing:current",
      "handoff:todo",
      "complete:todo",
    ],
  );
  assert.equal(dto.progress[5]?.tone, "reviewing");
  const done = fixture((store, item) =>
    store.updateItem(item.id, { stage: "complete", status: "done" }),
  );
  assert.ok(done.progress.every((s) => s.state === "done"));
  const cancelled = fixture((store, item) =>
    store.updateItem(item.id, { stage: "cancelled", status: "done" }),
  );
  assert.equal(cancelled.progress.at(-1)?.label, "Cancelled");
});

test("item detail: conversation interleaves messages, agent runs and resolved approvals", () => {
  const dto = fixture((store, item) => {
    store.addMessage(item.id, "factory", "Picked up #1.");
    addRun(store, item, "foreman", "FOREMAN", "succeeded", { cost_usd: 0.16 });
    addRun(store, item, "triage", "TRIAGE", "succeeded", {
      result: "## Findings\n\nNames are not supported today.",
    });
    const spec = store.addApproval(item.id, "spec", "Spec", SPEC_PR);
    store.resolveApproval(spec, "approved", null);
    store.addApproval(item.id, "question", "Still pending?", null);
  });
  assert.deepEqual(
    dto.conversation.map((e) => e.kind),
    ["message", "message", "run", "approval"],
  );
  const [request, factory, run, approval] = dto.conversation;
  // The item's request opens the conversation, from the requester.
  assert.deepEqual(
    request?.kind === "message" && [
      request.author,
      request.name,
      request.body,
      request.at,
    ],
    ["human", "alwi", "Support JAN–DEC", dto.details.createdAt],
  );
  assert.equal(factory?.kind === "message" && factory.name, "Foreman");
  assert.deepEqual(
    run?.kind === "run" && [run.title, run.summary, run.icon, run.status],
    ["triage · claude", "Findings", "scan-search", "succeeded"],
  );
  assert.deepEqual(
    approval?.kind === "approval" && [approval.status, approval.refLabel],
    ["approved", "#12"],
  );
  // Foreman turns are summed into one row ahead of the agent runs.
  assert.deepEqual(
    dto.runs.map((r) => [r.name, r.model, r.turns, r.costUsd]),
    [
      ["foreman", "claude sonnet", 1, 0.16],
      ["triage", "claude", null, 0],
    ],
  );
});

test("item detail: properties carry links, budget and counters", () => {
  const dto = fixture((store, item) => {
    store.updateItem(item.id, {
      stage: "building",
      cost_usd: 1.12,
      pr_url: PR,
      foreman_turns: 3,
    });
    store.addApproval(item.id, "spec", "Spec", SPEC_PR);
  });
  assert.deepEqual(dto.details, {
    source: "GitHub issue",
    repo: "acme/app",
    automation: "issue-labeled",
    requester: "alwi",
    createdAt: dto.details.createdAt,
    issue: {
      label: "Issue app#5",
      url: "https://github.com/acme/app/issues/5",
    },
    specPr: { label: "Spec #12", url: SPEC_PR },
    pr: { label: "PR #14", url: PR, merged: false },
  });
  assert.deepEqual(dto.budget, {
    usedUsd: 1.12,
    limitUsd: 15,
    ratio: 1.12 / 15,
    exhausted: false,
  });
  assert.deepEqual(dto.counters, {
    reviews: { used: 0, max: 1 },
    revisions: { used: 0, max: 2 },
  });
  assert.equal(dto.request, "Support JAN–DEC");
  assert.equal(dto.closed, false);
});

test("item detail: the Handoff Gate lists the checks the item copied, met or not by its latest runs", () => {
  // An item whose factory added no checks lists none.
  assert.deepEqual(fixture().handoffGate, []);

  const dto = fixture((store, item) => {
    store.updateItem(item.id, {
      stage: "handoff",
      pr_url: PR,
      gate_checks: '["review","verification"]',
    });
    addRun(store, item, "review", "REVIEW", "succeeded", {
      review_verdict: "accepted",
    });
    addRun(store, item, "verify", "VERIFY", "succeeded");
    addRun(store, item, "verify", "VERIFY", "cancelled");
  });
  const expected = [
    { check: "review", label: "Review accepted", met: true },
    // The latest verify run was cancelled, so the earlier success no longer counts.
    { check: "verification", label: "Verification passed", met: false },
  ];
  assert.deepEqual(dto.handoffGate, expected);
  assert.equal(dto.card.kind, "pr");
  assert.deepEqual(
    dto.card.kind === "pr" ? dto.card.gateChecks : null,
    expected,
  );
});

test("item detail: an unknown item has no detail", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  assert.equal(readItem(store, 99), undefined);
  store.db.close();
});

test("pull request DTO summarises checks", () => {
  const pr = {
    title: "feat: retry",
    headRefName: "nakara/item-23",
    headRefOid: "0123456789abcdef0123456789abcdef01234567",
    baseRefName: "main",
    additions: 184,
    deletions: 22,
  };
  const checks = (...rollup: Record<string, string>[]) =>
    pullRequestDto(PR, { ...pr, statusCheckRollup: rollup }).checks;
  assert.deepEqual(pullRequestDto(PR, pr), {
    title: "feat: retry",
    repo: "acme/app",
    head: "nakara/item-23",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    base: "main",
    additions: 184,
    deletions: 22,
    checks: "none",
  });
  assert.equal(
    checks(
      { status: "COMPLETED", conclusion: "SUCCESS" },
      { state: "SUCCESS" },
    ),
    "passing",
  );
  assert.equal(
    checks(
      { status: "IN_PROGRESS", conclusion: "" },
      { status: "COMPLETED", conclusion: "FAILURE" },
    ),
    "failing",
  );
  assert.equal(checks({ state: "PENDING" }), "pending");
  assert.equal(checks({ status: "QUEUED", conclusion: "" }), "pending");
});
