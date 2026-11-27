import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runTurn } from "./claude.ts";
import { isClaudeLimit, isCodexLimit, resetFromText } from "./limits.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures/", import.meta.url));

/** Run a fake CLI that prints the fixture, as the harness would. */
async function replay(
  harness: "claude" | "codex",
  fixture: string,
  t: { after: (fn: () => Promise<void>) => void },
) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-limits-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, harness);
  await writeFile(
    fake,
    `#!/bin/sh\ncat > /dev/null\ncat '${join(FIXTURES, fixture)}'\n`,
  );
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), "");
  return runTurn(
    {
      harness,
      model: undefined,
      cwd: dir,
      prompt: "do it",
      systemPromptFile: join(dir, "system.md"),
      permissionMode: "bypassPermissions",
      idleTimeoutMs: 10_000,
      logPath: join(dir, "log"),
    },
    { claude: fake, qwen: "qwen", codex: fake, codexHome: join(dir, "home") },
  );
}

const LIMITED = [
  ["claude", "claude-usage-limit.jsonl", "2026-11-28T14:00:00.000Z"],
  ["claude", "claude-legacy-usage-limit.jsonl", "2026-11-28T14:00:00.000Z"],
  ["claude", "claude-rate-limit.jsonl", null],
  ["codex", "codex-rate-limit.jsonl", null],
] as const;

for (const [harness, fixture, resetAt] of LIMITED)
  test(`a limit is detected: ${fixture}`, async (t) => {
    const out = await replay(harness, fixture, t);
    assert.equal(out.ok, false);
    assert.ok(out.limit, out.error ?? "");
    assert.equal(out.limit.resetAt, resetAt);
    assert.equal(out.limit.worked, false);
    assert.match(
      out.error ?? "",
      new RegExp(`^${harness} hit a rate or usage limit`),
    );
  });

test("codex's usage limit carries its reset time", async (t) => {
  const out = await replay("codex", "codex-usage-limit.jsonl", t);
  assert.equal(out.ok, false);
  assert.ok(out.limit);
  // codex prints the reset in the host's local time.
  const reset = new Date(out.limit.resetAt ?? "");
  assert.deepEqual(
    [
      reset.getFullYear(),
      reset.getMonth(),
      reset.getDate(),
      reset.getHours(),
      reset.getMinutes(),
    ],
    [2026, 10, 28, 15, 4],
  );
  assert.match(out.limit.message, /^You've hit your usage limit\./);
});

// Tool output, MCP errors, the agent's reply and an error that only quotes an API's 429 are no limit of the harness.
for (const [harness, fixture] of [
  ["claude", "claude-ordinary-failure.jsonl"],
  ["claude", "claude-tool-quotes-limit.jsonl"],
  ["codex", "codex-ordinary-failure.jsonl"],
  ["codex", "codex-tool-quotes-limit.jsonl"],
] as const)
  test(`an ordinary failure is no limit: ${fixture}`, async (t) => {
    const out = await replay(harness, fixture, t);
    assert.equal(out.ok, false);
    assert.equal(out.limit ?? null, null);
  });

test("only the CLI's own limit error counts, where its text starts", () => {
  assert.ok(isClaudeLimit("Claude AI usage limit reached|1795874400"));
  assert.ok(isClaudeLimit("You've hit your weekly limit · resets Mon 9am"));
  assert.ok(isClaudeLimit("You’ve reached your Opus limit"));
  assert.ok(isClaudeLimit('API Error: 429 {"type":"error"}'));
  assert.ok(!isClaudeLimit("The test failed: API Error: 429 from GitHub"));
  assert.ok(!isClaudeLimit("usage limit reached for this key"));
  assert.ok(!isClaudeLimit("429 Too Many Requests"));
  assert.ok(isCodexLimit("You've hit your usage limit. Try again in 2 hours."));
  assert.ok(
    isCodexLimit("exceeded retry limit, last status: 429 Too Many Requests"),
  );
  assert.ok(
    isCodexLimit("Rate limit reached for gpt-5 in organization org-1."),
  );
  assert.ok(
    !isCodexLimit(
      "stream disconnected: upstream returned 429 Too Many Requests",
    ),
  );
  assert.ok(!isCodexLimit("rate limit reached"));
});

test("reset times in the limit texts", () => {
  const now = new Date(2026, 10, 27, 16, 0, 0).getTime();
  const after = (ms: number) => new Date(now + ms).toISOString();
  assert.equal(
    resetFromText("try again in 2 days 3 hours 4 minutes.", now),
    after(((2 * 24 + 3) * 60 + 4) * 60_000),
  );
  assert.equal(resetFromText("Please try again in 1.5s.", now), after(1500));
  assert.equal(resetFromText("Please try again in 20ms.", now), after(20));
  // A time of day already past today is tomorrow's.
  assert.equal(
    resetFromText("or try again at 3:04 PM.", now),
    new Date(2026, 10, 28, 15, 4).toISOString(),
  );
  assert.equal(
    resetFromText("or try again at 5:30 PM.", now),
    new Date(2026, 10, 27, 17, 30).toISOString(),
  );
  assert.equal(resetFromText("Please try again later.", now), null);
});
