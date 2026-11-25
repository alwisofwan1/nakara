import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runTurn } from "./claude.ts";

// Each fake reports its session, then a second one, which must not fire again.
const FAKES = {
  claude: [
    '{"type":"system","subtype":"init","session_id":"s-claude"}',
    '{"type":"system","subtype":"init","session_id":"s-other"}',
    '{"type":"result","subtype":"success","result":"done","session_id":"s-claude","total_cost_usd":0}',
  ],
  codex: [
    '{"type":"thread.started","thread_id":"s-codex"}',
    '{"type":"thread.started","thread_id":"s-other"}',
    '{"type":"turn.completed","usage":{"input_tokens":1}}',
  ],
} as const;

for (const [harness, lines] of Object.entries(FAKES)) {
  test(`${harness} turns report their session once, before the turn ends`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), `nakara-session-${harness}-`));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const fake = join(dir, harness);
    await writeFile(
      fake,
      `#!/bin/sh\ncat > /dev/null\n${lines.map((l) => `echo '${l}'`).join("\n")}\n`,
    );
    await chmod(fake, 0o755);
    await writeFile(join(dir, "system.md"), "");
    const sessions: string[] = [];
    let ended = false;
    const outcome = await runTurn(
      {
        harness: harness as "claude" | "codex",
        model: undefined,
        cwd: dir,
        prompt: "do it",
        systemPromptFile: join(dir, "system.md"),
        permissionMode: "bypassPermissions",
        idleTimeoutMs: 10_000,
        logPath: join(dir, "log"),
        onSession: (id) => {
          assert.equal(ended, false);
          sessions.push(id);
        },
      },
      {
        claude: fake,
        qwen: "qwen",
        codex: fake,
        codexHome: join(dir, "home"),
      },
    );
    ended = true;
    assert.equal(outcome.ok, true);
    assert.deepEqual(sessions, [`s-${harness}`]);
  });
}
