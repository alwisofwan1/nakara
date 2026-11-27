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

import type { Definition } from "../definition/load.ts";
import { runVerify, type VerifyJob } from "./verify.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A repository cache for acme/widgets whose origin is a local seed with two commits; verify runs on the host. */
function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  const commit = (file: string, text: string) => {
    writeFileSync(join(seed, file), text);
    git(seed, "add", ".");
    git(
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      file,
    );
    return git(seed, "rev-parse", "HEAD");
  };
  commit("README.md", "v1\n");
  const head = commit("README.md", "v2\n");
  const repoCacheDir = join(dir, "repos");
  const bare = join(repoCacheDir, "acme", "widgets.git");
  git(dir, "clone", "--bare", "--quiet", seed, bare);
  git(
    bare,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  );
  const internal = join(dir, "work", "item-1.nakara", "logs");
  mkdirSync(internal, { recursive: true });
  const job = (over: Partial<VerifyJob>): VerifyJob => ({
    def: { runners: new Map() } as unknown as Definition,
    itemId: 1,
    runId: 7,
    owner: "acme",
    name: "widgets",
    head,
    commands: [],
    runner: undefined,
    timeoutMs: 60_000,
    dirs: { workDir: join(dir, "work"), repoCacheDir, dataDir: dir },
    claudeBin: "claude",
    logPath: join(internal, "run-7.verify.log"),
    ...over,
  });
  return { dir, job, head };
}

test("verify runs the commands on the PR head in a fresh checkout, and keeps their output", async (t) => {
  const { dir, job } = fixture(t);
  const outcome = await runVerify(
    job({ commands: ["cat README.md", 'test -z "$GH_TOKEN"'] }),
  );
  assert.equal(outcome.status, "passed", JSON.stringify(outcome));
  assert.deepEqual(
    outcome.commands.map((c) => [c.command, c.ok]),
    [
      ["cat README.md", true],
      ['test -z "$GH_TOKEN"', true],
    ],
  );
  const log = readFileSync(job({}).logPath, "utf8");
  assert.match(log, /\$ cat README\.md\nv2\n/);
  // The checkout is gone once the verify ends.
  assert.equal(existsSync(join(dir, "work", "item-1.verify")), false);
});

test("verify stops at the first failing command and returns the tail of its output, redacted", async (t) => {
  const { job } = fixture(t);
  const token = `ghp_${"a".repeat(36)}`;
  const outcome = await runVerify(
    job({
      commands: [
        "true",
        `seq 1 300; echo ${token}; exit 3`,
        "echo never > ran.txt",
      ],
    }),
  );
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failed, `seq 1 300; echo ${token}; exit 3`);
  assert.deepEqual(
    outcome.commands.map((c) => c.ok),
    [true, false],
  );
  const lines = outcome.tail?.split("\n") ?? [];
  assert.ok(lines.length <= 200, String(lines.length));
  assert.equal(lines[0], "102");
  assert.ok(lines.includes("[redacted]"));
  assert.doesNotMatch(outcome.tail ?? "", /ghp_/);
  assert.doesNotMatch(readFileSync(job({}).logPath, "utf8"), /ghp_a/);
});

test("a verify that times out or has no runner could not run", async (t) => {
  const { job } = fixture(t);
  const slow = await runVerify(job({ commands: ["sleep 5"], timeoutMs: 200 }));
  assert.equal(slow.status, "error");
  assert.match(slow.reason ?? "", /timeout .* ran out during `sleep 5`/);
  const missing = await runVerify(job({ commands: ["true"], runner: "gone" }));
  assert.equal(missing.status, "error");
  assert.match(missing.reason ?? "", /runner "gone" is not in the definition/);
  const unknown = await runVerify(
    job({ commands: ["true"], head: "0".repeat(40) }),
  );
  assert.equal(unknown.status, "error");
  assert.match(unknown.reason ?? "", /could not check out/);
});
