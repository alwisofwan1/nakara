import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig } from "../config.ts";
import { type ScheduledRun, Store } from "../db.ts";
import { HARNESS_DEFAULT, loadDefinition } from "../definition/load.ts";
import type { runTurn, TurnOutcome } from "../harness/claude.ts";
import type { RateLimit } from "../harness/limits.ts";
import { quietTelemetry } from "../telemetry/metrics.ts";
import { itemView, LIMIT_WAITING } from "../web/items.ts";
import { AgentRunner } from "./agent-runner.ts";
import { Factory } from "./factory.ts";
import {
  fallbackOf,
  LIMIT_WAIT_MS,
  limitWait,
  resumeDue,
  waitForReset,
} from "./limit-wait.ts";
import { RunControl } from "./run-support.ts";
import { Scheduler } from "./scheduler.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" });

/** The bundled definition on one local repository, its implement agent on the host. */
async function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-limits-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({
    NAKARA_DATA_DIR: dir,
    NAKARA_GITHUB_MIRROR: "false",
  });
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "README.md"), "# widgets\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  const bare = join(config.repoCacheDir, "acme", "widgets.git");
  git(dir, "clone", "--bare", "--quiet", seed, bare);
  git(
    bare,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  );

  const loaded = await loadDefinition("factory", HARNESS_DEFAULT);
  assert.ok(loaded.ok);
  const def = loaded.definition;
  def.factory.repositories = [{ owner: "acme", name: "widgets" }];
  def.factory.agentDefaults.runner = undefined;
  const agent = def.agents.get("implement");
  assert.ok(agent);
  agent.runner = undefined;
  agent.harness = { kind: "claude", model: undefined };
  agent.fallback = [];

  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const item = store.createItem({
    title: "Limits",
    request: "Test",
    source: "manual",
  });
  const queue = (session: string | null = null) =>
    store.createRun({
      item_id: item.id,
      role: "agent",
      agent: agent.name,
      agent_type: agent.type,
      harness: agent.harness.kind,
      model: null,
      input: "Build it",
      session_id: session,
      status: "queued",
    });
  /** Runs one run on the fake harness; records the harness each turn used. */
  const used: string[] = [];
  const run = (scheduled: ScheduledRun, turn: typeof runTurn) =>
    new AgentRunner(
      store,
      config,
      new RunControl(),
      () => def,
      undefined,
      (req, bins) => {
        used.push(
          req.resumeSession
            ? `${req.harness}:${req.resumeSession}`
            : req.harness,
        );
        return turn(req, bins);
      },
    ).run(scheduled);
  const queuedRuns = () =>
    store.runs(item.id).filter((r) => r.status === "queued");
  const reports = () =>
    store.events(item.id).filter((e) => e.kind === "agent_report");
  return { store, item, agent, queue, run, used, queuedRuns, reports };
}

const succeeded: TurnOutcome = {
  ok: true,
  sessionId: "s-ok",
  result: "Done",
  error: null,
  costUsd: 0.5,
  numTurns: 1,
  durationMs: 1,
};

const limited = (
  harness: string,
  resetAt: string | null = null,
  worked = false,
): TurnOutcome => {
  const limit: RateLimit = {
    resetAt,
    message: `${harness}: You've hit your usage limit.`,
    worked,
  };
  return {
    ok: false,
    sessionId: `s-${harness}`,
    result: null,
    error: `${harness} hit a rate or usage limit: ${limit.message}`,
    limit,
    costUsd: 0,
    numTurns: null,
    durationMs: 1,
  };
};

test("a fresh dispatch limited on claude reruns on codex; both runs are recorded and counted", async (t) => {
  const f = await fixture(t);
  f.agent.fallback = [{ kind: "codex", model: undefined }];
  const first = f.queue();
  await f.run(first, async (req) =>
    req.harness === "claude" ? limited("claude") : succeeded,
  );
  const [moved] = f.queuedRuns();
  assert.ok(moved);
  assert.deepEqual(
    [moved.harness, moved.session_id, moved.input],
    ["codex", null, "Build it"],
  );
  assert.deepEqual(fallbackOf(f.store, moved.id), {
    runId: first.id,
    harness: "claude",
    reason: "claude: You've hit your usage limit.",
    resetAt: null,
  });
  // The foreman hears nothing of the limit: the brief goes on.
  assert.equal(f.reports().length, 0);
  assert.equal(f.store.item(f.item.id)?.status, "active");

  await f.run(moved, async (req) =>
    req.harness === "claude" ? limited("claude") : succeeded,
  );
  assert.deepEqual(f.used, ["claude", "codex"]);
  const runs = f.store.runs(f.item.id);
  assert.deepEqual(
    runs.map((r) => [r.harness, r.status]),
    [
      ["claude", "failed"],
      ["codex", "succeeded"],
    ],
  );
  assert.match(runs[0]?.error ?? "", /Run #\d+ retries the brief on codex\.$/);
  const item = f.store.item(f.item.id);
  assert.equal(item?.run_count, 2);
  assert.equal(item?.cost_usd, 0.5);
  assert.deepEqual(
    f.reports().map((e) => JSON.parse(e.payload).status),
    ["succeeded"],
  );
  assert.ok(
    f.store
      .messages(f.item.id)
      .some((m) =>
        /retries the brief on the fallback harness codex/.test(m.body),
      ),
  );
});

test("a follow-up that hits a limit stays on its harness and pauses the item", async (t) => {
  const f = await fixture(t);
  f.agent.fallback = [{ kind: "codex", model: undefined }];
  const before = f.queue();
  f.store.finishRun(before.id, {
    status: "succeeded",
    result: "Done",
    error: null,
    cost_usd: 0,
    num_turns: 1,
    duration_ms: 1,
    session_id: "s-1",
    log_path: null,
  });
  const followUp = f.queue("s-1");
  await f.run(followUp, async () => limited("claude"));
  assert.deepEqual(f.used, ["claude:s-1"]);
  assert.equal(f.queuedRuns().length, 0);
  assert.equal(f.store.item(f.item.id)?.status, "paused");
  assert.equal(f.reports().length, 0);
  const wait = limitWait(f.store, f.item.id);
  assert.equal(wait?.runs[0]?.harness, "claude");
  assert.equal(wait?.runs[0]?.session, "s-claude");
  assert.match(
    wait?.runs[0]?.input ?? "",
    /^Your previous run stopped at a rate or usage limit\./,
  );
});

test("with every harness limited the item pauses with the reset time and resumes on its own after it", async (t) => {
  const f = await fixture(t);
  f.agent.fallback = [{ kind: "codex", model: undefined }];
  const soon = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const sooner = new Date(Date.now() + 3_600_000).toISOString();
  const turn = async (req: { harness: string }) =>
    req.harness === "claude"
      ? limited("claude", soon)
      : limited("codex", sooner);
  await f.run(f.queue(), turn);
  const [moved] = f.queuedRuns();
  assert.ok(moved);
  await f.run(moved, turn);

  const item = f.store.item(f.item.id);
  assert.equal(item?.status, "paused");
  assert.equal(item?.run_count, 2);
  const wait = limitWait(f.store, f.item.id);
  // It resumes once the first of its harnesses resets.
  assert.equal(wait?.until, sooner);
  const notice = f.store.messages(f.item.id).at(-1)?.body ?? "";
  assert.match(
    notice,
    /implement \(run #\d+\) hit the codex rate or usage limit/,
  );
  assert.match(notice, /run #\d+ hit the claude limit/);
  assert.ok(notice.includes(`at ${sooner}`));

  const log = quietTelemetry().log;
  resumeDue(f.store, log, Date.parse(sooner) - 1000);
  assert.equal(f.store.item(f.item.id)?.status, "paused");
  resumeDue(f.store, log, Date.parse(sooner) + 1000);
  assert.equal(f.store.item(f.item.id)?.status, "active");
  assert.equal(limitWait(f.store, f.item.id), undefined);
  // The brief starts again from the agent's own harness.
  const [again] = f.queuedRuns();
  assert.deepEqual(
    [again?.harness, again?.session_id, again?.input],
    ["claude", null, "Build it"],
  );
  assert.equal(f.store.item(f.item.id)?.run_count, 3);
  assert.equal(f.reports().length, 0);
});

test("without fallback a limit pauses the item for the fixed wait instead of failing it", async (t) => {
  const f = await fixture(t);
  const started = Date.now();
  await f.run(f.queue(), async () => limited("claude"));
  assert.equal(f.store.item(f.item.id)?.status, "paused");
  assert.equal(f.reports().length, 0);
  const until = Date.parse(limitWait(f.store, f.item.id)?.until ?? "");
  assert.ok(
    until >= started + LIMIT_WAIT_MS && until <= Date.now() + LIMIT_WAIT_MS,
  );
  assert.match(
    f.store.messages(f.item.id).at(-1)?.body ?? "",
    /claude did not say when the limit resets, so Nakara resumes the work item after 60 minutes/,
  );
  // biome-ignore lint/style/noNonNullAssertion: The item exists.
  const view = itemView(f.store.item(f.item.id)!, f.store.runs(f.item.id), []);
  assert.equal(view.needsYou.label, LIMIT_WAITING);
});

test("an ordinary failure is reported to the foreman as before", async (t) => {
  const f = await fixture(t);
  f.agent.fallback = [{ kind: "codex", model: undefined }];
  await f.run(f.queue(), async () => ({
    ...succeeded,
    ok: false,
    error: "Run ended with error_max_turns.",
  }));
  assert.equal(f.queuedRuns().length, 0);
  assert.equal(limitWait(f.store, f.item.id), undefined);
  assert.deepEqual(
    f.reports().map((e) => JSON.parse(e.payload).status),
    ["failed"],
  );
});

test("the scheduler holds a waiting item's runs and events; a message resumes it now", async (t) => {
  const f = await fixture(t);
  await f.run(f.queue(), async () => limited("claude"));
  // Work that arrived while it waits.
  f.queue();
  f.store.addEvent(f.item.id, "checks_updated", { prUrl: "x", message: "y" });
  const started: string[] = [];
  const scheduler = new Scheduler(
    f.store,
    loadConfig({ NAKARA_DATA_DIR: tmpdir() }),
    new RunControl(),
    {
      ready: () => true,
      pump: async () => {},
      foremanTurn: async (id) => {
        started.push(`foreman ${id}`);
      },
      agentRun: async (run) => {
        started.push(`run ${run.id}`);
      },
    },
  );
  await scheduler.pump();
  assert.equal(started.length, 0);

  const factory = new Factory(
    f.store,
    loadConfig({ NAKARA_DATA_DIR: tmpdir() }),
  );
  factory.pump = async () => {};
  factory.sendMessage(f.item.id, "Go on");
  assert.equal(limitWait(f.store, f.item.id), undefined);
  assert.equal(f.store.item(f.item.id)?.status, "active");
  await scheduler.pump();
  assert.equal(started.filter((s) => s.startsWith("run ")).length, 2);
  assert.ok(started.includes(`foreman ${f.item.id}`));
});

const FIXTURES = fileURLToPath(
  new URL("../harness/fixtures/", import.meta.url),
);

test("a foreman turn refused by a limit keeps its events and waits for the reset", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nakara-foreman-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  process.env.NAKARA_ALLOW_HOST_FOREMAN = "1";
  t.after(() => delete process.env.NAKARA_ALLOW_HOST_FOREMAN);
  const fake = join(dir, "claude");
  writeFileSync(
    fake,
    `#!/bin/sh\ncat > /dev/null\ncat '${join(FIXTURES, "claude-usage-limit.jsonl")}'\n`,
    { mode: 0o755 },
  );
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_DATA_DIR: dir,
      NAKARA_CLAUDE_BIN: fake,
    }),
  );
  factory.pump = async () => {};
  assert.ok((await factory.reloadDefinition()).ok);
  const def = factory.definition;
  assert.ok(def);
  def.factory.repositories = [];
  const item = store.createItem({ title: "F", request: "", source: "manual" });
  store.addEvent(item.id, "work_received", {});
  await factory.foremanTurn(item.id);

  assert.equal(store.pendingEvents(item.id).length, 1);
  assert.equal(store.item(item.id)?.status, "paused");
  const wait = limitWait(store, item.id);
  assert.equal(wait?.foreman, true);
  assert.equal(wait?.until, "2026-11-28T14:00:00.000Z");
  assert.match(
    store.messages(item.id).at(-1)?.body ?? "",
    /^The foreman \(run #\d+\) hit the claude rate or usage limit: You've hit your session limit/,
  );
  resumeDue(store, quietTelemetry().log, Date.parse("2026-11-28T14:01:00Z"));
  assert.equal(store.item(item.id)?.status, "active");
  assert.equal(store.pendingEvents(item.id).length, 1);
});

test("a counted review that moves to a fallback harness keeps using one review", async (t) => {
  const f = await fixture(t);
  f.agent.fallback = [{ kind: "codex", model: undefined }];
  f.store.updateItem(f.item.id, { review_count: 1 });
  const review = f.store.createRun({
    item_id: f.item.id,
    role: "agent",
    agent: f.agent.name,
    agent_type: f.agent.type,
    harness: "claude",
    model: null,
    session_id: null,
    status: "queued",
    input: "Review it",
    counts_review: 1,
  });
  await f.run(review, async () => limited("claude"));
  const [moved] = f.queuedRuns();
  assert.equal(moved?.counts_review, 1);
  assert.equal(f.store.item(f.item.id)?.review_count, 1);
});

test("a fallback chain with one known and one unknown reset waits for the known one", async (t) => {
  const f = await fixture(t);
  f.agent.fallback = [{ kind: "codex", model: undefined }];
  const reset = new Date(Date.now() + 2 * 3_600_000).toISOString();
  const turn = async (req: { harness: string }) =>
    req.harness === "claude" ? limited("claude", reset) : limited("codex");
  await f.run(f.queue(), turn);
  const [moved] = f.queuedRuns();
  assert.ok(moved);
  await f.run(moved, turn);
  const wait = limitWait(f.store, f.item.id);
  assert.deepEqual([wait?.until, wait?.known], [reset, true]);
  assert.match(
    f.store.messages(f.item.id).at(-1)?.body ?? "",
    new RegExp(
      `Nakara resumes the work item when the limit resets, at ${reset}`,
    ),
  );
});

test("a second limit on a waiting item keeps the earliest known reset, and a known reset beats the fixed wait", async (t) => {
  const f = await fixture(t);
  const log = quietTelemetry().log;
  const now = Date.now();
  const at = (hours: number) => new Date(now + hours * 3_600_000).toISOString();
  // biome-ignore lint/style/noNonNullAssertion: The item exists.
  const item = () => f.store.item(f.item.id)!;
  const hit = (resetAt: string | null) => ({
    who: "implement (run #1)",
    harness: "claude",
    limit: { resetAt, message: "limited", worked: false },
  });
  const wait = () => {
    const w = limitWait(f.store, f.item.id);
    return [w?.until, w?.known];
  };
  waitForReset(f.store, log, item(), hit(at(3)), now);
  waitForReset(f.store, log, item(), hit(at(2)), now);
  assert.deepEqual(wait(), [at(2), true]);
  // A later known reset, or an unknown one, does not move it.
  waitForReset(f.store, log, item(), hit(at(5)), now);
  waitForReset(f.store, log, item(), hit(null), now);
  assert.deepEqual(wait(), [at(2), true]);

  // With only unknown resets, the fixed wait; a known reset then replaces it, even a later one.
  f.store.repos.kv.deleteKv(`limit-wait:${f.item.id}`);
  waitForReset(f.store, log, item(), hit(null), now);
  assert.deepEqual(wait(), [
    new Date(now + LIMIT_WAIT_MS).toISOString(),
    false,
  ]);
  waitForReset(f.store, log, item(), hit(at(4)), now);
  assert.deepEqual(wait(), [at(4), true]);
});

test("two limits on an item already waiting tell the operator once", async (t) => {
  const f = await fixture(t);
  const told: number[] = [];
  f.store.attention.on("needsYou", (e) => told.push(e.itemId));
  // Three agents' runs, limited one after another.
  const runs = [f.queue(), f.queue(), f.queue()];
  for (const run of runs) await f.run(run, async () => limited("claude"));
  assert.deepEqual(told, [f.item.id]);
  const wait = limitWait(f.store, f.item.id);
  assert.deepEqual(
    wait?.runs.map((r) => r.limitedRun),
    runs.map((r) => r.id),
  );
  assert.equal(f.store.item(f.item.id)?.status, "paused");
});
