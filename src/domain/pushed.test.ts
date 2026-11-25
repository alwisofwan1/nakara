import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";
import { GH_PR } from "./pushed.ts";

const PR = "https://github.com/o/r/pull/7";
const HEAD = { sha: "b".repeat(40), branch: "nakara/7-fix" };
const LOCAL = "a".repeat(40);

/** A fake gh on PATH that answers every call with `reply` and records its arguments. */
async function fakeGh(
  t: TestContext,
  reply: { stdout?: unknown; stderr?: string; code?: number },
) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-pushed-gh-"));
  const calls = join(dir, "calls.jsonl");
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + "\\n");
${reply.stdout === undefined ? "" : `console.log(${JSON.stringify(JSON.stringify(reply.stdout))});`}
${reply.stderr ? `console.error(${JSON.stringify(reply.stderr)});` : ""}
process.exit(${reply.code ?? 0});
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  return async () =>
    (await readFile(calls, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
}

test("the PR head is the pull request's head commit and branch", async (t) => {
  const calls = await fakeGh(t, {
    stdout: { head: { sha: HEAD.sha, ref: HEAD.branch } },
  });
  assert.deepEqual(await GH_PR.readPrHead(PR), HEAD);
  assert.deepEqual(await calls(), [["api", "repos/o/r/pulls/7"]]);
});

for (const [missing, head] of [
  ["head.sha", { ref: HEAD.branch }],
  ["head.ref", { sha: HEAD.sha }],
  ["head", null],
] as const) {
  test(`a pulls response without ${missing} is an error`, async (t) => {
    await fakeGh(t, { stdout: { head } });
    await assert.rejects(GH_PR.readPrHead(PR), /Invalid response from GitHub/);
  });
}

for (const [status, onPr] of [
  ["identical", true],
  ["ahead", true],
  ["behind", false],
  ["diverged", false],
] as const) {
  test(`a commit whose compare to the PR head is ${status} is ${onPr ? "" : "not "}on the PR`, async (t) => {
    const calls = await fakeGh(t, { stdout: { status } });
    assert.equal(await GH_PR.onPr(PR, LOCAL, HEAD), onPr);
    assert.deepEqual(await calls(), [
      ["api", `repos/o/r/compare/${LOCAL}...${HEAD.sha}`],
    ]);
  });
}

test("the PR head itself is on the PR without asking GitHub", async (t) => {
  const calls = await fakeGh(t, { code: 1, stderr: "must not be called" });
  assert.equal(await GH_PR.onPr(PR, HEAD.sha, HEAD), true);
  assert.deepEqual(await calls(), []);
});

for (const code of [404, 422]) {
  test(`a commit GitHub does not have (HTTP ${code}) is not on the PR`, async (t) => {
    await fakeGh(t, {
      code: 1,
      stderr: `gh: No commit found for SHA: ${LOCAL} (HTTP ${code})`,
    });
    assert.equal(await GH_PR.onPr(PR, LOCAL, HEAD), false);
  });
}

test("any other compare error is rethrown", async (t) => {
  await fakeGh(t, { code: 1, stderr: "gh: Bad credentials (HTTP 401)" });
  await assert.rejects(GH_PR.onPr(PR, LOCAL, HEAD), /HTTP 401/);
});
