import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { loadConfig } from "../config.ts";
import { type ItemEvent, RESUME_INPUT, Store } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { Logger } from "../telemetry/log.ts";
import { Metrics } from "../telemetry/metrics.ts";
import { Factory } from "./factory.ts";
import { renderEvent } from "./prompts.ts";

for (const { fails, mirror, commentFails } of [
  { fails: false, mirror: false, commentFails: false },
  { fails: true, mirror: false, commentFails: false },
  { fails: true, mirror: true, commentFails: false },
  { fails: true, mirror: true, commentFails: true },
]) {
  test(`handoff ${fails ? "reports gh failure without announcing readiness" : "marks draft and already-ready PRs ready before announcing readiness"} (mirror=${mirror}, commentFails=${commentFails})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nakara-handoff-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const calls = join(dir, "calls.jsonl");
    await writeFile(
      join(dir, "gh"),
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
if (process.argv[2] === "api") { console.log(JSON.stringify({ head: { sha: "abc1234def", ref: "nakara/1-handoff" } })); process.exit(0); }
if (process.argv[3] === "checks") { console.log('[{"name":"CI","bucket":"pass"}]'); process.exit(0); }
if (${fails} && process.argv[2] === "pr") { console.error("authentication failed"); process.exit(1); }
if (${commentFails} && process.argv[2] === "issue") { console.error("comment failed"); process.exit(1); }
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    t.after(() => {
      process.env.PATH = oldPath;
    });
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    const factory = new Factory(
      store,
      loadConfig({
        NAKARA_GITHUB_MIRROR: String(mirror),
        NAKARA_DATA_DIR: dir,
      }),
    );
    assert.ok((await factory.reloadDefinition()).ok);
    const issueUrl = "https://github.com/alwisofwan1/nakara-sandbox/issues/3";
    const item = store.createItem({
      title: "Handoff",
      request: "Ship it",
      source: "manual",
      issueUrl,
    });
    store.updateItem(item.id, { stage: "reviewing", review_count: 1 });
    const action = {
      type: "handoff",
      prUrl: "https://github.com/alwisofwan1/nakara-sandbox/pull/1",
      summary: "Implemented",
    } as const;
    const pending = factory["applyActions"](item.id, [
      { action, accepted: true },
    ]);
    assert.equal(
      store.messages(item.id).length,
      0,
      "must wait for gh before announcing readiness",
    );
    assert.deepEqual(
      await pending,
      fails ? [] : [action],
      "failed handoffs must not be mirrored as ready",
    );
    const messages = store.messages(item.id);
    assert.equal(messages.length, 1);
    if (fails) {
      // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
      assert.match(messages[0]!.body, /authentication failed/);
      // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
      assert.ok(!messages[0]!.body.includes("Ready for your review and merge"));
      // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
      assert.equal(store.item(item.id)!.stage, "handoff");
      // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
      assert.equal(store.item(item.id)!.status, "waiting_human");
    } else {
      assert.equal(
        // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
        messages[0]!.body,
        `Ready for your review and merge: ${action.prUrl} (checks passed on abc1234)\n\n${action.summary}`,
      );
      await factory["applyActions"](item.id, [{ action, accepted: true }]);
      assert.equal(store.messages(item.id).length, 2);
    }
    const commands = (await readFile(calls, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const expected = Array.from({ length: fails ? 1 : 2 }, () => [
      ["api", "repos/alwisofwan1/nakara-sandbox/pulls/1"],
      ["pr", "checks", action.prUrl, "--json", "name,bucket"],
      ["pr", "ready", action.prUrl],
    ]).flat();
    if (mirror)
      expected.push([
        "issue",
        "comment",
        issueUrl,
        "--body",
        // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
        messages[0]!.body,
      ]);
    assert.deepEqual(commands, expected);
  });
}

for (const bucket of [
  "legacy",
  "pass",
  "fail",
  "pending",
  "pending_pass",
  "absent",
  "absent_json",
  "pending_workflows",
  "pending_workflows_json",
  "error",
  "cancel",
]) {
  test(`CI handoff gate: ${bucket}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nakara-ci-"));
    const result = join(dir, "result");
    const calls = join(dir, "calls");
    await writeFile(result, bucket === "pending_pass" ? "pending" : bucket);
    await writeFile(
      join(dir, "gh"),
      `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, process.argv[3] + "\\n");
const bucket = fs.readFileSync(${JSON.stringify(result)}, "utf8");
if (process.argv[2] === "api") {
  if (process.argv[3].includes("/pulls/")) console.log(JSON.stringify({ head: { sha: "abc123", ref: "nakara/1-ci", repo: { full_name: "fork/r" } } }));
  else {
    if (process.argv[3] !== "repos/fork/r/git/trees/abc123?recursive=1") process.exit(2);
    console.log(JSON.stringify({ truncated: false, tree: bucket.startsWith("pending_workflows") ? [{ path: ".github/workflows/ci.yml", type: "blob" }] : [] }));
  }
  process.exit(0);
}
if (process.argv[3] === "view") { console.log('{"state":"OPEN"}'); process.exit(0); }
if (process.argv[3] === "checks") {
  if (bucket === "legacy") { if (process.argv.includes("--json")) { console.error("unknown flag: --json"); process.exit(1); } console.log("Quality checks\\tpass\\t1s\\thttps://example.com"); process.exit(0); }
  if (bucket === "error") { console.error("authentication failed"); process.exit(1); }
  if (bucket.endsWith("_json")) { console.log("[]"); process.exit(0); }
  if (bucket === "absent" || bucket === "pending_workflows") { console.error("no checks reported on the branch"); process.exit(1); }
  console.log(JSON.stringify([{ name: "Quality checks", bucket }]));
  process.exit(bucket === "pending" ? 8 : bucket === "fail" ? 1 : 0);
}
`,
      { mode: 0o755 },
    );
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    t.after(async () => {
      process.env.PATH = oldPath;
      await rm(dir, { recursive: true, force: true });
    });
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    t.after(() => store.db.close());
    const factory = new Factory(
      store,
      loadConfig({ NAKARA_GITHUB_MIRROR: "false", NAKARA_DATA_DIR: dir }),
    );
    assert.ok((await factory.reloadDefinition()).ok);
    const item = store.createItem({
      title: "CI",
      request: "Ship",
      source: "manual",
    });
    const action = {
      type: "handoff",
      prUrl: "https://github.com/alwisofwan1/nakara-sandbox/pull/1",
      summary: "Done",
    } as const;
    // biome-ignore lint/complexity/useLiteralKeys: Exercise the production action path.
    const applied = await factory["applyActions"](item.id, [
      { action, accepted: true },
    ]);
    const passing =
      bucket === "pass" || bucket.startsWith("absent") || bucket === "legacy";
    assert.equal(applied.length, passing ? 1 : 0);
    assert.equal(store.item(item.id)?.stage, passing ? "handoff" : "intake");
    assert.equal((await readFile(calls, "utf8")).includes("ready"), passing);
    if (bucket === "fail" || bucket === "cancel") {
      // The operator sees which checks failed; the instructions go to the foreman only.
      assert.deepEqual(
        store.messages(item.id).map((m) => m.body),
        [`CI failed on ${action.prUrl}: Quality checks`],
      );
      assert.equal(store.pendingEvents(item.id).length, 1);
      assert.match(
        store.pendingEvents(item.id)[0]?.payload ?? "",
        /Checks failed: Quality checks\. Send fixes .* follow_up/,
      );
    }
    if (bucket === "error") {
      assert.equal(store.item(item.id)?.status, "waiting_human");
      assert.equal(store.pendingEvents(item.id).length, 0);
      assert.equal(store.getKv(`ci-wait:${item.id}`), "");
      assert.match(
        store.messages(item.id)[0]?.body ?? "",
        /authentication failed/,
      );
      assert.ok(
        store.messages(item.id)[0]?.body.includes("Checks/Actions read access"),
      );
    }
    if (bucket.startsWith("pending")) {
      // No foreman instructions reach the operator (or Telegram).
      assert.deepEqual(
        store.messages(item.id).map((m) => m.body),
        [`Waiting for CI on ${action.prUrl}`],
      );
      // biome-ignore lint/complexity/useLiteralKeys: Verify pending checks do not trigger the stalled fallback.
      factory["checkStalled"](store.item(item.id) ?? item, applied);
      assert.equal(store.item(item.id)?.status, "active");
      factory.pump = async () => {};
      const poller = new GithubPoller(factory);
      // biome-ignore lint/complexity/useLiteralKeys: Avoid unrelated issue intake.
      await poller["checkPullRequests"]();
      assert.equal(store.pendingEvents(item.id).length, 0);
      await writeFile(result, bucket === "pending_pass" ? "pass" : "fail");
      // biome-ignore lint/complexity/useLiteralKeys: Exercise completion polling.
      await poller["checkPullRequests"]();
      // biome-ignore lint/complexity/useLiteralKeys: Repeated polls must not wake twice.
      await poller["checkPullRequests"]();
      assert.equal(store.pendingEvents(item.id).length, 1);
      assert.match(
        store.pendingEvents(item.id)[0]?.payload ?? "",
        bucket === "pending_pass" ? /Checks passed/ : /Quality checks/,
      );
      assert.equal(
        store.getKv(`ci-failed:${item.id}`),
        bucket === "pending_pass" ? "" : "1",
      );
    }
  });
}

test("a follow-up queued behind a running turn resumes that turn's final session", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-resume-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex");
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"; cat > /dev/null
echo '{"type":"thread.started","thread_id":"s-final"}'
echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
`,
    { mode: 0o755 },
  );
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CODEX_BIN: fake,
      NAKARA_CODEX_HOME: join(dir, "codex-home"),
    }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const def = factory.definition;
  assert.ok(def);
  // No repositories to clone and no container: the fake codex runs on the host.
  def.factory.repositories = [];
  const implement = def.agents.get("implement");
  assert.ok(implement);
  implement.runner = undefined;
  // The fake binary is codex, whatever harness the shipped definition picks.
  implement.harness = { kind: "codex", model: undefined };
  const item = store.createItem({
    title: "Resume",
    request: "Test",
    source: "manual",
  });
  const first = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: "s-start",
    status: "running",
  });
  const followUp = factory.followUp(first.id, "Also add a test");
  assert.ok(followUp.ok);
  assert.equal(followUp.run.session_id, "s-start");
  // Run A ends in a different session than the one the follow-up was queued with.
  store.finishRun(first.id, {
    status: "succeeded",
    result: "Done",
    error: null,
    cost_usd: 0,
    num_turns: null,
    duration_ms: 1,
    session_id: "s-after",
    log_path: null,
  });
  await factory.agentRun(followUp.run);
  const args = (await readFile(join(dir, "args"), "utf8")).trim().split("\n");
  assert.deepEqual(args.slice(0, 2), ["exec", "resume"]);
  assert.equal(args.at(-2), "s-after");
  assert.equal(store.runById(followUp.run.id)?.status, "succeeded");
  assert.equal(store.runById(followUp.run.id)?.session_id, "s-final");
  store.db.close();
});

test("a definition reload emits one status change only when it succeeds, and always a definition change", async (t) => {
  const empty = await mkdtemp(join(tmpdir(), "nakara-empty-definition-"));
  t.after(() => rm(empty, { recursive: true, force: true }));
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const events: unknown[] = [];
  store.changes.on("change", (event) => events.push(event));
  const factory = new Factory(store, loadConfig({}));
  assert.ok((await factory.reloadDefinition()).ok);
  assert.deepEqual(events, [
    { type: "status", id: "global" },
    { type: "definition", id: "global" },
  ]);
  const broken = new Factory(
    store,
    loadConfig({ NAKARA_DEFINITION_DIR: empty }),
  );
  assert.equal((await broken.reloadDefinition()).ok, false);
  assert.deepEqual(events.slice(2), [{ type: "definition", id: "global" }]);
});

test("stopping a running agent run cancels it and wakes the foreman, not the item", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-stop-run-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex");
  await writeFile(
    fake,
    `#!/bin/sh
cat > /dev/null
echo '{"type":"thread.started","thread_id":"s-stop"}'
touch "${dir}/started"
while :; do sleep 0.05; done
`,
    { mode: 0o755 },
  );
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CODEX_BIN: fake,
      NAKARA_CODEX_HOME: join(dir, "codex-home"),
    }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const def = factory.definition;
  assert.ok(def);
  def.factory.repositories = [];
  const implement = def.agents.get("implement");
  assert.ok(implement);
  implement.runner = undefined;
  implement.harness = { kind: "codex", model: undefined };
  // Only the run under test starts; the woken foreman is observed as a pending event.
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Stop",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building" });
  const queued = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: null,
    status: "queued",
  });
  const refused = factory.stopRun(queued.id);
  assert.deepEqual(refused, {
    ok: false,
    code: "policy",
    reason: "Only a running run can be stopped. This run is queued.",
  });
  assert.deepEqual(factory.stopRun(999), {
    ok: false,
    code: "not_found",
    reason: "Run not found.",
  });

  const running = factory.agentRun(queued);
  while (!existsSync(join(dir, "started")))
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(factory.stopRun(queued.id).ok, true);
  await running;
  const run = store.runById(queued.id);
  assert.equal(run?.status, "cancelled");
  assert.equal(run?.error, "Stopped by the operator.");
  assert.equal(run?.session_id, "s-stop");
  const events = store.pendingEvents(item.id);
  assert.deepEqual(
    events.map((e) => [e.kind, JSON.parse(e.payload)]),
    [
      [
        "run_stopped",
        { runId: String(queued.id), agent: "implement", role: "agent" },
      ],
    ],
  );
  assert.match(
    renderEvent(events[0] as ItemEvent, item, def),
    /operator stopped `implement` \(run #\d+\).*not cancelled/,
  );
  assert.deepEqual(
    [store.item(item.id)?.stage, store.item(item.id)?.status],
    ["building", "active"],
  );
  assert.equal(factory.stopRun(queued.id).ok, false);
  const runsTotal = factory.telemetry.metrics.runsTotal;
  const count = (status: string) =>
    runsTotal.get({ agent: "implement", harness: "codex", status });
  assert.deepEqual(
    [count("stopped"), count("cancelled"), count("failed")],
    [1, 0, 0],
  );
});

test("stopping a running run that no process of this Nakara owns ends it at once", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const lines: string[] = [];
  const factory = new Factory(store, loadConfig({}), {
    log: new Logger({ write: (l) => lines.push(l), secrets: [] }),
    metrics: new Metrics(),
  });
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Orphan",
    request: "Test",
    source: "manual",
  });
  const turn = store.createRun({
    item_id: item.id,
    role: "foreman",
    agent: "foreman",
    agent_type: "FOREMAN",
    harness: "claude",
    model: null,
    input: "## New work item",
    session_id: null,
    status: "running",
  });
  assert.equal(factory.stopRun(turn.id).ok, true);
  assert.equal(store.runById(turn.id)?.status, "cancelled");
  assert.deepEqual(
    store.pendingEvents(item.id).map((e) => [e.kind, JSON.parse(e.payload)]),
    [
      [
        "run_stopped",
        { runId: String(turn.id), agent: "foreman", role: "foreman" },
      ],
    ],
  );
  const { runsTotal } = factory.telemetry.metrics;
  const count = (status: string) =>
    runsTotal.get({ agent: "foreman", harness: "claude", status });
  assert.deepEqual([count("stopped"), count("cancelled")], [1, 0]);
  const finished = lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "run.finished");
  assert.deepEqual(
    finished.map((l) => [l.item_id, l.run_id, l.agent, l.status]),
    [[item.id, turn.id, "foreman", "stopped"]],
  );
  store.db.close();
});

test("ask_human keeps the suggested answers on the question", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const item = store.createItem({
    title: "Ask",
    request: "",
    source: "manual",
  });
  await factory["applyActions"](item.id, [
    {
      action: { type: "ask_human", question: "Which?", options: ["A", "B"] },
      accepted: true,
    },
    { action: { type: "ask_human", question: "Why?" }, accepted: true },
  ]);
  assert.deepEqual(
    store.approvals(item.id).map((a) => [a.prompt, a.options]),
    [
      ["Which?", '["A","B"]'],
      ["Why?", null],
    ],
  );
  store.db.close();
});

test("retry resumes the failed run's session and raise budget wakes a budget-stopped item", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 10 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  // Observe the queued run and the pending event instead of starting them.
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Retry",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, {
    stage: "building",
    status: "waiting_human",
    revision_count: 1,
  });
  const failed = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    input: "Build it",
    session_id: null,
    status: "running",
  });
  store.finishRun(failed.id, {
    status: "failed",
    result: null,
    error: "rate limited",
    cost_usd: 0,
    num_turns: null,
    duration_ms: 1,
    session_id: "s-failed",
    log_path: null,
  });
  store.addCost(item.id, 10);

  const broke = factory.retry(item.id);
  assert.equal(broke.ok, false);
  assert.match(broke.ok ? "" : broke.reason, /Raise the budget/);

  const raised = factory.raiseBudget(item.id);
  assert.ok(raised.ok);
  assert.equal(raised.item.budget_usd, 20);
  assert.equal(raised.item.status, "active");
  const events = store.pendingEvents(item.id);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["budget_raised"],
  );
  assert.ok(factory.definition);
  assert.match(
    renderEvent(events[0] as ItemEvent, item, factory.definition),
    /raised the budget to \$20\.00 \(\$10\.00 spent\)/,
  );
  // Not blocked any more: a second raise does not wake the foreman again.
  assert.ok(factory.raiseBudget(item.id).ok);
  assert.equal(store.pendingEvents(item.id).length, 1);

  const retry = factory.retry(item.id);
  assert.ok(retry.ok);
  assert.equal(retry.run.agent, "implement");
  assert.equal(retry.run.session_id, "s-failed");
  assert.match(retry.run.input, /rate limited[\s\S]*Build it/);
  assert.equal(store.item(item.id)?.revision_count, 1);
  assert.equal(factory.retry(item.id).ok, false, "a run is already queued");
  assert.deepEqual(factory.retry(999), {
    ok: false,
    code: "not_found",
    reason: "Work item not found.",
  });
  store.db.close();
});

test("retrying a failed review takes back the review it gave back", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 10 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Retry review",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "reviewing", review_count: 1 });
  const failed = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "review",
    agent_type: "REVIEW",
    harness: "codex",
    model: null,
    input: "Review the PR",
    session_id: null,
    status: "running",
    counts_review: 1,
  });
  store.finishRun(failed.id, {
    status: "failed",
    result: null,
    error: "egress refused chatgpt.com",
    cost_usd: 0,
    num_turns: null,
    duration_ms: 1,
    session_id: "s-review",
    log_path: null,
  });
  assert.equal(store.item(item.id)?.review_count, 0);
  const retry = factory.retry(item.id);
  assert.ok(retry.ok);
  assert.equal(retry.run.counts_review, 1);
  assert.equal(store.item(item.id)?.review_count, 1);
  store.db.close();
});

for (const end of ["failed", "cancelled"] as const)
  for (const recorded of ["while running", "on success"] as const)
    test(`a review ${end === "failed" ? "that fails" : "stopped"} after recording a verdict (${recorded}) keeps its review, and a retry takes no second one`, async () => {
      const store = new Store(":memory:", { defaultBudgetUsd: 10 });
      const factory = new Factory(
        store,
        loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
      );
      assert.ok((await factory.reloadDefinition()).ok);
      factory.pump = async () => {};
      const item = store.createItem({
        title: "Reviewed",
        request: "Test",
        source: "manual",
      });
      store.updateItem(item.id, { stage: "reviewing", review_count: 1 });
      const review = store.createRun({
        item_id: item.id,
        role: "agent",
        agent: "review",
        agent_type: "REVIEW",
        harness: "codex",
        model: null,
        input: "Review the PR",
        session_id: null,
        status: "running",
        counts_review: 1,
      });
      const finish = (
        status: "succeeded" | typeof end,
        review_verdict?: "accepted",
      ) =>
        store.finishRun(review.id, {
          status,
          result: review_verdict ? "Verdict: accepted" : null,
          error: status === "succeeded" ? null : "Stopped by the operator.",
          cost_usd: 0,
          num_turns: null,
          duration_ms: 1,
          session_id: "s-review",
          log_path: null,
          ...(review_verdict && { review_verdict }),
        });
      if (recorded === "on success") finish("succeeded", "accepted");
      else
        store.db
          .prepare("UPDATE runs SET review_verdict = 'accepted' WHERE id = ?")
          .run(review.id);
      finish(end);
      const run = store.runById(review.id);
      assert.equal(run?.status, end);
      assert.equal(run?.review_verdict, "accepted", "the verdict is kept");
      assert.equal(store.item(item.id)?.review_count, 1);
      const retry = factory.retry(item.id);
      // Only a failed run can be retried; either way no second review is taken.
      assert.equal(retry.ok, end === "failed");
      if (retry.ok) assert.equal(retry.run.counts_review, 0);
      assert.equal(store.item(item.id)?.review_count, 1);
      store.db.close();
    });

test("dispatching an agent deleted during the foreman's turn fails its run with a clear error", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const item = store.createItem({
    title: "Dispatch",
    request: "",
    source: "manual",
  });
  // The foreman saw docs before it was deleted.
  await factory["applyActions"](item.id, [
    {
      action: {
        type: "dispatch_agent",
        agent: "docs",
        agentType: "TRIAGE",
        brief: "Write the docs",
      },
      accepted: true,
    },
  ]);
  const [queued] = store.runs(item.id);
  assert.ok(queued);
  assert.equal(queued.agent, "docs");
  assert.equal(queued.status, "queued");
  await factory.agentRun(queued);
  const run = store.runById(queued.id);
  assert.equal(run?.status, "failed");
  assert.equal(
    run?.error,
    'Agent "docs" is no longer in the factory definition.',
  );
  assert.deepEqual(
    store
      .pendingEvents(item.id)
      .map((e) => [e.kind, JSON.parse(e.payload).status]),
    [["agent_report", "failed"]],
  );
  store.db.close();
});

test("after a hard stop, a running run with a session is requeued into it; only a run without one fails", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(store, loadConfig({}));
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Restart",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building" });
  const running = (
    role: "agent" | "foreman",
    agent: string,
    session_id: string | null,
  ) =>
    store.createRun({
      item_id: item.id,
      role,
      agent,
      agent_type: role === "foreman" ? "FOREMAN" : "IMPLEMENT",
      harness: "claude",
      model: "opus",
      input: "Build it",
      session_id,
      status: "running",
    });
  const withSession = running("agent", "implement", "s-1");
  const withoutSession = running("agent", "review", null);
  const turn = running("foreman", "foreman", null);
  // They were started by the instance that stopped hard.
  store.db.exec("UPDATE runs SET instance_id = 'crashed'");

  await factory.start();
  await factory.drain(0);

  const runs = store.runs(item.id);
  assert.deepEqual(
    runs.map((r) => [r.id, r.agent, r.status, r.session_id]),
    [
      [withSession.id, "implement", "interrupted", "s-1"],
      [withoutSession.id, "review", "failed", null],
      [turn.id, "foreman", "interrupted", null],
      [turn.id + 1, "implement", "queued", "s-1"],
    ],
  );
  const resume = runs.at(-1);
  assert.equal(resume?.input, RESUME_INPUT);
  assert.equal(resume?.model, "opus");
  assert.match(
    runs[0]?.error ?? "",
    new RegExp(`Run #${resume?.id} continues it in the same session`),
  );
  // The resume is a continuation, not a follow-up the policy counts.
  assert.equal(store.item(item.id)?.revision_count, 0);
  // Only the run without a session is reported, as a failure.
  assert.deepEqual(
    store
      .pendingEvents(item.id)
      .map((e) => [
        e.kind,
        JSON.parse(e.payload).runId,
        JSON.parse(e.payload).status,
      ]),
    [["agent_report", String(withoutSession.id), "failed"]],
  );
  store.db.close();
});

/**
 * A factory whose implement agent is a fake codex running `script` on the
 * host, and a work item in the building stage with one queued run of it.
 */
async function drainFixture(
  t: { after: (fn: () => unknown) => void },
  script: (dir: string) => string,
) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-drain-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "codex");
  await writeFile(fake, `#!/bin/sh\ncat > /dev/null\n${script(dir)}`, {
    mode: 0o755,
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const lines: string[] = [];
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CODEX_BIN: fake,
      NAKARA_CODEX_HOME: join(dir, "codex-home"),
    }),
    {
      log: new Logger({ write: (l) => lines.push(l), secrets: [] }),
      metrics: new Metrics(),
    },
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const def = factory.definition;
  assert.ok(def);
  def.factory.repositories = [];
  const implement = def.agents.get("implement");
  assert.ok(implement);
  implement.runner = undefined;
  implement.harness = { kind: "codex", model: undefined };
  const item = store.createItem({
    title: "Drain",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building" });
  const queued = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: null,
    status: "queued",
  });
  /** Start the queued run (no events, so no foreman turn) and wait until the fake runs. */
  const start = async () => {
    await factory.pump();
    while (!existsSync(join(dir, "started")))
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(factory.inFlightCount, 1);
  };
  const reports = () =>
    store.pendingEvents(item.id).map((e) => {
      const p = JSON.parse(e.payload);
      return [e.kind, p.runId, p.status, p.error];
    });
  /** The run's count in nakara_runs_total by status, and its run.finished log line. */
  const ended = (status: string) => ({
    count: factory.telemetry.metrics.runsTotal.get({
      agent: "implement",
      harness: "codex",
      status,
    }),
    logged: lines
      .map((l) => JSON.parse(l))
      .find((l) => l.event === "run.finished"),
  });
  return { dir, store, factory, item, queued, start, reports, ended };
}

const LOOP = "while :; do sleep 0.05; done\n";

test("a drain that runs out interrupts the run in flight instead of failing or cancelling it", async (t) => {
  const { store, factory, item, queued, start, reports, ended } =
    await drainFixture(
      t,
      (dir) =>
        `echo '{"type":"thread.started","thread_id":"s-drain"}'\ntouch "${dir}/started"\n${LOOP}`,
    );
  await start();
  await factory.drain(100);
  assert.equal(factory.inFlightCount, 0);

  const [run, resume] = store.runs(item.id);
  assert.equal(run?.id, queued.id);
  assert.equal(run?.status, "interrupted");
  assert.equal(run?.session_id, "s-drain");
  assert.equal(resume?.status, "queued", "drained: nothing new starts");
  assert.equal(resume?.session_id, "s-drain");
  assert.deepEqual(reports(), []);
  const { metrics } = factory.telemetry;
  assert.equal(ended("interrupted").count, 1);
  assert.equal(ended("failed").count, 0);
  assert.equal(metrics.runWait.count({ role: "agent" }), 1);
  assert.equal(
    metrics.runDuration.count({ agent: "implement", harness: "codex" }),
    1,
  );
  assert.deepEqual(
    ["level", "item_id", "run_id", "agent", "status"].map(
      (k) => ended("interrupted").logged?.[k],
    ),
    ["info", item.id, queued.id, "implement", "interrupted"],
  );
});

test("a drain that runs out fails and reports an agent run that never started a session", async (t) => {
  const { store, factory, item, queued, start, reports, ended } =
    await drainFixture(t, (dir) => `touch "${dir}/started"\n${LOOP}`);
  await start();
  await factory.drain(100);
  const runs = store.runs(item.id);
  assert.deepEqual(
    runs.map((r) => [r.id, r.status]),
    [[queued.id, "failed"]],
  );
  const error =
    "Nakara shut down before this run finished. It had not started a session, so there is nothing to continue.";
  assert.equal(runs[0]?.error, error);
  assert.deepEqual(reports(), [
    ["agent_report", String(queued.id), "failed", error],
  ]);
  assert.equal(ended("failed").count, 1);
  assert.equal(ended("interrupted").count, 0);
  assert.equal(ended("failed").logged?.level, "warn");
  assert.equal(ended("failed").logged?.error, error);
});

test("a drain that runs out on a spent budget fails and reports the run instead of resuming it", async (t) => {
  const { store, factory, item, queued, start, reports } = await drainFixture(
    t,
    (dir) =>
      `echo '{"type":"thread.started","thread_id":"s-spent"}'\ntouch "${dir}/started"\n${LOOP}`,
  );
  await start();
  // Other runs spent the budget while this one ran.
  store.updateItem(item.id, { cost_usd: 15 });
  await factory.drain(100);
  const runs = store.runs(item.id);
  assert.deepEqual(
    runs.map((r) => [r.id, r.status]),
    [[queued.id, "failed"]],
    "no resume is queued",
  );
  const error =
    "Nakara shut down before this run finished. The budget is spent ($15.00 of $15.00), so it was not resumed.";
  assert.deepEqual(reports(), [
    ["agent_report", String(queued.id), "failed", error],
  ]);
});

test("a run that finishes as the drain runs out reports its success and is not resumed", async (t) => {
  // The harness stops the run with SIGTERM; this one completes its turn instead.
  const { store, factory, item, queued, start, reports, ended } =
    await drainFixture(
      t,
      (dir) => `echo '{"type":"thread.started","thread_id":"s-done"}'
trap 'echo "{\\"type\\":\\"turn.completed\\",\\"usage\\":{\\"input_tokens\\":1}}"; exit 0' TERM
touch "${dir}/started"
${LOOP}`,
    );
  await start();
  await factory.drain(100);
  assert.deepEqual(
    store.runs(item.id).map((r) => [r.id, r.status]),
    [[queued.id, "succeeded"]],
  );
  assert.deepEqual(
    reports().map((r) => r.slice(0, 3)),
    [["agent_report", String(queued.id), "succeeded"]],
  );
  assert.equal(ended("succeeded").count, 1);
  assert.equal(ended("interrupted").count, 0);
});

test("a queued run does not start on a spent budget, whatever its harness", async (t) => {
  const { dir, store, factory, item, queued, reports } = await drainFixture(
    t,
    (dir) => `touch "${dir}/started"\n`,
  );
  store.updateItem(item.id, { cost_usd: 15.5 });
  await factory.agentRun(queued);
  assert.equal(existsSync(join(dir, "started")), false, "codex never ran");
  assert.equal(store.runById(queued.id)?.status, "failed");
  assert.deepEqual(reports(), [
    [
      "agent_report",
      String(queued.id),
      "failed",
      "The budget is spent ($15.50 of $15.00), so the run did not start. Raise the budget to continue.",
    ],
  ]);
});

test("interrupting a run counts its own cost against the budget before resuming it", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({
    title: "Budget",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building", cost_usd: 14 });
  const running = () =>
    store.createRun({
      item_id: item.id,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "Build it",
      session_id: "s-1",
      status: "running",
    });
  const ended = (cost_usd: number) => ({
    result: null,
    cost_usd,
    num_turns: null,
    duration_ms: 1,
    session_id: null,
  });
  const cheap = store.transaction(() =>
    store.interruptRun(running().id, ended(0.5), "Stopped."),
  );
  assert.equal(cheap.status, "interrupted");
  assert.ok(cheap.resume);
  store.cancelQueuedRuns(item.id);
  // $14.50 spent: this run's $1 takes the item past its $15 budget.
  const dear = store.transaction(() =>
    store.interruptRun(running().id, ended(1), "Stopped."),
  );
  assert.deepEqual(dear, {
    status: "failed",
    error:
      "Stopped. The budget is spent ($15.50 of $15.00), so it was not resumed.",
  });
  assert.equal(store.item(item.id)?.cost_usd, 15.5);
  store.db.close();
});

test("after a hard stop, a run of a closed work item is cancelled, not resumed or reported", async () => {
  for (const stage of ["complete", "cancelled"] as const) {
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    const factory = new Factory(store, loadConfig({}));
    factory.pump = async () => {};
    const item = store.createItem({
      title: "Closed",
      request: "Test",
      source: "manual",
    });
    store.updateItem(item.id, { stage, status: "done" });
    for (const session_id of ["s-1", null])
      store.createRun({
        item_id: item.id,
        role: "agent",
        agent: "implement",
        agent_type: "IMPLEMENT",
        harness: "claude",
        model: null,
        input: "Build it",
        session_id,
        status: "running",
      });
    // They were started by the instance that stopped hard.
    store.db.exec("UPDATE runs SET instance_id = 'crashed'");
    await factory.start();
    await factory.drain(0);
    assert.deepEqual(
      store.runs(item.id).map((r) => r.status),
      ["cancelled", "cancelled"],
      stage,
    );
    assert.deepEqual(store.pendingEvents(item.id), [], stage);
    store.db.close();
  }
});

test("nakara_items_over_budget_total counts each time a run's spend reaches its item's budget", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // A fake claude reporting the cost in `cost`; with a `hang` file it runs
  // until SIGTERM and then reports the cost of the interrupted turn.
  const fake = join(dir, "claude");
  await writeFile(
    fake,
    `#!/bin/sh
cat > /dev/null
cost=$(cat "${dir}/cost")
echo '{"type":"system","subtype":"init","session_id":"s-budget"}'
if [ -e "${dir}/hang" ]; then
  trap 'echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"error_during_execution\\",\\"is_error\\":true,\\"session_id\\":\\"s-budget\\",\\"total_cost_usd\\":$cost}"; exit 1' TERM
  touch "${dir}/started"
  while :; do sleep 0.05; done
fi
echo "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"ok\\",\\"session_id\\":\\"s-budget\\",\\"total_cost_usd\\":$cost}"
`,
    { mode: 0o755 },
  );
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const lines: string[] = [];
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CLAUDE_BIN: fake,
    }),
    {
      log: new Logger({ write: (l) => lines.push(l), secrets: [] }),
      metrics: new Metrics(),
    },
  );
  factory.pump = async () => {};
  assert.ok((await factory.reloadDefinition()).ok);
  const def = factory.definition;
  assert.ok(def);
  def.factory.repositories = [];
  const implement = def.agents.get("implement");
  assert.ok(implement);
  implement.runner = undefined;
  implement.harness = { kind: "claude", model: undefined };
  const item = store.createItem({
    title: "Budget",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building" });
  /** Start a queued run of the fake; it reports the cost written to `cost`. */
  const run = () => {
    const queued = store.createRun({
      item_id: item.id,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "Build it",
      session_id: "s-budget",
      status: "queued",
    });
    return { queued, done: factory.agentRun(queued) };
  };
  const { metrics } = factory.telemetry;
  const overBudget = () => metrics.itemsOverBudget.get();
  const reached = () =>
    lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === "item.budget_reached");

  await writeFile(join(dir, "cost"), "10");
  await run().done;
  assert.equal(store.item(item.id)?.cost_usd, 10);
  assert.equal(overBudget(), 0, "still under the budget");

  await writeFile(join(dir, "cost"), "6");
  const crossing = run();
  await crossing.done;
  assert.equal(store.item(item.id)?.cost_usd, 16);
  assert.equal(overBudget(), 1, "the run took the item to its budget");
  assert.deepEqual(
    reached().map((l) => [l.level, l.item_id, l.run_id, l.agent]),
    [["warn", item.id, crossing.queued.id, "implement"]],
  );
  assert.equal(metrics.costUsd.get({ agent: "implement" }), 16);

  // Already over the budget: the next run does not start or cross it again.
  await run().done;
  assert.equal(overBudget(), 1);

  // A raised budget can be reached again, here by a run cut short by a shutdown.
  const raised = factory.raiseBudget(item.id);
  assert.ok(raised.ok);
  const budget = raised.item.budget_usd;
  assert.ok(budget > 16);
  await writeFile(join(dir, "cost"), String(budget - 16));
  await writeFile(join(dir, "hang"), "");
  const interrupted = run();
  while (!existsSync(join(dir, "started")))
    await new Promise((resolve) => setTimeout(resolve, 20));
  factory.interrupt();
  await interrupted.done;
  assert.equal(store.item(item.id)?.cost_usd, budget);
  assert.equal(overBudget(), 2);
  assert.equal(reached().length, 2);
  assert.equal(reached()[1]?.run_id, interrupted.queued.id);
});

test("a run whose code throws fails and frees its slot instead of ending the process", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const item = store.createItem({
    title: "Crash",
    request: "",
    source: "manual",
  });
  const boom = async () => {
    throw new Error("ENOSPC: no space left on device");
  };
  // biome-ignore lint/complexity/useLiteralKeys: Make the runners throw past their own handling.
  factory["agents"].run = boom;
  // biome-ignore lint/complexity/useLiteralKeys: As above.
  factory["foreman"].run = boom;

  const queued = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    input: "Build it",
    session_id: null,
    status: "queued",
  });
  await factory.agentRun(queued);
  const run = store.runById(queued.id);
  assert.equal(run?.status, "failed");
  assert.match(run?.error ?? "", /^Nakara error: Error: ENOSPC/);

  // The foreman hears of the failure; its crashed turn handles that event once
  // and pauses the item rather than retrying in a loop.
  assert.deepEqual(
    store
      .pendingEvents(item.id)
      .map((e) => [e.kind, JSON.parse(e.payload).status]),
    [["agent_report", "failed"]],
  );
  await factory.foremanTurn(item.id);
  assert.deepEqual(store.pendingEvents(item.id), []);
  assert.equal(store.item(item.id)?.status, "paused");
  assert.match(
    store.messages(item.id).at(-1)?.body ?? "",
    /^The foreman turn crashed: Nakara error: Error: ENOSPC.*Send a message to retry\.$/,
  );
  store.close();
});

test("the foreman may call only the tools each MCP server lists, and each external call is logged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-tools-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The fake claude runs on the host: the bundled runner would sandbox the foreman.
  process.env.NAKARA_ALLOW_HOST_FOREMAN = "1";
  t.after(() => delete process.env.NAKARA_ALLOW_HOST_FOREMAN);
  const fake = join(dir, "claude");
  const use = (id: string, name: string) =>
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id, name, input: {} }] },
    });
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"
cat > /dev/null
echo '${use("t1", "mcp__linear__get_issue")}'
echo '${use("t2", "mcp__nakara__post_update")}'
echo '{"type":"result","subtype":"success","result":"ok","session_id":"s","total_cost_usd":0}'
`,
    { mode: 0o755 },
  );
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const lines: string[] = [];
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CLAUDE_BIN: fake,
    }),
    {
      log: new Logger({ write: (l) => lines.push(l), secrets: [] }),
      metrics: new Metrics(),
    },
  );
  factory.pump = async () => {};
  assert.ok((await factory.reloadDefinition()).ok);
  const def = factory.definition;
  assert.ok(def);
  def.factory.repositories = [];
  def.foreman.mcpServers = {
    linear: { url: "https://mcp.linear.test", tools: ["get_issue"] },
    hosted: { warpId: "w-1" },
  };
  const item = store.createItem({
    title: "Tools",
    request: "",
    source: "manual",
  });
  store.addEvent(item.id, "agent_report", {
    runId: "1",
    agent: "x",
    status: "succeeded",
  });
  await factory.foremanTurn(item.id);
  const args = (await readFile(join(dir, "args"), "utf8")).split("\n");
  const allowed = args.slice(args.indexOf("--allowedTools") + 1);
  assert.ok(allowed.includes("mcp__linear__get_issue"));
  assert.ok(!allowed.includes("mcp__linear"));
  assert.ok(!allowed.some((a) => a.startsWith("mcp__hosted")));
  const calls = lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "tool.called");
  assert.deepEqual(
    calls.map((l) => [l.tool, l.item_id, l.agent]),
    [["mcp__linear__get_issue", item.id, "foreman"]],
  );
  const run = store.runs(item.id).find((r) => r.role === "foreman");
  assert.equal(run?.tools, JSON.stringify({ mcp__linear__get_issue: 1 }));
});

/** A factory on the bundled definition whose foreman has one event waiting. */
async function foremanFixture(
  t: TestContext,
  bin: string,
  dir: string,
): Promise<{ factory: Factory; store: Store; itemId: number }> {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CLAUDE_BIN: bin,
    }),
  );
  factory.pump = async () => {};
  assert.ok((await factory.reloadDefinition()).ok);
  assert.ok(factory.definition);
  factory.definition.factory.repositories = [];
  const item = store.createItem({
    title: "Box",
    request: "",
    source: "manual",
  });
  store.addEvent(item.id, "agent_report", {
    runId: "1",
    agent: "x",
    status: "succeeded",
  });
  return { factory, store, itemId: item.id };
}

test("the foreman runs in the runner's container: clones read-only, only its turn directory writable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-box-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  // Run on the host, this would be a hook an agent planted firing as the operator.
  await writeFile(claude, `#!/bin/sh\ntouch "${dir}/host-ran"\nexit 0\n`, {
    mode: 0o755,
  });
  // A docker that answers the egress probes and records the foreman's own run.
  const bin = join(dir, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
case "$1" in
  version) echo 27.0.0 ;;
  inspect) echo true ;;
  run) case " $* " in
    *" -i "*) printf '%s\\n' "$@" > "${dir}/docker-args"
      cat > /dev/null
      echo '{"type":"result","subtype":"success","result":"ok","session_id":"s","total_cost_usd":0}' ;;
  esac ;;
esac
exit 0
`,
    { mode: 0o755 },
  );
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH}`,
    NAKARA_AGENT_GH_TOKEN: "ghp_test",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth_test",
  });
  t.after(() => {
    for (const k of [
      "PATH",
      "NAKARA_AGENT_GH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
    ])
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
  });
  const { factory, store, itemId } = await foremanFixture(t, claude, dir);
  // An agent planted a hook in the item directory; the foreman starts from there.
  const planted = join(dir, "work", `item-${itemId}`, ".claude");
  await mkdir(planted, { recursive: true });
  await writeFile(
    join(planted, "settings.json"),
    JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: `touch ${dir}/hook-ran` }] },
        ],
      },
    }),
  );
  await factory.foremanTurn(itemId);
  await assert.rejects(readFile(join(dir, "host-ran")));
  await assert.rejects(readFile(join(dir, "hook-ran")));

  const args = (await readFile(join(dir, "docker-args"), "utf8")).split("\n");
  const mounts = args.flatMap((a, i) => (args[i - 1] === "-v" ? [a] : []));
  const root = join(dir, "work", `item-${itemId}`);
  const internal = join(dir, "work", `item-${itemId}.nakara`);
  // The item directory is read-only; its home is the foreman's own.
  assert.ok(mounts.includes(`${root}:${root}:ro`));
  assert.ok(
    mounts.includes(`${internal}/foreman-1.turn:${internal}/foreman-1.turn`),
  );
  assert.ok(
    mounts.includes(`${internal}/foreman-home:${internal}/foreman-home`),
  );
  assert.ok(!mounts.some((m) => m === `${root}:${root}`));
  // No git, and the MCP server starts with the image's own node.
  const from = args.indexOf("--allowedTools") + 1;
  const tools = args.slice(
    from,
    args.findIndex((a, i) => i >= from && a.startsWith("--")),
  );
  assert.ok(tools.includes("Bash(gh pr view:*)"));
  assert.ok(!tools.some((x) => x.startsWith("Bash(git")));
  const config = JSON.parse(
    await readFile(join(internal, "foreman-1.mcp.json"), "utf8"),
  );
  assert.equal(config.mcpServers.nakara.command, "node");
  assert.equal(store.item(itemId)?.status !== "paused", true);
});

test("a foreman without a sandbox pauses the item unless the host run is accepted", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-nobox-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const claude = join(dir, "claude");
  await writeFile(claude, `#!/bin/sh\ntouch "${dir}/ran"\nexit 0\n`, {
    mode: 0o755,
  });
  const { factory, store, itemId } = await foremanFixture(t, claude, dir);
  // The foreman's runner has no image.
  // biome-ignore lint/style/noNonNullAssertion: The fixture loaded a definition.
  factory.definition!.foreman.runner = "local";
  await factory.foremanTurn(itemId);

  assert.equal(store.item(itemId)?.status, "paused");
  assert.match(
    store.messages(itemId).at(-1)?.body ?? "",
    /runs in a sandbox container and none is available.*NAKARA_ALLOW_HOST_FOREMAN=1/,
  );
  assert.deepEqual(store.pendingEvents(itemId), []);
  await assert.rejects(readFile(join(dir, "ran")));
});

for (const harness of ["qwen", "codex"] as const) {
  test(`an item on ${harness}, which bills nothing per token, is stopped by its run limit`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "nakara-runs-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    // Each turn is logged; qwen claims a cost that Nakara does not bill.
    const bin = join(dir, harness);
    const out =
      harness === "qwen"
        ? `{"type":"result","subtype":"success","result":"ok","session_id":"s","total_cost_usd":3}`
        : `{"type":"thread.started","thread_id":"t"}\n{"type":"turn.completed"}`;
    await writeFile(
      bin,
      `#!/bin/sh\ncat > /dev/null\necho turn >> "${dir}/turns"\ncat <<'EOF2'\n${out}\nEOF2\n`,
      { mode: 0o755 },
    );
    const saved = process.env.NAKARA_ALLOW_HOST_FOREMAN;
    process.env.NAKARA_ALLOW_HOST_FOREMAN = "1";
    t.after(() => {
      if (saved === undefined) delete process.env.NAKARA_ALLOW_HOST_FOREMAN;
      else process.env.NAKARA_ALLOW_HOST_FOREMAN = saved;
    });
    const store = new Store(":memory:", {
      defaultBudgetUsd: 15,
      defaultMaxRuns: 2,
    });
    t.after(() => store.db.close());
    const factory = new Factory(
      store,
      loadConfig({
        NAKARA_GITHUB_MIRROR: "false",
        NAKARA_DATA_DIR: dir,
        NAKARA_QWEN_BIN: bin,
        NAKARA_CODEX_BIN: bin,
        NAKARA_CODEX_HOME: join(dir, "codex-home"),
      }),
    );
    factory.pump = async () => {};
    assert.ok((await factory.reloadDefinition()).ok);
    const def = factory.definition;
    assert.ok(def);
    def.factory.repositories = [];
    def.foreman.runner = "local";
    def.foreman.harness = { kind: harness, model: undefined };
    const { id } = store.createItem({
      title: "Loop",
      request: "",
      source: "manual",
    });
    store.addEvent(id, "human_message", { message: "go" });

    // Run 1: the foreman's turn. Run 2: the agent it dispatches.
    await factory.foremanTurn(id);
    await factory["applyActions"](id, [
      {
        action: {
          type: "dispatch_agent",
          agent: "triage",
          agentType: "TRIAGE",
          brief: "b",
        },
        accepted: true,
      },
    ]);
    const agentRun = store.runs(id).find((r) => r.role === "agent");
    assert.ok(agentRun);
    store.finishRun(agentRun.id, {
      status: "succeeded",
      result: "done",
      error: null,
      cost_usd: 0,
      num_turns: null,
      duration_ms: 1,
      session_id: null,
      log_path: null,
    });
    store.addEvent(id, "agent_report", {
      runId: String(agentRun.id),
      agent: "triage",
      status: "succeeded",
    });
    assert.equal(store.item(id)?.run_count, 2);
    // No spend, so the budget would never stop it.
    assert.equal(store.item(id)?.cost_usd, 0);

    // The limit holds: the next turn does not start and the item pauses.
    await factory.foremanTurn(id);
    assert.equal((await readFile(join(dir, "turns"), "utf8")).trim(), "turn");
    const paused = store.item(id);
    assert.equal(paused?.status, "paused");
    assert.equal(paused?.run_count, 2);
    assert.equal(
      store.messages(id).at(-1)?.body,
      "Run limit reached (2 of 2 runs, foreman turns and failed runs included). Press Raise run limit on the work item to continue, or cancel it.",
    );
    assert.deepEqual(store.pendingEvents(id), []);
    // A follow-up recorded anyway is refused, and queues nothing.
    await factory["applyActions"](id, [
      {
        action: {
          type: "follow_up",
          agent: "triage",
          agentType: "TRIAGE",
          message: "again",
        },
        accepted: true,
      },
    ]);
    assert.equal(store.runs(id).length, 2);

    // Raising the limit wakes the foreman.
    const raised = factory.raiseRunLimit(id);
    assert.ok(raised.ok);
    assert.equal(raised.item.max_runs, 12);
    assert.equal(raised.item.status, "active");
    assert.deepEqual(
      store.pendingEvents(id).map((e) => e.kind),
      ["run_limit_raised"],
    );
  });
}
