import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import { worktreeHead } from "../runner/head.ts";
import {
  ensureBareClone,
  internalDir,
  readInternal,
} from "../runner/workspace.ts";
import { quietTelemetry } from "../telemetry/metrics.ts";
import { migrateOldLayout } from "./migrate-layout.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const commit = (cwd: string, message: string) =>
  git(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qam",
    message,
  );

/**
 * A data directory as the old layout left it: a shared cache of acme/widgets
 * and, per item, a worktree of it and the internal files in item-N/.nakara.
 */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-migrate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({ NAKARA_DATA_DIR: dir });
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "app.txt"), "1\n");
  git(seed, "add", ".");
  commit(seed, "init");
  const cache = join(config.repoCacheDir, "acme", "widgets.git");
  git(dir, "clone", "--bare", "--quiet", seed, cache);
  git(
    cache,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  );
  git(cache, "fetch", "--quiet", "origin");

  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  /** An open item with a worktree on `origin/main` and a run log. */
  const oldItem = () => {
    const item = store.createItem({
      title: "Old",
      request: "Test",
      source: "manual",
    });
    const root = join(config.workDir, `item-${item.id}`);
    const path = join(root, "widgets");
    git(cache, "worktree", "add", "--detach", "--quiet", path, "origin/main");
    mkdirSync(join(root, ".nakara", "logs"), { recursive: true });
    mkdirSync(join(root, ".nakara", "home"));
    writeFileSync(join(root, ".nakara", "home", "session.jsonl"), "{}\n");
    const log = join(root, ".nakara", "logs", "run-1.jsonl");
    writeFileSync(log, '{"type":"result"}\n');
    writeFileSync(join(root, ".nakara", "run-1.system.md"), "You implement.\n");
    const run = store.createRun({
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
    store.markRunStarted(run.id, log);
    return { item, root, path, run };
  };
  // GitHub, offline: a fresh cache is cloned from the seed.
  const fresh: typeof ensureBareClone = async (cacheDir, owner, name) => {
    const path = join(cacheDir, owner, name);
    if (!existsSync(`${path}.git`)) {
      git(dir, "clone", "--bare", "--quiet", seed, `${path}.git`);
      git(
        `${path}.git`,
        "config",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*",
      );
    }
    return ensureBareClone(cacheDir, owner, name);
  };
  const definition = {
    factory: { repositories: [{ owner: "acme", name: "widgets" }] },
  } as Definition;
  const migrate = () =>
    migrateOldLayout(store, config, () => definition, quietTelemetry(), fresh);
  return { dir, config, seed, cache, store, oldItem, migrate };
}

test("an old-layout item keeps its branch, unpushed commit and uncommitted changes, and its internal files move out of the mount", async (t) => {
  const { config, cache, store, oldItem, migrate } = fixture(t);
  const { item, root, path, run } = oldItem();
  git(path, "checkout", "-q", "-b", "pr1");
  writeFileSync(join(path, "app.txt"), "2\n");
  commit(path, "unpushed");
  const local = git(path, "rev-parse", "HEAD");
  writeFileSync(join(path, "app.txt"), "3\n");
  writeFileSync(join(path, "new.txt"), "untracked\n");

  await migrate();

  assert.equal(git(path, "symbolic-ref", "HEAD"), "refs/heads/pr1");
  assert.equal(await worktreeHead(path), local);
  assert.equal(readFileSync(join(path, "app.txt"), "utf8"), "3\n");
  assert.equal(git(path, "diff", "--name-only"), "app.txt");
  assert.equal(git(path, "ls-files", "--others"), "new.txt");
  // A clone of its own, borrowing the fresh cache's objects; the old one is gone.
  assert.ok(existsSync(join(path, ".git", "HEAD")));
  assert.equal(
    readFileSync(join(path, ".git", "objects", "info", "alternates"), "utf8"),
    `${join(cache, "objects")}\n`,
  );
  assert.equal(existsSync(join(cache, "worktrees")), false);
  // Kept for what migration does not carry: other local branches, the stash.
  assert.ok(
    existsSync(join(`${config.repoCacheDir}.old`, "acme", "widgets.git")),
  );
  // The agent resumes: it commits on its branch.
  commit(path, "resumed");
  assert.equal(git(path, "rev-parse", "HEAD~1"), local);

  const internal = internalDir(config.workDir, item.id);
  assert.equal(existsSync(join(root, ".nakara")), false);
  const logPath = store.runById(run.id)?.log_path ?? "";
  assert.equal(logPath, join(internal, "logs", "run-1.jsonl"));
  assert.equal(
    await readInternal(config.workDir, item.id, logPath),
    '{"type":"result"}\n',
  );
  assert.ok(existsSync(join(internal, "run-1.system.md")));
  assert.ok(existsSync(join(`${root}.home`, "session.jsonl")));
  assert.notEqual(store.item(item.id)?.status, "paused");
});

test("an item that cannot be migrated is paused with the reason, and the others are migrated", async (t) => {
  const { config, store, oldItem, migrate } = fixture(t);
  const broken = oldItem();
  const good = oldItem();
  // Its HEAD names a branch that does not exist.
  git(broken.path, "checkout", "-q", "--orphan", "empty");

  await migrate();

  assert.equal(store.item(broken.item.id)?.status, "paused");
  const [message] = store.messages(broken.item.id);
  assert.match(
    message?.body ?? "",
    /Could not move this item's workspace.*HEAD of widgets cannot be read/,
  );
  assert.equal(
    readFileSync(join(broken.path, ".git"), "utf8").startsWith("gitdir:"),
    true,
  );
  assert.equal(existsSync(internalDir(config.workDir, broken.item.id)), false);
  // The old cache stays for the next attempt.
  assert.ok(existsSync(`${config.repoCacheDir}.old`));

  assert.ok(existsSync(internalDir(config.workDir, good.item.id)));
  assert.notEqual(store.item(good.item.id)?.status, "paused");
});

test("a complete or cancelled item is not migrated", async (t) => {
  const { config, store, oldItem, migrate } = fixture(t);
  const { item, root, path } = oldItem();
  // It could not be migrated: its HEAD names a branch that does not exist.
  git(path, "checkout", "-q", "--orphan", "empty");
  store.updateItem(item.id, { stage: "cancelled", status: "done" });

  await migrate();

  assert.equal(existsSync(`${root}.migrating`), false);
  assert.equal(existsSync(internalDir(config.workDir, item.id)), false);
  assert.ok(existsSync(join(root, ".nakara", "logs", "run-1.jsonl")));
  assert.equal(store.item(item.id)?.status, "done");
  assert.equal(store.messages(item.id).length, 0);
});

test("migrating twice is a no-op", async (t) => {
  const { store, oldItem, migrate } = fixture(t);
  const { item, path } = oldItem();
  git(path, "checkout", "-q", "-b", "pr1");
  await migrate();
  const head = git(path, "rev-parse", "HEAD");
  const listing = git(path, "status", "--porcelain");
  await migrate();
  assert.equal(git(path, "rev-parse", "HEAD"), head);
  assert.equal(git(path, "status", "--porcelain"), listing);
  assert.equal(store.messages(item.id).length, 0);
});
