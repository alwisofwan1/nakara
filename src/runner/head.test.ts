import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { worktreeHead } from "./head.ts";

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
    "-aqm",
    message,
  );

/** A bare clone and a detached worktree of it, as prepareWorkspace makes them. */
function repo(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nakara-head-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, "app.txt"), "1\n");
  git(seed, "add", ".");
  commit(seed, "init");
  const bare = join(root, "app.git");
  git(root, "clone", "--bare", "--quiet", seed, bare);
  const path = join(root, "app");
  git(bare, "worktree", "add", "--detach", "--quiet", path, "main");
  return { root, path, bare };
}

test("a worktree's HEAD is read when detached, on a loose branch and on a packed one", async (t) => {
  const { path, bare } = repo(t);
  assert.equal(await worktreeHead(path), git(path, "rev-parse", "HEAD"));
  git(path, "checkout", "-q", "-b", "pr99");
  writeFileSync(join(path, "app.txt"), "2\n");
  commit(path, "fix -a");
  const local = git(path, "rev-parse", "HEAD");
  assert.equal(await worktreeHead(path), local);
  git(bare, "pack-refs", "--all");
  assert.equal(existsSync(join(bare, "refs", "heads", "pr99")), false);
  assert.equal(await worktreeHead(path), local);
});

test("a clone's HEAD is read from its own .git directory", async (t) => {
  const { root, bare } = repo(t);
  const clone = join(root, "clone");
  git(root, "clone", "--quiet", "--shared", bare, clone);
  git(clone, "checkout", "-q", "--detach");
  assert.equal(await worktreeHead(clone), git(clone, "rev-parse", "HEAD"));
  git(clone, "checkout", "-q", "-b", "pr7");
  writeFileSync(join(clone, "app.txt"), "2\n");
  commit(clone, "fix");
  git(clone, "pack-refs", "--all");
  assert.equal(await worktreeHead(clone), git(clone, "rev-parse", "HEAD"));
});

test("an unborn branch, a missing worktree or a HEAD that is not a file read as null", async (t) => {
  const { root, path, bare } = repo(t);
  assert.equal(await worktreeHead(join(root, "missing")), null);
  git(path, "checkout", "-q", "--orphan", "empty");
  assert.equal(await worktreeHead(path), null);
  // The agent may point HEAD anywhere; a symlink is not followed.
  const admin = join(bare, "worktrees", "app");
  rmSync(join(admin, "HEAD"));
  writeFileSync(join(root, "elsewhere"), `${"a".repeat(40)}\n`);
  symlinkSync(join(root, "elsewhere"), join(admin, "HEAD"));
  assert.equal(await worktreeHead(path), null);
});

test("reading HEAD runs nothing from the agent's git config on the host", async (t) => {
  const { root, path, bare } = repo(t);
  const marker = join(root, "fsmonitor-ran");
  const hook = join(root, "fsmonitor.sh");
  writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  chmodSync(hook, 0o755);
  // Appended as text: running git config here would be a git command.
  appendFileSync(join(bare, "config"), `[core]\n\tfsmonitor = ${hook}\n`);
  const expected = git(bare, "rev-parse", "main");
  rmSync(marker, { force: true });
  assert.equal(await worktreeHead(path), expected);
  assert.equal(existsSync(marker), false);
  // The same config runs the hook as soon as git runs in the worktree.
  execFileSync("git", ["status", "--short"], { cwd: path, stdio: "ignore" });
  assert.equal(existsSync(marker), true);
});
