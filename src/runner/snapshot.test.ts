import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import {
  diffFile,
  diffRepos,
  diffTrees,
  endSnapshots,
  recordDiff,
  snapshotTree,
  startSnapshots,
} from "./snapshot.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** A cache and a clone sharing its objects, as prepareWorkspace makes them. */
function repo(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "nakara-snapshot-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const seed = join(root, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(seed, ".gitignore"), "build/\n");
  writeFileSync(join(seed, "app.txt"), "color = red\nsize = 2\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  const bare = join(root, "app.git");
  git(root, "clone", "--bare", "--quiet", seed, bare);
  const path = join(root, "app");
  git(root, "clone", "--quiet", "--shared", bare, path);
  return { root, path, bare, objects: join(root, "objects"), slug: "acme/app" };
}

test("a snapshot records shell edits and new files without touching the index", async (t) => {
  const { path, bare, objects } = repo(t);
  const start = await snapshotTree(path, { bare, objects });
  assert.equal(start, git(path, "rev-parse", "HEAD^{tree}"));
  // An edit no harness tool reported: a shell command, plus a generated file.
  execFileSync(
    "bash",
    [
      "-c",
      "sed -i 's/red/blue/' app.txt && mkdir -p gen build && echo x > gen/out.txt && echo y > build/skip.txt",
    ],
    { cwd: path },
  );
  const index = git(
    path,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "index",
  );
  const indexBefore = readFileSync(index);
  const end = await snapshotTree(path, { bare, objects });
  assert.deepEqual(readFileSync(index), indexBefore);
  assert.equal(git(path, "status", "--porcelain"), "M app.txt\n?? gen/");

  const { diff, stat, truncated } = await diffTrees(
    { bare, objects },
    start,
    end,
  );
  assert.equal(truncated, false);
  assert.match(stat, /2 files changed, 2 insertions\(\+\), 1 deletion\(-\)/);
  assert.match(diff, /^-color = red$/m);
  assert.match(diff, /^\+color = blue$/m);
  assert.match(diff, /^diff --git a\/gen\/out.txt b\/gen\/out.txt$/m);
  // Ignored files stay out.
  assert.doesNotMatch(diff, /build\/skip.txt/);
  // The trees are in Nakara's own objects, not in the cache or the clone.
  assert.ok(existsSync(join(objects, end.slice(0, 2), end.slice(2))));
  for (const repo of [bare, path])
    assert.throws(() => git(repo, "cat-file", "-e", end));
});

test("the agent's fsmonitor, clean filter and diff driver never run on the host", async (t) => {
  const { root, path, bare, objects, slug } = repo(t);
  const ran = (name: string) => existsSync(join(root, `${name}-ran`));
  // Set by the agent in the repository config it controls.
  const fsmonitor = join(root, "fsmonitor.sh");
  writeFileSync(fsmonitor, `#!/bin/sh\ntouch '${root}/fsmonitor-ran'\n`);
  chmodSync(fsmonitor, 0o755);
  git(path, "config", "core.fsmonitor", fsmonitor);
  git(
    path,
    "config",
    "filter.evil.clean",
    `sh -c "touch '${root}/filter-ran'; cat"`,
  );
  git(path, "config", "filter.evil.required", "true");
  git(path, "config", "diff.evil.command", `sh -c "touch '${root}/diff-ran'"`);
  git(
    path,
    "config",
    "diff.evil.textconv",
    `sh -c "touch '${root}/textconv-ran'; cat"`,
  );
  writeFileSync(join(path, ".gitattributes"), "*.txt filter=evil diff=evil\n");

  const [started] = await startSnapshots([{ slug, path, bare, objects }]);
  assert.ok(started);
  writeFileSync(join(path, "app.txt"), "color = green\n");
  writeFileSync(join(path, "new.txt"), "new\n");
  // A live diff snapshots the clone, then diffs in the snapshot objects.
  const [live] = await diffRepos([started], [{ slug, path, bare, objects }]);
  assert.match(live?.diff ?? "", /^\+color = green$/m);
  const ended = await endSnapshots([{ slug, path, bare, objects }], [started]);
  const [final] = await diffRepos(ended, [{ slug, path, bare, objects }]);
  assert.equal(final?.error, null);
  assert.match(final?.stat ?? "", /^2 files changed/);
  for (const name of ["fsmonitor", "filter", "diff", "textconv"])
    assert.equal(ran(name), false, `${name} ran`);

  // The same configuration runs them under the agent's own git: the test bites.
  git(path, "add", "--all");
  assert.equal(ran("fsmonitor"), true);
  assert.equal(ran("filter"), true);
});

test("start and end snapshots per repository; one that cannot be snapshotted is left out", async (t) => {
  const { root, path, bare, objects, slug } = repo(t);
  // An agent can swap its clone for a symlink to a host directory: not read.
  const host = join(root, "host");
  mkdirSync(host);
  writeFileSync(join(host, "secret.txt"), "s\n");
  git(host, "init", "--quiet");
  symlinkSync(host, join(root, "swapped"));
  const repos = [
    { slug, path, bare, objects },
    { slug: "acme/missing", path: join(path, "nope"), bare, objects },
    { slug: "acme/swapped", path: join(root, "swapped"), bare, objects },
  ];
  const started = await startSnapshots(repos);
  assert.deepEqual(
    started.map((s) => s.slug),
    ["acme/app"],
  );
  writeFileSync(join(path, "app.txt"), "color = green\n");
  const [snapshot] = await endSnapshots(repos, started);
  assert.ok(snapshot?.end);
  assert.notEqual(snapshot.end, snapshot.start);
  // Without its worktree, a repository keeps only its start.
  assert.deepEqual(await endSnapshots([], started), started);
});

test("a run's final diff is written next to its log, truncated with every change counted", async (t) => {
  const { root, path, bare, objects, slug } = repo(t);
  const repos = [{ slug, path, bare, objects }];
  const started = await startSnapshots(repos);
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
  writeFileSync(join(path, "big.txt"), `${lines}\n`);
  writeFileSync(join(path, "last.txt"), "after the cut\n");
  const ended = await endSnapshots(repos, started);
  const logPath = join(root, "run-7.jsonl");
  assert.equal(diffFile(logPath), join(root, "run-7.diff.json"));
  await recordDiff(logPath, ended, repos, 4096);
  const [written] = JSON.parse(readFileSync(diffFile(logPath), "utf8"));
  assert.equal(written.slug, slug);
  assert.equal(written.truncated, true);
  assert.equal(written.limitBytes, 4096);
  assert.equal(written.error, null);
  assert.ok(written.diff.length <= 4096);
  assert.ok(written.diff.endsWith("\n"));
  assert.match(written.diff.split("\n").at(-2), /^\+line \d+$/);
  assert.doesNotMatch(written.diff, /last\.txt/);
  assert.equal(written.stat, "2 files changed, 5001 insertions(+)");
  // A repository whose objects are gone reports why.
  rmSync(objects, { recursive: true, force: true });
  const [gone] = await diffRepos(ended, repos);
  assert.match(gone?.error ?? "", /^Could not read the diff/);
});
