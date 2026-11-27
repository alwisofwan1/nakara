import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";

import { type ChangeEvent, type Run, Store } from "../db.ts";

const STATUS = { type: "status", id: "global" } as const;
const ITEMS = { type: "items", id: "global" } as const;
const RUNS = { type: "runs", id: "global" } as const;
const item = (id: number) => ({ type: "item", id: String(id) }) as const;
const run = (id: number) => ({ type: "run", id: String(id) }) as const;

/** A store with one work item and helpers to observe what a call notifies. */
function setup(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const itemId = store.createItem({
    title: "T",
    request: "R",
    source: "manual",
  }).id;
  const agentRun = (status: Run["status"] = "queued") =>
    store.createRun({
      item_id: itemId,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "go",
      session_id: "s1",
      status,
    });
  /** The changes `fn` notifies, after the notifier's microtask flushes. */
  const changes = async (fn: () => unknown): Promise<ChangeEvent[]> => {
    await setImmediate();
    const seen: ChangeEvent[] = [];
    const listener = (e: ChangeEvent) => seen.push(e);
    store.changes.on("change", listener);
    try {
      fn();
      await setImmediate();
    } finally {
      store.changes.off("change", listener);
    }
    return seen;
  };
  return { store, itemId, agentRun, changes };
}

// Every public Store method is classified here, so a new one cannot skip this test.
const WRITES = [
  "createItem",
  "updateItem",
  "applyPolicyState",
  "addCost",
  "addEvent",
  "markEventsProcessed",
  "createRun",
  "markRunStarted",
  "moveRunLogs",
  "setRunSession",
  "setRunSnapshots",
  "countRunTool",
  "cancelQueuedRuns",
  "finishRun",
  "interruptRun",
  "recoverOrphanedRuns",
  "addMessage",
  "addApproval",
  "resolveApproval",
  "addEvidence",
  "setEvidenceUrl",
  "addLearning",
  "addRecurrences",
  "resolveLearning",
  "setKv",
];
const READS = [
  "item",
  "itemByIssueUrl",
  "itemBySourceRef",
  "items",
  "closedItems",
  "totalCost",
  "outcomes",
  "stageFlow",
  "requesters",
  "automationHistory",
  "itemsWithOpenPr",
  "pendingEvents",
  "itemsWithPendingEvents",
  "events",
  "queuedRuns",
  "runById",
  "runsForAgent",
  "runs",
  "recentRuns",
  "runAgents",
  "runningRuns",
  "latestAgentSession",
  "factoryMessagesAfter",
  "lastMessageId",
  "messages",
  "approval",
  "approvals",
  "latestEvidence",
  "itemsWithUnpostedEvidence",
  "evidenceAfter",
  "lastEvidenceId",
  "learning",
  "pendingLearnings",
  "approvedLearnings",
  "getKv",
];
const INFRASTRUCTURE = ["constructor", "notify", "close", "transaction"];

test("every Store method is classified as a write or a read", () => {
  assert.deepEqual(
    Object.getOwnPropertyNames(Store.prototype).sort(),
    [...WRITES, ...READS, ...INFRASTRUCTURE].sort(),
  );
});

const ended = {
  result: null,
  cost_usd: 1,
  num_turns: null,
  duration_ms: null,
  session_id: null,
};

/**
 * Each write, set up on a fresh store: the call, and the changes it must
 * notify (computed after the call, so they can name what it created).
 */
const writes: Record<
  (typeof WRITES)[number],
  (s: ReturnType<typeof setup>) => {
    call: () => unknown;
    expected: () => ChangeEvent[];
  }
> = {
  createItem: ({ store }) => {
    let id = 0;
    return {
      call: () => {
        id = store.createItem({
          title: "U",
          request: "R",
          source: "manual",
        }).id;
      },
      expected: () => [STATUS, ITEMS, item(id)],
    };
  },
  updateItem: ({ store, itemId }) => ({
    call: () => store.updateItem(itemId, { title: "V" }),
    expected: () => [STATUS, ITEMS, item(itemId)],
  }),
  applyPolicyState: ({ store, itemId }) => ({
    call: () =>
      store.applyPolicyState(itemId, {
        stage: "triage",
        status: "active",
        specState: "none",
        reviewCount: 0,
        revisionCount: 0,
        costUsd: 0,
        budgetUsd: 15,
        runCount: 0,
        maxRuns: 50,
        maxReviews: 1,
        maxRevisions: 2,
        specRule: "when_asked",
        specRequested: false,
        gateChecks: [],
        reviewAccepted: false,
        verificationPassed: false,
        prUrl: null,
        prMerged: false,
      }),
    expected: () => [STATUS, ITEMS, item(itemId)],
  }),
  addCost: ({ store, itemId }) => ({
    call: () => store.addCost(itemId, 1),
    expected: () => [STATUS, ITEMS, item(itemId)],
  }),
  // No live client shows events.
  addEvent: ({ store, itemId }) => ({
    call: () => store.addEvent(itemId, "human_message", { text: "hi" }),
    expected: () => [],
  }),
  markEventsProcessed: ({ store, itemId }) => {
    const id = store.addEvent(itemId, "human_message", { text: "hi" });
    return {
      call: () => store.markEventsProcessed([id]),
      expected: () => [],
    };
  },
  // A run counts toward its item's run limit.
  createRun: ({ agentRun, itemId }) => {
    let id = 0;
    return {
      call: () => {
        id = agentRun().id;
      },
      expected: () => [STATUS, ITEMS, item(itemId), RUNS, run(id)],
    };
  },
  markRunStarted: ({ store, agentRun }) => {
    const { id } = agentRun();
    return {
      call: () => store.markRunStarted(id, "/tmp/log"),
      expected: () => [STATUS, ITEMS, RUNS, run(id)],
    };
  },
  moveRunLogs: ({ store, itemId, agentRun }) => {
    const { id } = agentRun();
    store.markRunStarted(id, "/w/item-1/.nakara/logs/run.jsonl");
    return {
      call: () =>
        store.moveRunLogs(itemId, "/w/item-1/.nakara", "/w/item-1.nakara"),
      expected: () => [STATUS, ITEMS, RUNS],
    };
  },
  setRunSession: ({ store, agentRun }) => {
    const { id } = agentRun();
    return {
      call: () => store.setRunSession(id, "s2"),
      expected: () => [STATUS, ITEMS, RUNS, run(id)],
    };
  },
  // The diff is fetched when the run page opens it and when the run ends.
  setRunSnapshots: ({ store, agentRun }) => {
    const { id } = agentRun("running");
    return {
      call: () => store.setRunSnapshots(id, [{ slug: "o/r", start: "abc" }]),
      expected: () => [],
    };
  },
  // The run page lists the tools as they are called.
  countRunTool: ({ store, agentRun }) => {
    const { id } = agentRun("running");
    return {
      call: () => store.countRunTool(id, "mcp__sentry__get_issue"),
      expected: () => [run(id)],
    };
  },
  cancelQueuedRuns: ({ store, itemId, agentRun }) => {
    const a = agentRun().id;
    agentRun("running");
    const b = agentRun().id;
    return {
      call: () => store.cancelQueuedRuns(itemId),
      expected: () => [run(a), run(b), STATUS, ITEMS, RUNS],
    };
  },
  finishRun: ({ store, agentRun }) => {
    const { id } = agentRun("running");
    return {
      call: () =>
        store.finishRun(id, {
          status: "succeeded",
          result: "done",
          error: null,
          cost_usd: 0,
          num_turns: 1,
          duration_ms: 1,
          session_id: null,
          log_path: null,
        }),
      expected: () => [STATUS, ITEMS, RUNS, run(id)],
    };
  },
  // Charges the item, queues a run that resumes it, and ends it.
  interruptRun: ({ store, itemId, agentRun }) => {
    const { id } = agentRun("running");
    let resume = 0;
    return {
      call: () => {
        resume =
          store.transaction(() => store.interruptRun(id, ended, "Stopped."))
            .resume?.id ?? 0;
      },
      expected: () => [STATUS, ITEMS, item(itemId), RUNS, run(resume), run(id)],
    };
  },
  recoverOrphanedRuns: ({ store, agentRun, itemId }) => {
    const { id } = agentRun("running");
    store.db
      .prepare("UPDATE runs SET instance_id = 'gone' WHERE id = ?")
      .run(id);
    return {
      call: () => store.recoverOrphanedRuns(),
      // The orphan has no cost to charge; its item changes by the resume it counts.
      expected: () => [STATUS, ITEMS, item(itemId), RUNS, run(id + 1), run(id)],
    };
  },
  // Messages feed a work item's conversation and the Inbox's recent events.
  addMessage: ({ store, itemId }) => ({
    call: () => store.addMessage(itemId, "factory", "hello"),
    expected: () => [ITEMS],
  }),
  addApproval: ({ store, itemId }) => ({
    call: () => store.addApproval(itemId, "question", "Which?", null, ["a"]),
    expected: () => [STATUS, ITEMS],
  }),
  resolveApproval: ({ store, itemId }) => {
    const id = store.addApproval(itemId, "question", "Which?", null, ["a"]);
    return {
      call: () => store.resolveApproval(id, "answered", "a"),
      expected: () => [STATUS, ITEMS],
    };
  },
  addEvidence: ({ store, itemId, agentRun }) => {
    const runId = agentRun().id;
    return {
      call: () =>
        store.addEvidence(itemId, runId, [{ criterion: "c", file: "/f.png" }]),
      expected: () => [item(itemId)],
    };
  },
  // The GitHub link is shown nowhere live.
  setEvidenceUrl: ({ store, itemId, agentRun }) => {
    store.addEvidence(itemId, agentRun().id, [
      { criterion: "c", file: "/f.png" },
    ]);
    return {
      call: () => store.setEvidenceUrl(1, "https://github.com/x"),
      expected: () => [],
    };
  },
  // Pending lessons are Inbox entries.
  addLearning: ({ store, itemId, agentRun }) => {
    const runId = agentRun().id;
    return {
      call: () =>
        store.addLearning(itemId, runId, {
          lines: ["l"],
          mistake: "m",
          suggestCheck: false,
        }),
      expected: () => [STATUS, ITEMS],
    };
  },
  // An approved lesson's recurrences show on Activity.
  addRecurrences: ({ store, itemId, agentRun }) => {
    const id =
      store.addLearning(itemId, agentRun().id, {
        lines: ["l"],
        mistake: "m",
        suggestCheck: false,
      }) ?? 0;
    store.resolveLearning(id, "approved", {});
    return {
      call: () => store.addRecurrences([id], 1),
      expected: () => [STATUS, ITEMS],
    };
  },
  resolveLearning: ({ store, itemId, agentRun }) => {
    const id =
      store.addLearning(itemId, agentRun().id, {
        lines: ["l"],
        mistake: "m",
        suggestCheck: false,
      }) ?? 0;
    return {
      call: () => store.resolveLearning(id, "rejected", {}),
      expected: () => [STATUS, ITEMS],
    };
  },
  setKv: ({ store }) => ({
    call: () => store.setKv("k", "v"),
    expected: () => [STATUS],
  }),
};

test("every write notifies exactly its channels", async (t) => {
  assert.deepEqual(Object.keys(writes).sort(), [...WRITES].sort());
  for (const [name, write] of Object.entries(writes)) {
    const s = setup(t);
    const { call, expected } = write(s);
    assert.deepEqual(await s.changes(call), expected(), name);
  }
});

test("writes that change nothing notify nothing", async (t) => {
  const { store, itemId, agentRun, changes } = setup(t);
  assert.deepEqual(await changes(() => store.updateItem(itemId, {})), []);
  assert.deepEqual(await changes(() => store.addCost(itemId, 0)), []);
  // A second pending lesson for the item and a decision on a decided one change nothing.
  const proposal = { lines: ["l"], mistake: "m", suggestCheck: false };
  const runId = agentRun().id;
  const id = store.addLearning(itemId, runId, proposal) ?? 0;
  assert.deepEqual(
    await changes(() => store.addLearning(itemId, runId, proposal)),
    [],
  );
  store.resolveLearning(id, "rejected", {});
  // A rejected lesson takes no recurrence.
  assert.deepEqual(await changes(() => store.addRecurrences([id], 1)), []);
  assert.deepEqual(
    await changes(() => store.resolveLearning(id, "approved", {})),
    [],
  );
});

test("reads notify nothing", async (t) => {
  const { store, itemId, agentRun, changes } = setup(t);
  const { id } = agentRun();
  store.addEvent(itemId, "human_message", {});
  store.addMessage(itemId, "factory", "hello");
  const approval = store.addApproval(itemId, "spec", "Ok?", null);
  store.setKv("k", "v");
  const reads: Record<(typeof READS)[number], () => unknown> = {
    item: () => store.item(itemId),
    itemByIssueUrl: () => store.itemByIssueUrl("u"),
    itemBySourceRef: () => store.itemBySourceRef("r"),
    items: () => [store.items(), store.items({ open: true })],
    closedItems: () => store.closedItems(5),
    totalCost: () => store.totalCost(),
    outcomes: () => store.outcomes(),
    stageFlow: () => store.stageFlow(),
    requesters: () => store.requesters(),
    automationHistory: () => store.automationHistory("a"),
    itemsWithOpenPr: () => store.itemsWithOpenPr(),
    pendingEvents: () => store.pendingEvents(itemId),
    itemsWithPendingEvents: () => store.itemsWithPendingEvents(),
    events: () => store.events(itemId),
    queuedRuns: () => store.queuedRuns(),
    runById: () => store.runById(id),
    runsForAgent: () => store.runsForAgent("implement"),
    runs: () => store.runs(itemId),
    recentRuns: () => store.recentRuns(),
    runAgents: () => store.runAgents(),
    runningRuns: () => store.runningRuns(),
    latestAgentSession: () => store.latestAgentSession(itemId, "implement"),
    factoryMessagesAfter: () => store.factoryMessagesAfter(0),
    lastMessageId: () => store.lastMessageId(),
    messages: () => store.messages(itemId),
    approval: () => store.approval(approval),
    approvals: () => store.approvals(itemId),
    latestEvidence: () => store.latestEvidence(itemId),
    itemsWithUnpostedEvidence: () => store.itemsWithUnpostedEvidence(),
    evidenceAfter: () => store.evidenceAfter(0),
    lastEvidenceId: () => store.lastEvidenceId(),
    learning: () => store.learning(1),
    pendingLearnings: () => store.pendingLearnings(),
    approvedLearnings: () => store.approvedLearnings(),
    getKv: () => store.getKv("k"),
  };
  assert.deepEqual(Object.keys(reads).sort(), [...READS].sort());
  for (const [name, read] of Object.entries(reads))
    assert.deepEqual(await changes(read), [], name);
});
