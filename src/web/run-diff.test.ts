import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import type { HttpBindings } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { internalDir, repoPaths } from "../runner/workspace.ts";
import {
  endSnapshots,
  recordDiff,
  startSnapshots,
} from "../runner/snapshot.ts";
import {
  LIVE_DIFF_TTL_MS,
  LiveDiffs,
  type RepoDiffDto,
  readRunDiff,
} from "./run-diff.ts";
import { createApp } from "./test-support.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** An item's workspace as prepareWorkspace lays it out: a cache per repository and a clone of each sharing its objects. */
function workspace(t: TestContext, itemId: number, names: string[]) {
  const root = mkdtempSync(join(tmpdir(), "nakara-run-diff-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dirs = {
    workDir: join(root, "work"),
    repoCacheDir: join(root, "repos"),
  };
  const repos = names.map((name) => {
    const seed = join(root, "seed", name);
    mkdirSync(seed, { recursive: true });
    git(seed, "init", "--quiet", "--initial-branch=main");
    writeFileSync(join(seed, "README.md"), `# ${name}\n`);
    git(seed, "add", ".");
    git(
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "init",
    );
    const paths = repoPaths(dirs, itemId, "acme", name);
    git(root, "clone", "--bare", "--quiet", seed, paths.bare);
    git(root, "clone", "--quiet", "--shared", paths.bare, paths.path);
    return { slug: `acme/${name}`, ...paths };
  });
  return { root, dirs, repos };
}

/** Where a run of the item logs, beside its workspace; the diff file sits next to it. */
function internalLog(workDir: string, itemId: number) {
  const logs = join(internalDir(workDir, itemId), "logs");
  mkdirSync(logs, { recursive: true });
  return join(logs, "run-1.jsonl");
}

function fixture() {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const item = store.createItem({
    title: "Diff",
    request: "Diff it",
    source: "manual",
  });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: null,
    status: "running",
  });
  const finish = (logPath: string | null) =>
    store.finishRun(run.id, {
      status: "succeeded",
      result: "Done",
      error: null,
      cost_usd: 0,
      num_turns: null,
      duration_ms: 1,
      session_id: null,
      log_path: logPath,
    });
  // biome-ignore lint/style/noNonNullAssertion: Created above.
  const read = () => store.runById(run.id)!;
  return { store, item, run, finish, read };
}

test("a run's diff shows a shell edit, one section per repository", async (t) => {
  const { store, item, run, finish, read } = fixture();
  const { dirs, repos } = workspace(t, item.id, ["widgets", "gadgets"]);
  const [widgets] = repos;
  assert.ok(widgets);
  store.setRunSnapshots(run.id, await startSnapshots(repos));

  // While the run is live, its diff is the clone as it is now.
  execFileSync("bash", ["-c", "sed -i 's/widgets/Widgets v2/' README.md"], {
    cwd: widgets.path,
  });
  const live = await readRunDiff(read(), dirs);
  assert.ok(live.source === "git");
  assert.equal(live.live, true);

  // At its end, the run's diff is written next to its log.
  const ended = await endSnapshots(repos, JSON.parse(read().snapshots ?? "[]"));
  store.setRunSnapshots(run.id, ended);
  const logPath = internalLog(dirs.workDir, read().item_id);
  await recordDiff(logPath, ended, repos);
  finish(logPath);
  // Later runs, and removing the clones and caches, do not change it.
  rmSync(join(dirs.workDir, `item-${read().item_id}`), {
    recursive: true,
    force: true,
  });
  rmSync(dirs.repoCacheDir, { recursive: true, force: true });
  const dto = await readRunDiff(read(), dirs);
  assert.ok(dto.source === "git");
  assert.equal(dto.live, false);
  assert.deepEqual(
    dto.repos.map((r) => [r.slug, r.stat, r.truncated, r.error]),
    [
      [
        "acme/widgets",
        "1 file changed, 1 insertion(+), 1 deletion(-)",
        false,
        null,
      ],
      ["acme/gadgets", "", false, null],
    ],
  );
  assert.match(dto.repos[0]?.diff ?? "", /^-# widgets\n\+# Widgets v2$/m);
  assert.equal(dto.repos[1]?.diff, "");
  assert.deepEqual(live.repos, dto.repos);
});

test("runs without a recorded diff fall back to the log", async (t) => {
  const { store, item, run, finish, read } = fixture();
  const { root, dirs, repos } = workspace(t, item.id, ["widgets"]);
  // Before snapshots, and for foreman turns.
  assert.deepEqual(await readRunDiff(read(), dirs), { source: "log" });
  // Cut short before its diff was written: a later run may have moved the clone.
  store.setRunSnapshots(run.id, await startSnapshots(repos));
  finish(join(root, "run-1.jsonl"));
  assert.deepEqual(await readRunDiff(read(), dirs), { source: "log" });
  finish(null);
  assert.deepEqual(await readRunDiff(read(), dirs), { source: "log" });
});

test("a large diff is recorded truncated, and an unreadable repository reports why", async (t) => {
  const { store, item, run, finish, read } = fixture();
  const { dirs, repos } = workspace(t, item.id, ["widgets"]);
  const [widgets] = repos;
  assert.ok(widgets);
  const started = await startSnapshots(repos);
  store.setRunSnapshots(run.id, started);
  writeFileSync(join(widgets.path, "big.txt"), "generated line\n".repeat(1000));

  // A live run whose cache is gone.
  const bare = `${widgets.bare}.moved`;
  renameSync(widgets.bare, bare);
  const gone = await readRunDiff(read(), dirs);
  assert.ok(gone.source === "git");
  assert.match(gone.repos[0]?.error ?? "", /^Could not read the diff/);
  renameSync(bare, widgets.bare);

  const ended = await endSnapshots(repos, started);
  const logPath = internalLog(dirs.workDir, read().item_id);
  await recordDiff(logPath, ended, repos, 2048);
  finish(logPath);
  const dto = await readRunDiff(read(), dirs);
  assert.ok(dto.source === "git");
  const [repo] = dto.repos;
  assert.equal(repo?.truncated, true);
  assert.equal(repo?.limitBytes, 2048);
  assert.ok((repo?.diff.length ?? 0) <= 2048);
  assert.equal(repo?.stat, "1 file changed, 1000 insertions(+)");
});

test("live diffs are shared by concurrent requests and reused for 10 seconds", async () => {
  let now = 1_000;
  const live = new LiveDiffs(LIVE_DIFF_TTL_MS, () => now);
  let computed = 0;
  let release = () => {};
  const compute = () => {
    computed++;
    return new Promise<RepoDiffDto[]>((resolve) => {
      release = () => resolve([]);
    });
  };
  const first = live.get(1, compute);
  const second = live.get(1, compute);
  assert.equal(computed, 1, "concurrent requests share one computation");
  now += 60_000; // A slow computation is not expired while it runs.
  assert.equal(live.get(1, compute), first);
  release();
  assert.equal(await first, await second);
  // Kept for 10 s after it completed, per run.
  now += LIVE_DIFF_TTL_MS - 1;
  await live.get(1, compute);
  assert.equal(computed, 1);
  void live.get(2, compute);
  assert.equal(computed, 2, "another run computes its own");
  release();
  now += 1;
  void live.get(1, compute);
  assert.equal(computed, 3, "expired");
  release();

  // A failure is not kept.
  const failing = new LiveDiffs(LIVE_DIFF_TTL_MS, () => now);
  await assert.rejects(failing.get(1, () => Promise.reject(new Error("x"))));
  assert.deepEqual(await failing.get(1, async () => []), []);
});

test("a live run's diff comes from the cache until it expires", async (t) => {
  const { store, item, run, read } = fixture();
  const { dirs, repos } = workspace(t, item.id, ["widgets"]);
  const [widgets] = repos;
  assert.ok(widgets);
  store.setRunSnapshots(run.id, await startSnapshots(repos));
  let now = 0;
  const live = new LiveDiffs(LIVE_DIFF_TTL_MS, () => now);
  const stat = async () => {
    const dto = await readRunDiff(read(), dirs, { live });
    assert.ok(dto.source === "git");
    return dto.repos[0]?.stat;
  };
  const [a, b] = await Promise.all([stat(), stat()]);
  assert.equal(a, "");
  assert.equal(b, "");
  writeFileSync(join(widgets.path, "new.txt"), "new\n");
  now += LIVE_DIFF_TTL_MS - 1;
  assert.equal(await stat(), "", "still cached");
  now += 1;
  assert.equal(await stat(), "1 file changed, 1 insertion(+)");
});

test("GET /api/runs/:id/diff serves the run's diff", async () => {
  const config = loadConfig({
    NAKARA_BACKUP_DIR: join(tmpdir(), `nakara-run-diff-backups-${process.pid}`),
  });
  const { store, run } = fixture();
  const registry = new FactoryRegistry(store, config);
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "token",
  );
  const bindings = {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  } as HttpBindings;
  const get = (path: string) => app.request(path, {}, bindings);
  const response = await get(`/api/runs/${run.id}/diff`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { source: "log" });
  assert.equal((await get("/api/runs/999/diff")).status, 404);
});
