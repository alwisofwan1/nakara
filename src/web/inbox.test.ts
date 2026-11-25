import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { type Run, Store, stubFactorySeed, type WorkItem } from "../db.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { createApi } from "./api.ts";
import { type InboxDto, inboxCount, RECENT_LIMIT, readInbox } from "./inbox.ts";
import { itemView } from "./items.ts";

const SPEC_PR = "https://github.com/acme/app/pull/12";
const PR = "https://github.com/acme/app/pull/14";

function agentRun(
  store: Store,
  item: WorkItem,
  status: Run["status"],
  error: string | null = null,
) {
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    session_id: null,
    input: "",
    status: "running",
  });
  if (status !== "running")
    store.finishRun(run.id, {
      status,
      result: null,
      error,
      cost_usd: 0,
      num_turns: null,
      duration_ms: null,
      session_id: null,
      log_path: null,
    });
  return run;
}

/** One item per Inbox kind, plus items that must not be listed. */
function seed(store: Store) {
  const create = (title: string) =>
    store.createItem({ title, request: "", source: "manual" });
  const spec = create("Spec item");
  store.updateItem(spec.id, {
    stage: "planning",
    status: "waiting_human",
    spec_state: "awaiting_approval",
    cost_usd: 1.12,
  });
  const specApproval = store.addApproval(
    spec.id,
    "spec",
    "Accept month names.",
    SPEC_PR,
  );
  const question = create("Question item");
  store.updateItem(question.id, { status: "waiting_human" });
  store.addMessage(question.id, "factory", "Which time?\nDetails follow.");
  const questionApproval = store.addApproval(
    question.id,
    "question",
    "Which time?",
    null,
    ["09:00 UTC", "17:00 UTC"],
  );
  const pr = create("PR item");
  store.updateItem(pr.id, {
    stage: "handoff",
    status: "waiting_human",
    pr_url: PR,
  });
  const failed = create("Failed item");
  store.updateItem(failed.id, { stage: "building" });
  const failedRun = agentRun(store, failed, "failed", "npm ci timed out");
  const broke = create("Budget item");
  store.updateItem(broke.id, {
    stage: "building",
    cost_usd: 16,
    budget_usd: 15,
  });
  const paused = create("Paused item");
  store.updateItem(paused.id, { stage: "building", status: "paused" });
  store.addMessage(paused.id, "factory", "Checks unreadable.");
  // Working and closed items never need you, even with a stale approval.
  agentRun(store, create("Busy item"), "running");
  const closed = create("Closed item");
  store.addApproval(closed.id, "question", "Stale?", null);
  store.updateItem(closed.id, { stage: "cancelled" });
  return {
    spec,
    specApproval,
    question,
    questionApproval,
    pr,
    failed,
    failedRun,
    broke,
    paused,
  };
}

const entry = (dto: InboxDto, id: number) =>
  dto.entries.find((e) => e.itemId === id);

test("inbox lists every kind with counts, summaries and options, without writes", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    assert.deepEqual(readInbox(store), {
      entries: [],
      reach: [],
      lessons: [],
      counts: { all: 0, question: 0, spec: 0, pr: 0, failed: 0 },
    });
    const s = seed(store);
    const dto = readInbox(store);
    assert.deepEqual(dto.counts, {
      all: 6,
      question: 1,
      spec: 1,
      pr: 1,
      failed: 3,
    });
    assert.equal(inboxCount(store), 6);
    assert.deepEqual(dto.entries.map((e) => e.title).sort(), [
      "Budget item",
      "Failed item",
      "PR item",
      "Paused item",
      "Question item",
      "Spec item",
    ]);

    const spec = entry(dto, s.spec.id);
    assert.equal(spec?.kind, "spec");
    assert.equal(spec?.label, "Spec needs approval");
    assert.equal(spec?.summary, "Accept month names.");
    assert.equal(spec?.costUsd, 1.12);
    assert.deepEqual(spec?.approval, {
      id: s.specApproval,
      prompt: "Accept month names.",
      refUrl: SPEC_PR,
      options: [],
    });
    assert.deepEqual(
      spec?.chips.map((chip) => chip.label),
      ["Spec #12", "Manual"],
    );

    const question = entry(dto, s.question.id);
    assert.equal(question?.kind, "question");
    assert.equal(question?.summary, "Which time?");
    assert.deepEqual(question?.approval?.options, ["09:00 UTC", "17:00 UTC"]);
    assert.deepEqual(
      question?.recent.map((event) => event.text),
      ["Foreman: Which time?"],
    );

    const pr = entry(dto, s.pr.id);
    assert.equal(pr?.kind, "pr");
    assert.equal(pr?.summary, "PR #14 is ready for review and merge.");
    assert.equal(pr?.prUrl, PR);
    assert.equal(pr?.approval, null);

    const failed = entry(dto, s.failed.id);
    assert.equal(failed?.kind, "failed");
    assert.equal(failed?.label, "Run failed");
    assert.equal(
      failed?.summary,
      `implement run #${s.failedRun.id} failed: npm ci timed out`,
    );
    assert.deepEqual(failed?.recent, [
      {
        at: store.runById(s.failedRun.id)?.ended_at,
        icon: "bot",
        tone: "bad",
        text: `implement run #${s.failedRun.id} failed`,
      },
    ]);
    assert.equal(entry(dto, s.broke.id)?.label, "Budget exhausted");
    assert.equal(
      entry(dto, s.broke.id)?.summary,
      "Spent $16.00 of the $15.00 budget.",
    );
    assert.equal(entry(dto, s.paused.id)?.summary, "Checks unreadable.");

    // Newest first: approvals by when they were asked, the rest by last update.
    const at = dto.entries.map((e) => e.at);
    assert.deepEqual(at, [...at].sort().reverse());
    assert.deepEqual(readInbox(store), dto);
  } finally {
    store.db.close();
  }
});

test("inbox keeps the latest events in order and tolerates malformed options", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const item = store.createItem({
      title: "Busy",
      request: "",
      source: "manual",
    });
    for (let i = 0; i < RECENT_LIMIT + 2; i++)
      store.addMessage(item.id, i % 2 ? "human" : "factory", `Message ${i}`);
    const approval = store.addApproval(item.id, "question", "Go?", null);
    store.db
      .prepare("UPDATE approvals SET options = ? WHERE id = ?")
      .run("{not json", approval);
    const [dto] = readInbox(store).entries;
    assert.deepEqual(dto?.approval?.options, []);
    assert.deepEqual(
      dto?.recent.map((event) => event.text),
      [
        "Foreman: Message 2",
        "You: Message 3",
        "Foreman: Message 4",
        "You: Message 5",
        "Foreman: Message 6",
      ],
    );
  } finally {
    store.db.close();
  }
});

test("approval endpoint approves, requests changes and answers like the form", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const registry = new FactoryRegistry(store, loadConfig({}));
    registry.default.pump = async () => {};
    const api = createApi(registry, loadConfig({}));
    const post = (id: number | string, body: unknown) =>
      api.request(`/approvals/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const error = async (response: Response) =>
      ((await response.json()) as { error: { code: string; message: string } })
        .error;
    const s = seed(store);

    const listed = (await (await api.request("/inbox")).json()) as InboxDto;
    assert.equal(listed.counts.all, 6);

    // Request changes needs feedback, then sends the spec back to drafting.
    let response = await post(s.specApproval, { decision: "reject" });
    assert.equal(response.status, 400);
    assert.equal(
      (await error(response)).message,
      "Say what should change in the spec.",
    );
    response = await post(s.specApproval, { decision: "answer", answer: "x" });
    assert.equal(response.status, 400);
    response = await post(s.specApproval, {
      decision: "reject",
      answer: " Use ISO names. ",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { itemId: s.spec.id });
    assert.equal(store.approval(s.specApproval)?.status, "rejected");
    assert.equal(store.approval(s.specApproval)?.answer, "Use ISO names.");
    assert.equal(store.item(s.spec.id)?.spec_state, "drafting");
    assert.equal(store.messages(s.spec.id).at(-1)?.body, "Use ISO names.");
    // A resolved approval is a policy refusal.
    response = await post(s.specApproval, { decision: "approve" });
    assert.equal(response.status, 409);
    assert.equal((await error(response)).code, "policy");

    // Approve without feedback.
    store.updateItem(s.spec.id, {
      spec_state: "awaiting_approval",
      status: "waiting_human",
    });
    const second = store.addApproval(s.spec.id, "spec", "Again", SPEC_PR);
    response = await post(second, { decision: "approve" });
    assert.equal(response.status, 200);
    assert.equal(store.approval(second)?.status, "approved");
    assert.equal(store.item(s.spec.id)?.spec_state, "approved");
    assert.equal(store.item(s.spec.id)?.status, "active");
    assert.equal(store.messages(s.spec.id).at(-1)?.body, "Approved.");

    // Questions need a non-empty answer and resolve the item.
    response = await post(s.questionApproval, { decision: "approve" });
    assert.equal(response.status, 400);
    response = await post(s.questionApproval, {
      decision: "answer",
      answer: "  ",
    });
    assert.equal(response.status, 400);
    response = await post(s.questionApproval, {
      decision: "answer",
      answer: "09:00 UTC",
    });
    assert.equal(response.status, 200);
    assert.equal(store.approval(s.questionApproval)?.status, "answered");
    assert.equal(store.approval(s.questionApproval)?.answer, "09:00 UTC");
    assert.equal(store.item(s.question.id)?.status, "active");

    const after = (await (await api.request("/inbox")).json()) as InboxDto;
    assert.equal(entry(after, s.spec.id), undefined);
    assert.equal(entry(after, s.question.id), undefined);
    assert.deepEqual(after.counts, {
      all: 4,
      question: 0,
      spec: 0,
      pr: 1,
      failed: 3,
    });

    // A closed item's approval is refused, not resolved.
    const closed = store.addApproval(s.pr.id, "question", "Merge?", null);
    store.updateItem(s.pr.id, { stage: "cancelled" });
    response = await post(closed, { decision: "answer", answer: "Yes" });
    assert.equal(response.status, 409);
    assert.equal(store.approval(closed)?.status, "pending");

    assert.equal((await post(9999, { decision: "approve" })).status, 404);
    assert.equal((await post("abc", { decision: "approve" })).status, 400);
    assert.equal((await post(second, { decision: "merge" })).status, 400);
  } finally {
    store.db.close();
  }
});

test("a posted message invalidates the inbox", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const item = store.createItem({
      title: "Msg",
      request: "",
      source: "manual",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const events: unknown[] = [];
    store.changes.on("change", (event) => events.push(event));
    store.addMessage(item.id, "factory", "Checks unreadable.");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(events, [{ type: "items", id: "global" }]);
  } finally {
    store.db.close();
  }
});

test("the inbox spans factories and filters by one", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const harbor = store.repos.factories.createFactory({
      ...stubFactorySeed(),
      slug: "harbor",
      name: "Harbor",
    });
    const ask = (title: string, factoryId?: number) => {
      const item = store.createItem({
        title,
        request: "r",
        source: "manual",
        factoryId,
      });
      store.updateItem(item.id, { status: "waiting_human" });
      store.addApproval(item.id, "question", "Which?", null);
      return item;
    };
    const mine = ask("Default question");
    const theirs = ask("Harbor question", harbor.id);
    const entries = (dto: InboxDto) =>
      dto.entries.map((e) => [e.itemId, e.factory]);

    assert.deepEqual(entries(readInbox(store)), [
      [theirs.id, "harbor"],
      [mine.id, "default"],
    ]);
    assert.deepEqual(entries(readInbox(store, { factoryId: harbor.id })), [
      [theirs.id, "harbor"],
    ]);
    const api = createApi(
      new FactoryRegistry(store, loadConfig({})),
      loadConfig({}),
    );
    const filtered = (await (
      await api.request("/inbox?factory=default")
    ).json()) as InboxDto;
    assert.deepEqual(entries(filtered), [[mine.id, "default"]]);
    assert.equal(filtered.counts.all, 1);
    assert.equal((await api.request("/inbox?factory=missing")).status, 404);
  } finally {
    store.close();
  }
});

test("a held reach shows in the Inbox and its count until it is decided", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const a = store.repos.factories.createFactory({
      ...stubFactorySeed(),
      slug: "alpha",
    });
    const b = store.repos.factories.createFactory({
      ...stubFactorySeed(),
      slug: "beta",
    });
    store.setKv(
      `reach:${a.id}:pending`,
      JSON.stringify({ added: ["mcp sentry command npx"], reach: [] }),
    );
    store.setKv(`reach:${b.id}:pending`, "");
    assert.deepEqual(readInbox(store).reach, [
      { factory: "alpha", added: ["mcp sentry command npx"] },
    ]);
    assert.equal(readInbox(store).counts.all, 1);
    assert.equal(readInbox(store, { factoryId: b.id }).reach.length, 0);
    assert.equal(inboxCount(store), 1);
    store.setKv(`reach:${a.id}:pending`, "");
    assert.equal(inboxCount(store), 0);
  } finally {
    store.close();
  }
});

test("an item that used its runs shows in the Inbox and on its page with why", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const item = store.createItem({
      title: "Loop",
      request: "",
      source: "manual",
    });
    store.updateItem(item.id, {
      stage: "building",
      status: "paused",
      run_count: 30,
      max_runs: 30,
    });
    store.addMessage(item.id, "factory", "Run limit reached (30 of 30 runs).");
    const found = entry(readInbox(store), item.id);
    assert.equal(found?.kind, "failed");
    assert.equal(found?.label, "Run limit reached");
    assert.equal(
      found?.summary,
      "Started 30 of the 30 runs allowed (foreman turns and failed runs included).",
    );
    // biome-ignore lint/style/noNonNullAssertion: The item was created above.
    const view = itemView(store.item(item.id)!, [], []);
    assert.deepEqual(view.needsYou, {
      kind: "failed",
      label: "Run limit reached",
    });
    assert.deepEqual(view.runLimit, { used: 30, max: 30, exhausted: true });
  } finally {
    store.db.close();
  }
});
