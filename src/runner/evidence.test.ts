import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  collectProof,
  excludeProof,
  PROOF_DIR,
  stageEvidence,
} from "./evidence.ts";

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), "proof-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const dir = join(repo, PROOF_DIR);
  await mkdir(dir, { recursive: true });
  const dest = join(root, "internal", "evidence");
  const manifest = (entries: unknown) =>
    writeFile(join(dir, "proof.json"), JSON.stringify(entries));
  return { root, repo, dir, dest, manifest };
}

test("proof is copied out with its criterion, in order", async (t) => {
  const { repo, dir, dest, manifest } = await setup(t);
  await writeFile(join(dir, "home.png"), "png");
  await mkdir(join(dir, "nested"));
  await writeFile(join(dir, "nested", "error.webp"), "webp");
  await manifest([
    { criterion: " The home page lists the tools ", screenshot: "home.png" },
    {
      criterion: "An empty input shows an error",
      screenshot: "nested/error.webp",
    },
  ]);
  const { proofs, problems } = await collectProof(repo, 0, dest);
  assert.deepEqual(problems, []);
  assert.deepEqual(proofs, [
    {
      criterion: "The home page lists the tools",
      file: join(dest, "1-home.png"),
    },
    {
      criterion: "An empty input shows an error",
      file: join(dest, "2-error.webp"),
    },
  ]);
});

test("no proof, or proof from an earlier run, is nothing to collect", async (t) => {
  const { repo, dir, dest, manifest } = await setup(t);
  assert.deepEqual(await collectProof(repo, 0, dest), {
    proofs: [],
    problems: [],
  });
  await writeFile(join(dir, "a.png"), "png");
  await manifest([{ criterion: "c", screenshot: "a.png" }]);
  const old = new Date(Date.now() - 60_000);
  await utimes(join(dir, "proof.json"), old, old);
  assert.deepEqual(await collectProof(repo, Date.now() - 1_000, dest), {
    proofs: [],
    problems: [],
  });
});

test("an entry that could read outside the proof directory is refused", async (t) => {
  const { root, repo, dir, dest, manifest } = await setup(t);
  await writeFile(join(root, "secret.png"), "secret");
  await symlink(join(root, "secret.png"), join(dir, "link.png"));
  await mkdir(join(root, "elsewhere"));
  await writeFile(join(root, "elsewhere", "b.png"), "secret");
  await symlink(join(root, "elsewhere"), join(dir, "linked-dir"));
  await writeFile(join(dir, "notes.txt"), "text");
  await manifest([
    { criterion: "a", screenshot: "../../secret.png" },
    { criterion: "b", screenshot: "link.png" },
    { criterion: "c", screenshot: "linked-dir/b.png" },
    { criterion: "d", screenshot: "notes.txt" },
    { criterion: "e", screenshot: "missing.png" },
    { criterion: "", screenshot: "x.png" },
    "not an object",
  ]);
  const { proofs, problems } = await collectProof(repo, 0, dest);
  assert.deepEqual(proofs, []);
  assert.equal(problems.length, 7);
  assert.match(problems[0] ?? "", /outside/);
  assert.match(problems[1] ?? "", /not a regular file/);
  assert.match(problems[2] ?? "", /through a link/);
  assert.match(problems[3] ?? "", /not a PNG/);
});

test("a proof directory that is a link is refused", async (t) => {
  const { root, repo, dir, dest } = await setup(t);
  await rm(dir, { recursive: true });
  const outside = join(root, "outside");
  await mkdir(outside);
  await writeFile(join(outside, "a.png"), "secret");
  await writeFile(
    join(outside, "proof.json"),
    JSON.stringify([{ criterion: "c", screenshot: "a.png" }]),
  );
  await symlink(outside, dir);
  const { proofs, problems } = await collectProof(repo, 0, dest);
  assert.deepEqual(proofs, []);
  assert.deepEqual(problems, [`${PROOF_DIR}/ is a link.`]);
});

test("a manifest that is not a JSON list is reported", async (t) => {
  const { repo, dir, dest } = await setup(t);
  await writeFile(join(dir, "proof.json"), "{");
  assert.deepEqual((await collectProof(repo, 0, dest)).problems, [
    `${PROOF_DIR}/proof.json is not JSON.`,
  ]);
  await writeFile(join(dir, "proof.json"), "{}");
  assert.deepEqual((await collectProof(repo, 0, dest)).problems, [
    `${PROOF_DIR}/proof.json is not a list.`,
  ]);
});

test("the proof is excluded from commits once, after what the clone had", async (t) => {
  const { repo } = await setup(t);
  await mkdir(join(repo, ".git", "info"), { recursive: true });
  await writeFile(join(repo, ".git", "info", "exclude"), "# git's own\n*.log");
  await excludeProof(repo);
  await excludeProof(repo);
  assert.equal(
    await readFile(join(repo, ".git", "info", "exclude"), "utf8"),
    `# git's own\n*.log\n/${PROOF_DIR}/\n/.playwright-cli/\n`,
  );
});

test("staged evidence is a read-only copy with its criterion, and a second staging replaces the first", async (t) => {
  const { root, dest } = await setup(t);
  await mkdir(join(root, "internal"));
  const a = join(root, "internal", "a.png");
  const b = join(root, "internal", "b.png");
  await writeFile(a, "A");
  await writeFile(b, "B");
  const first = await stageEvidence(
    [
      { criterion: "Home lists tools", file: a },
      { criterion: "Empty input errors", file: b },
    ],
    dest,
  );
  assert.deepEqual(
    first.map((p) => p.criterion),
    ["Home lists tools", "Empty input errors"],
  );
  assert.equal(await readFile(first[0]?.file ?? "", "utf8"), "A");
  assert.ok(first.every((p) => p.file.startsWith(`${dest}/`)));
  // Read-only files.
  await assert.rejects(writeFile(first[0]?.file ?? "", "x"), /EACCES/);
  // A later review gets only the current proof, not the earlier copy.
  await stageEvidence([{ criterion: "Only", file: b }], dest);
  assert.deepEqual(await readdir(dest), ["1-b.png"]);
  // Nothing to stage removes the directory.
  assert.deepEqual(await stageEvidence([], dest), []);
  await assert.rejects(readdir(dest), /ENOENT/);
});

test("staging refuses a path an agent planted as a link instead of following it", async (t) => {
  const { root, dest } = await setup(t);
  await mkdir(join(root, "internal"));
  const real = join(root, "internal", "a.png");
  const victim = join(root, "victim");
  await writeFile(real, "A");
  await writeFile(victim, "keep");
  // The agent replaced the directory with a link to a directory it chose.
  await symlink(join(root, "internal"), dest);
  const staged = await stageEvidence([{ criterion: "c", file: real }], dest);
  assert.equal(staged.length, 1);
  assert.equal(await readFile(real, "utf8"), "A");
  assert.equal(await readFile(victim, "utf8"), "keep");
  assert.ok((await lstat(dest)).isDirectory());
});
