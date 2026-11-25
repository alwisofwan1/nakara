import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runTurn } from "../harness/claude.ts";
import { hostEnv } from "./env.ts";

const SOURCE = {
  PATH: "/bin",
  HOME: "/h",
  LC_ALL: "C.UTF-8",
  NAKARA_TELEGRAM_BOT_TOKEN: "telegram",
  NAKARA_AGENT_GH_TOKEN: "gh",
  GH_TOKEN: "gh",
  AWS_SECRET_ACCESS_KEY: "aws",
  CLAUDE_CODE_OAUTH_TOKEN: "claude",
  CLAUDE_QWEN_GATEWAY_TOKEN: "qwen",
  OPENAI_API_KEY: "openai",
};
const BASICS = { PATH: "/bin", HOME: "/h", LC_ALL: "C.UTF-8" };

test("a host process gets the basics and only its own harness's credential", () => {
  assert.deepEqual(hostEnv(undefined, SOURCE), BASICS);
  assert.deepEqual(hostEnv("claude", SOURCE), {
    ...BASICS,
    CLAUDE_CODE_OAUTH_TOKEN: "claude",
  });
  assert.deepEqual(hostEnv("qwen", SOURCE), {
    ...BASICS,
    CLAUDE_QWEN_GATEWAY_TOKEN: "qwen",
  });
  assert.deepEqual(hostEnv("codex", SOURCE), {
    ...BASICS,
    OPENAI_API_KEY: "openai",
  });
});

test("a local harness does not inherit Nakara's environment", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-env-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "claude");
  await writeFile(fake, `#!/bin/sh\nenv > "${dir}/env"\n`);
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), "");
  process.env.NAKARA_TELEGRAM_BOT_TOKEN = "telegram-secret";
  t.after(() => delete process.env.NAKARA_TELEGRAM_BOT_TOKEN);

  await runTurn(
    {
      harness: "claude",
      model: undefined,
      cwd: dir,
      prompt: "do it",
      systemPromptFile: join(dir, "system.md"),
      permissionMode: "bypassPermissions",
      idleTimeoutMs: 60_000,
      logPath: join(dir, "log"),
      env: { NAKARA_ITEM: "7" },
    },
    { claude: fake, qwen: fake, codex: fake, codexHome: dir },
  );

  const env = await readFile(join(dir, "env"), "utf8");
  assert.doesNotMatch(env, /telegram-secret/);
  assert.match(env, /^NAKARA_ITEM=7$/m);
  assert.match(env, /^PATH=/m);
});
