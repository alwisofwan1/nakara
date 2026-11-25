import assert from "node:assert/strict";
import { test } from "node:test";

import { envSecrets, Logger } from "./log.ts";

const capture = (secrets?: string[]) => {
  const lines: string[] = [];
  const log = new Logger({
    level: "info",
    write: (line) => lines.push(line),
    secrets,
  });
  return { log, lines, parsed: () => lines.map((l) => JSON.parse(l)) };
};

test("a log line is one JSON object with the level, event and bound ids", () => {
  const { log, lines, parsed } = capture([]);
  log
    .child({ item_id: 7 })
    .child({ run_id: 42, agent: "implement" })
    .warn("run.finished", { status: "failed" });
  log.debug("skipped below the level");
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0] ?? "", /\n/);
  const [line] = parsed();
  assert.equal(typeof line.time, "string");
  assert.deepEqual(
    { ...line, time: undefined },
    {
      time: undefined,
      level: "warn",
      event: "run.finished",
      item_id: 7,
      run_id: 42,
      agent: "implement",
      status: "failed",
    },
  );
});

test("GH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN and the Telegram token never reach the log", () => {
  const env = {
    GH_TOKEN: "ghp_0123456789abcdefghijABCDEFGHIJ012345",
    CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-Abc_def-0123456789abcdefghij",
    NAKARA_TELEGRAM_BOT_TOKEN: "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345",
    // Not secret-looking names: kept.
    NAKARA_PORT: "7788",
  };
  const secrets = Object.values(env).slice(0, 3);
  assert.deepEqual(envSecrets(env), secrets);

  // By value: the logger knows the environment's secrets.
  const known = capture(envSecrets(env));
  // By shape: a logger that does not know them still recognises them.
  const unknown = capture([]);
  for (const { log } of [known, unknown]) {
    log.error("harness.failed", {
      error: new Error(
        `gh: bad credentials ${env.GH_TOKEN}; claude: ${env.CLAUDE_CODE_OAUTH_TOKEN}`,
      ),
      url: `https://api.telegram.org/bot${env.NAKARA_TELEGRAM_BOT_TOKEN}/getUpdates`,
      nested: { args: ["-H", `Authorization: Bearer ${env.GH_TOKEN}`] },
    });
    // Fields named like a credential are dropped whatever their value.
    log.info("config", { GH_TOKEN: "short", telegram: { token: "x" } });
  }
  for (const { lines, parsed } of [known, unknown]) {
    const out = lines.join("\n");
    for (const secret of secrets) assert.ok(!out.includes(secret), out);
    assert.ok(!out.includes("AAH-abcdefghij"), out);
    assert.match(out, /\[redacted\]/);
    const [failed, config] = parsed();
    assert.equal(
      failed.url,
      "https://api.telegram.org/bot[redacted]/getUpdates",
    );
    assert.equal(config.GH_TOKEN, "[redacted]");
    assert.equal(config.telegram.token, "[redacted]");
  }
});

test("a token learnt after startup is redacted by every child logger", () => {
  const { log, lines } = capture([]);
  const child = log.child({ item_id: 1 });
  log.addSecret("web-token-0123456789");
  child.info("request", { detail: "nakara=web-token-0123456789" });
  assert.ok(!lines[0]?.includes("web-token-0123456789"));
});

test("prompts and agent inputs are logged by size only", () => {
  const { log, parsed } = capture([]);
  log.info("run.started", {
    prompt: "Implement the secret plan",
    input: "Build it",
    brief: { text: "x" },
  });
  const [line] = parsed();
  assert.equal(line.prompt, "[25 chars]");
  assert.equal(line.input, "[8 chars]");
  assert.equal(line.brief, "[omitted]");
});

test("token counts are not mistaken for credentials", () => {
  const { log, parsed } = capture([]);
  log.info("usage", {
    input_tokens: 12,
    output_tokens: 3,
    max_tokens: 4096,
    api_key: "short",
    NAKARA_AGENT_GH_TOKEN: "short",
  });
  const [line] = parsed();
  assert.deepEqual(
    [line.input_tokens, line.output_tokens, line.max_tokens],
    [12, 3, 4096],
  );
  assert.equal(line.api_key, "[redacted]");
  assert.equal(line.NAKARA_AGENT_GH_TOKEN, "[redacted]");
});
