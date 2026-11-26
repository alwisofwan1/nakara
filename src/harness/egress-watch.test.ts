import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runTurn } from "./claude.ts";
import { EGRESS_REFUSALS, EgressWatch, refusedHost } from "./egress-watch.ts";

// What codex printed in run 596 (#21), and what the egress proxy answers itself.
const CODEX_REFUSAL =
  "Reconnecting... 2/5 (HTTP CONNECT failed with status 403, url: wss://chatgpt.com/backend-api/codex/responses)";

test("refusedHost reads the refused host from a harness's proxy errors", () => {
  assert.equal(refusedHost(CODEX_REFUSAL), "chatgpt.com");
  assert.equal(
    refusedHost("api.openai.com:443 is not on the egress allowlist"),
    "api.openai.com",
  );
  assert.equal(
    refusedHost(
      "tunneling socket could not be established, statusCode=403 (CONNECT api.anthropic.com:443)",
    ),
    "api.anthropic.com",
  );
  // Not a proxy refusal, or no host to name.
  assert.equal(refusedHost("GET https://chatgpt.com/ returned 403"), null);
  assert.equal(refusedHost("Reconnecting... 1/5 (stream closed)"), null);
  assert.equal(refusedHost("Proxy response (403) !== 200"), null);
});

test("refusals of the model host end the run, naming the host and the egress list", () => {
  const reasons: string[] = [];
  const watch = new EgressWatch(
    "codex",
    ["api.anthropic.com", "github.com"],
    (reason) => reasons.push(reason),
  );
  for (let i = 1; i < EGRESS_REFUSALS; i++) watch.line(CODEX_REFUSAL);
  assert.deepEqual(reasons, []);
  watch.line(CODEX_REFUSAL);
  watch.line(CODEX_REFUSAL);
  assert.deepEqual(reasons, [
    `The harness cannot reach its model: the egress proxy refused chatgpt.com (${EGRESS_REFUSALS} times). The runner's egress allows only: api.anthropic.com, github.com. Add chatgpt.com to the runner's egress.allow, or give the agent a harness its runner can reach.`,
  ]);
  assert.equal(watch.blocked, reasons[0]);
});

test("a refusal of another host, or one the model answers past, does not end the run", async () => {
  const reasons: string[] = [];
  const watch = new EgressWatch(
    "claude",
    undefined,
    (r) => reasons.push(r),
    30,
  );
  // Not claude's model host: an agent's own fetch is its business.
  for (let i = 0; i < 5; i++)
    watch.line("example.com:443 is not on the egress allowlist");
  watch.line("api.anthropic.com:443 is not on the egress allowlist");
  watch.progress();
  for (let i = 1; i < EGRESS_REFUSALS; i++)
    watch.line("api.anthropic.com:443 is not on the egress allowlist");
  watch.progress();
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(reasons, []);
});

test("one refusal the model never answers past ends the run after the grace period", async () => {
  const reasons: string[] = [];
  const watch = new EgressWatch("codex", undefined, (r) => reasons.push(r), 30);
  watch.line(CODEX_REFUSAL);
  assert.deepEqual(reasons, []);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.match(reasons[0] ?? "", /refused chatgpt\.com \(1 time\)\./);
});

test("a codex turn whose model host the proxy refuses fails at once instead of waiting for network", {
  timeout: 10_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-egress-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // codex behind a proxy that refuses chatgpt.com: it reconnects, then waits.
  const fake = join(dir, "codex");
  await writeFile(
    fake,
    `#!/bin/sh
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t-blocked"}'
for i in 1 2 3 4 5; do
  echo '{"type":"error","message":"${CODEX_REFUSAL.replace("2/5", "$i/5")}"}'
  sleep 0.05
done
echo "Reconnecting... waiting for network" >&2
while :; do sleep 0.05; done
`,
  );
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), "");
  const started = Date.now();
  const out = await runTurn(
    {
      harness: "codex",
      model: undefined,
      cwd: dir,
      prompt: "review it",
      systemPromptFile: join(dir, "system.md"),
      permissionMode: "bypassPermissions",
      // Without the watch, the run would sit here for the whole idle timeout.
      idleTimeoutMs: 60 * 60_000,
      logPath: join(dir, "log"),
    },
    {
      claude: "claude",
      qwen: "qwen",
      codex: fake,
      codexHome: join(dir, "codex-home"),
    },
  );
  assert.equal(out.ok, false);
  assert.equal(out.sessionId, "t-blocked");
  assert.match(
    out.error ?? "",
    /^The harness cannot reach its model: the egress proxy refused chatgpt\.com \(3 times\)\./,
  );
  assert.ok(Date.now() - started < 8_000);
});
