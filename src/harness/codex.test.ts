import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, toolCalls } from "./claude.ts";

test("codex turns: args, session, final message and rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-codex-"));
  const fake = join(dir, "codex");
  await writeFile(
    fake,
    `#!/bin/sh
printf '%s\\n' "$@" > "${dir}/args"; cat > "${dir}/stdin"
cp "$CODEX_HOME/rules/nakara.rules" "${dir}/rules"; echo "$CODEX_HOME" > "${dir}/home"
echo '{"type":"thread.started","thread_id":"t-1"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"opened PR"}}'
echo '{"type":"turn.completed","usage":{"input_tokens":1}}'
`,
  );
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), 'Say "hi".');
  const base = {
    harness: "codex" as const,
    model: "gpt-5",
    cwd: dir,
    prompt: "do it",
    systemPromptFile: join(dir, "system.md"),
    permissionMode: "bypassPermissions" as const,
    idleTimeoutMs: 10_000,
    logPath: join(dir, "log"),
  };
  const bins = {
    claude: "claude",
    qwen: "qwen",
    codex: fake,
    codexHome: join(dir, "codex"),
  };

  const out = await runTurn(base, bins);
  assert.deepEqual(
    [out.ok, out.sessionId, out.result],
    [true, "t-1", "opened PR"],
  );
  const args = (await readFile(join(dir, "args"), "utf8")).split("\n");
  assert.ok(args.includes('developer_instructions="Say \\"hi\\"."'));
  assert.ok(args.includes('sandbox_mode="workspace-write"'));
  assert.equal(await readFile(join(dir, "stdin"), "utf8"), "do it");
  assert.match(
    await readFile(join(dir, "rules"), "utf8"),
    /"gh", "pr", "merge"/,
  );
  // The run's own home, removed once it ends.
  const home = (await readFile(join(dir, "home"), "utf8")).trim();
  assert.ok(home.startsWith(`${bins.codexHome}.runs/`));
  assert.equal(existsSync(home), false);

  await runTurn({ ...base, resumeSession: "t-1" }, bins);
  const resumed = (await readFile(join(dir, "args"), "utf8"))
    .trim()
    .split("\n");
  assert.deepEqual(
    [resumed[0], resumed[1], resumed.at(-2), resumed.at(-1)],
    ["exec", "resume", "t-1", "-"],
  );
});

test("a codex MCP call counts once, though it is reported as started and completed", () => {
  const seen = new Set<string>();
  const item = (type: string, server: string) =>
    JSON.stringify({
      type,
      item: {
        id: `i-${server}`,
        type: "mcp_tool_call",
        server,
        tool: "get_issue",
      },
    });
  assert.deepEqual(
    [
      item("item.started", "sentry"),
      item("item.completed", "sentry"),
      item("item.started", "nakara"),
      "not json",
    ].flatMap((line) => toolCalls(line, seen)),
    ["mcp__sentry__get_issue"],
  );
});
