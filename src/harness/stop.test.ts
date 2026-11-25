import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { KILL_GRACE_MS, runTurn, type TurnRequest } from "./claude.ts";

async function fixture(t: TestContext, claude: string) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-stop-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "claude");
  await writeFile(fake, `#!/bin/sh\n${claude}\n`);
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), "");
  const controller = new AbortController();
  const request: TurnRequest = {
    harness: "claude",
    model: undefined,
    cwd: dir,
    prompt: "do it",
    systemPromptFile: join(dir, "system.md"),
    permissionMode: "bypassPermissions",
    idleTimeoutMs: 60_000,
    logPath: join(dir, "log"),
    signal: controller.signal,
  };
  const bins = { claude: fake, qwen: fake, codex: fake, codexHome: dir };
  return { dir, controller, request, bins };
}

const until = async (done: () => boolean) => {
  while (!done()) await new Promise((resolve) => setTimeout(resolve, 20));
};

test("stopping a docker run removes its container by name", {
  timeout: 10_000,
}, async (t) => {
  const { dir, controller, request, bins } = await fixture(t, "");
  // A docker CLI that ignores SIGTERM and runs until its container is removed.
  const calls = join(dir, "calls");
  await writeFile(
    join(dir, "docker"),
    `#!/bin/sh
echo "$*" >> "${calls}"
if [ "$1" = run ]; then
  trap '' TERM
  while [ "$1" != --name ]; do shift; done
  touch "${dir}/container-$2"
  cat > /dev/null
  while [ -f "${dir}/container-$2" ]; do sleep 0.05; done
  exit 137
fi
rm -f "${dir}/container-$3"
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const started = Date.now();
  const turn = runTurn(
    { ...request, docker: { image: "img", mounts: [dir], home: dir } },
    bins,
  );
  await until(() => existsSync(calls));
  const name = /--name (\S+)/.exec(await readFile(calls, "utf8"))?.[1];
  assert.match(name ?? "", /^nakara-/);
  await until(() => existsSync(join(dir, `container-${name}`)));
  controller.abort();
  const outcome = await turn;
  assert.equal(outcome.error, "Cancelled.");
  assert.ok(Date.now() - started < KILL_GRACE_MS, "removed before SIGKILL");
  assert.ok(!existsSync(join(dir, `container-${name}`)));
  assert.ok(
    (await readFile(calls, "utf8")).includes(`rm --force ${name}`),
    "the container is removed by name",
  );
});

test("a local run that ignores SIGTERM is killed after the grace period", {
  timeout: KILL_GRACE_MS + 5_000,
}, async (t) => {
  const { dir, controller, request, bins } = await fixture(
    t,
    `trap '' TERM\ncat > /dev/null\ntouch "$PWD/started"\nwhile :; do sleep 0.05; done`,
  );
  const turn = runTurn(request, bins);
  await until(() => existsSync(join(dir, "started")));
  controller.abort();
  const outcome = await turn;
  assert.equal(outcome.ok, false);
  assert.equal(outcome.error, "Cancelled.");
});

test("a run stopped before it starts never spawns", async (t) => {
  const { dir, controller, request, bins } = await fixture(
    t,
    `touch "$PWD/started"`,
  );
  controller.abort();
  const outcome = await runTurn(request, bins);
  assert.equal(outcome.error, "Cancelled.");
  assert.ok(!existsSync(join(dir, "started")));
});

// One message streamed as two content blocks, each repeating its usage.
const ASSISTANT = (text: string) =>
  JSON.stringify({
    type: "assistant",
    message: {
      id: "msg_1",
      model: "claude-opus-5-5",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1000, output_tokens: 2000 },
    },
  });

test("a claude run the idle timeout stops records the cost of its streamed usage", async (t) => {
  const { request, bins } = await fixture(
    t,
    `cat > /dev/null\necho '${ASSISTANT("working")}'\necho '${ASSISTANT("still working")}'\nexec sleep 30`,
  );
  const outcome = await runTurn({ ...request, idleTimeoutMs: 300 }, bins);
  assert.equal(outcome.ok, false);
  // 1000 input and 2000 output tokens at $4/$20 per million, counted once.
  assert.ok(Math.abs(outcome.costUsd - 0.044) < 1e-9, String(outcome.costUsd));
  assert.match(
    outcome.error ?? "",
    /No output for .* estimated from the streamed token usage/,
  );
});

test("a qwen run without a result still costs nothing", async (t) => {
  const { request, bins } = await fixture(
    t,
    `cat > /dev/null\necho '${ASSISTANT("working")}'\nexit 1`,
  );
  const outcome = await runTurn({ ...request, harness: "qwen" }, bins);
  assert.equal(outcome.ok, false);
  assert.equal(outcome.costUsd, 0);
});
