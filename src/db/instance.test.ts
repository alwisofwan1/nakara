import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store, stubFactorySeed } from "../db.ts";
import { DatabaseLocked } from "./instance.ts";

const DB = join(import.meta.dirname, "..", "db.ts");

function tempDb(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(join(tmpdir(), "nakara-instance-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "nakara.db");
}

const open = (path: string) =>
  new Store(path, { factory: stubFactorySeed, defaultBudgetUsd: 15 });

/** A node process running `script` (an ES module), once it prints "ready". */
async function child(
  t: { after: (fn: () => void) => void },
  script: string,
  flags: string[] = [],
) {
  const proc = spawn(
    process.execPath,
    [...flags, "--input-type=module", "-e", script],
    { stdio: ["ignore", "pipe", "inherit"] },
  ) as unknown as ChildProcessWithoutNullStreams;
  t.after(() => void proc.kill("SIGKILL"));
  await new Promise<void>((resolve, reject) => {
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes("ready")) resolve();
    });
    proc.once("exit", (code) => reject(new Error(`child exited ${code}`)));
  });
  return proc;
}

function agentRun(store: Store, itemId: number) {
  return store.createRun({
    item_id: itemId,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: "s-1",
    status: "queued",
  });
}

test("a second Store on the same database fails fast, naming the holder", (t) => {
  const path = tempDb(t);
  const first = open(path);
  const started = Date.now();
  assert.throws(
    () => open(path),
    (error) =>
      error instanceof DatabaseLocked &&
      error.message.includes(`PID ${process.pid} on this host`) &&
      error.message.includes("nakara.lock"),
  );
  assert.ok(Date.now() - started < 1000, "no wait for the lock");
  // The refused Store changed nothing; closing the first releases the lock.
  assert.equal(first.getKv("instance"), JSON.stringify(first.instance));
  first.close();
  const next = open(path);
  assert.notEqual(next.instance.id, first.instance.id);
  next.close();
});

test("a Nakara killed with SIGKILL leaves no lock behind, and its runs are recovered", async (t) => {
  const path = tempDb(t);
  const seeded = open(path);
  const item = seeded.createItem({
    title: "Crash",
    request: "R",
    source: "manual",
  });
  seeded.updateItem(item.id, { stage: "building" });
  const run = agentRun(seeded, item.id);
  seeded.close();

  // Another process opens the database and starts the run, then hangs.
  const crashing = await child(
    t,
    `import { Store, stubFactorySeed } from ${JSON.stringify(DB)};
     const store = new Store(${JSON.stringify(path)}, { factory: stubFactorySeed, defaultBudgetUsd: 15 });
     store.markRunStarted(${run.id}, "log");
     console.log("ready");
     setInterval(() => {}, 1000);`,
  );
  assert.throws(
    () => open(path),
    new RegExp(`PID ${crashing.pid} on this host`),
  );

  crashing.kill("SIGKILL");
  await new Promise((resolve) => crashing.once("exit", resolve));
  const store = open(path);
  t.after(() => store.close());
  const [orphan] = store.recoverOrphanedRuns();
  assert.equal(orphan?.id, run.id);
  assert.equal(orphan?.status, "interrupted");
  assert.equal(store.runById(run.id)?.status, "interrupted");
});

test("orphan recovery never changes a run of the live instance", (t) => {
  const store = open(tempDb(t));
  t.after(() => store.close());
  const item = store.createItem({
    title: "Live",
    request: "R",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "building" });
  const live = agentRun(store, item.id);
  store.markRunStarted(live.id, "log");
  const turn = store.createRun({
    item_id: item.id,
    role: "foreman",
    agent: "foreman",
    agent_type: "FOREMAN",
    harness: "claude",
    model: null,
    input: "Turn",
    session_id: null,
    status: "running",
  });
  // Runs of earlier instances, and one from before instance ids existed.
  const dead = agentRun(store, item.id);
  const legacy = agentRun(store, item.id);
  store.db
    .prepare("UPDATE runs SET status = 'running', instance_id = ? WHERE id = ?")
    .run("dead-instance", dead.id);
  store.db
    .prepare("UPDATE runs SET status = 'running' WHERE id = ?")
    .run(legacy.id);

  assert.equal(store.runById(live.id)?.instance_id, store.instance.id);
  assert.equal(store.runById(turn.id)?.instance_id, store.instance.id);
  assert.deepEqual(
    store.recoverOrphanedRuns().map((r) => [r.id, r.status]),
    [
      [dead.id, "interrupted"],
      [legacy.id, "interrupted"],
    ],
  );
  const after = store.runById(live.id);
  assert.equal(after?.status, "running");
  assert.equal(after?.ended_at, null);
  assert.equal(after?.error, null);
  assert.equal(store.runById(turn.id)?.status, "running");
});

test("the lock outlives a Store that is garbage collected", async (t) => {
  const path = tempDb(t);
  // The Store is unreachable at once; only close() may release its lock.
  const holder = await child(
    t,
    `import { Store, stubFactorySeed } from ${JSON.stringify(DB)};
     new Store(${JSON.stringify(path)}, { factory: stubFactorySeed, defaultBudgetUsd: 15 });
     gc();
     await new Promise((resolve) => setImmediate(resolve));
     gc();
     console.log("ready");
     setInterval(() => {}, 1000);`,
    ["--expose-gc"],
  );
  assert.throws(
    () => open(path),
    (error) =>
      error instanceof DatabaseLocked &&
      error.message.includes(`PID ${holder.pid} on this host`),
  );
});

test("a refused start does not name a recorded holder that is gone", async (t) => {
  const path = tempDb(t);
  const store = open(path);
  t.after(() => store.close());
  // The record still names a previous, dead holder, as it does while the
  // current holder migrates the database.
  const gone = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => gone.once("exit", resolve));
  store.setKv("instance", JSON.stringify({ ...store.instance, pid: gone.pid }));
  assert.throws(
    () => open(path),
    (error) =>
      error instanceof DatabaseLocked &&
      error.message.includes(
        `Another Nakara (another process; the last recorded holder, PID ${gone.pid} `,
      ) &&
      error.message.includes("is no longer running") &&
      !error.message.includes(`PID ${gone.pid} on this host`),
  );
});
