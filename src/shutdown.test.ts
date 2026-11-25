// SIGTERM against the real process: the drain lets a run finish, and a run
// still going when the drain runs out ends interrupted and resumes after the
// restart, without a failure report to the foreman.
import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { RESUME_INPUT, Store, stubFactorySeed } from "./db.ts";

const MAIN = join(import.meta.dirname, "main.ts");

async function factoryDir(t: { after: (fn: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-shutdown-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files: Record<string, string> = {
    "definition/factory.yaml": `schemaVersion: v1alpha1
name: t
alias: T
repositories: []
agentDefaults: { harness: { type: codex }, runner: local }
`,
    "definition/runners/local.yaml": "platform: { os: linux }\n",
    "definition/agents/foreman/agent.md":
      "---\nagentType: FOREMAN\nharness: { type: claude }\n---\nLead.",
    "definition/agents/implement/agent.md":
      "---\nagentType: IMPLEMENT\n---\nBuild.",
    // Runs until the test creates `release`; records each invocation's arguments.
    codex: `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls"
cat > /dev/null
echo '{"type":"thread.started","thread_id":"s-1"}'
touch "${dir}/started"
while [ ! -e "${dir}/release" ]; do sleep 0.05; done
echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
`,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), content, { mode: 0o755 });
  }
  return dir;
}

/** A work item in the building stage with one queued implement run. */
function seed(dir: string): { itemId: number; runId: number } {
  // The registry loads the first factory from its recorded definition directory.
  const store = new Store(join(dir, "data", "nakara.db"), {
    factory: () => ({
      ...stubFactorySeed(),
      definition_dir: join(dir, "definition"),
    }),
    defaultBudgetUsd: 15,
  });
  const item = store.createItem({
    title: "Shutdown",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building" });
  const run = store.createRun({
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
  store.close();
  return { itemId: item.id, runId: run.id };
}

function nakara(
  dir: string,
  drainSeconds: number,
  stderr: "ignore" | "pipe" = "ignore",
): ChildProcess {
  const child = spawn(process.execPath, [MAIN], {
    env: {
      ...process.env,
      NAKARA_DATA_DIR: join(dir, "data"),
      NAKARA_DEFINITION_DIR: join(dir, "definition"),
      NAKARA_CODEX_BIN: join(dir, "codex"),
      NAKARA_CLAUDE_BIN: join(dir, "no-claude"),
      NAKARA_CODEX_HOME: join(dir, "codex-home"),
      NAKARA_PORT: String(20_000 + Math.floor(Math.random() * 20_000)),
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_TELEGRAM_BOT_TOKEN: "",
      NAKARA_DRAIN_SECONDS: String(drainSeconds),
    },
    stdio: process.env.DEBUG_SHUTDOWN
      ? "inherit"
      : ["ignore", "ignore", stderr],
  });
  return child;
}

const exited = (child: ChildProcess) =>
  new Promise<number | null>((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });

async function until(condition: () => boolean, what: string) {
  const deadline = Date.now() + 20_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

const open = (dir: string) =>
  new Store(join(dir, "data", "nakara.db"), {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });

const reports = (store: Store, itemId: number) =>
  store.events(itemId).map((e) => [e.kind, JSON.parse(e.payload).status]);

test("SIGTERM drains: the run in flight finishes and nothing new starts", async (t) => {
  const dir = await factoryDir(t);
  const { itemId, runId } = seed(dir);
  const child = nakara(dir, 60);
  t.after(() => void child.kill("SIGKILL"));
  await until(() => existsSync(join(dir, "started")), "the run to start");
  child.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(child.exitCode, null, "the drain waits for the run");
  await writeFile(join(dir, "release"), "");
  assert.equal(await exited(child), 0);

  const store = open(dir);
  t.after(() => store.close());
  const runs = store.runs(itemId);
  // The run's report is pending, but no foreman turn started during the drain.
  assert.deepEqual(
    runs.map((r) => [r.id, r.status]),
    [[runId, "succeeded"]],
  );
  assert.deepEqual(reports(store, itemId), [["agent_report", "succeeded"]]);
});

test("SIGTERM past the drain interrupts the run, and the restart resumes it in its session", async (t) => {
  const dir = await factoryDir(t);
  const { itemId, runId } = seed(dir);
  const first = nakara(dir, 0.2);
  t.after(() => void first.kill("SIGKILL"));
  await until(() => existsSync(join(dir, "started")), "the run to start");
  first.kill("SIGTERM");
  assert.equal(await exited(first), 0);

  let store = open(dir);
  const [interrupted, resume] = store.runs(itemId);
  assert.equal(interrupted?.id, runId);
  assert.equal(interrupted?.status, "interrupted");
  assert.equal(interrupted?.session_id, "s-1");
  assert.match(interrupted?.error ?? "", /continues it in the same session/);
  assert.equal(resume?.status, "queued");
  assert.equal(resume?.session_id, "s-1");
  assert.equal(resume?.input, RESUME_INPUT);
  assert.deepEqual(reports(store, itemId), [], "no failure report");
  store.close();

  // The restart: the resumed run continues the session and reports success.
  await writeFile(join(dir, "release"), "");
  const second = nakara(dir, 60);
  t.after(() => void second.kill("SIGKILL"));
  // A running Nakara holds the database: read it without a Store meanwhile.
  const reader = new DatabaseSync(join(dir, "data", "nakara.db"), {
    readOnly: true,
  });
  const status = (id: number) =>
    (
      reader.prepare("SELECT status FROM runs WHERE id = ?").get(id) as
        | { status: string }
        | undefined
    )?.status;
  await until(
    () => status(resume?.id ?? 0) === "succeeded",
    "the resumed run to finish",
  );
  reader.close();
  second.kill("SIGTERM");
  assert.equal(await exited(second), 0);
  store = open(dir);
  t.after(() => store.close());
  const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");
  assert.equal(calls.length, 2);
  assert.match(calls[1] ?? "", /^exec resume .*s-1/);
  assert.deepEqual(
    store
      .runs(itemId)
      .filter((r) => r.role === "agent")
      .map((r) => r.status),
    ["interrupted", "succeeded"],
  );
  // The foreman may already have taken the report; it never heard of a failure.
  assert.deepEqual(reports(store, itemId), [["agent_report", "succeeded"]]);
});

test("a second Nakara on the same data dir refuses to start and leaves the first's run alone", async (t) => {
  const dir = await factoryDir(t);
  const { itemId, runId } = seed(dir);
  const first = nakara(dir, 60);
  t.after(() => void first.kill("SIGKILL"));
  await until(() => existsSync(join(dir, "started")), "the run to start");

  const second = nakara(dir, 60, "pipe");
  t.after(() => void second.kill("SIGKILL"));
  let stderr = "";
  second.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  assert.equal(await exited(second), 1);
  assert.match(
    stderr,
    new RegExp(`Another Nakara \\(PID ${first.pid} on this host`),
  );

  // The first instance's run is untouched and finishes normally. Drain first,
  // as in the drain test, so no foreman turn starts on the run's report.
  first.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(first.exitCode, null, "the drain waits for the run");
  await writeFile(join(dir, "release"), "");
  assert.equal(await exited(first), 0);
  const store = open(dir);
  t.after(() => store.close());
  assert.deepEqual(
    store.runs(itemId).map((r) => [r.id, r.status]),
    [[runId, "succeeded"]],
  );
  const calls = (await readFile(join(dir, "calls"), "utf8")).trim().split("\n");
  assert.equal(calls.length, 1, "the run was dispatched once");
});
