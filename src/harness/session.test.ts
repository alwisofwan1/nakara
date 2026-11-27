import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("a turn with a gh guard runs with the guard's gh first on its PATH", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-session-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, "claude");
  // The harness reports which gh it would run.
  await writeFile(
    fake,
    `#!/bin/sh\ncat > /dev/null\necho "{\\"type\\":\\"result\\",\\"subtype\\":\\"success\\",\\"result\\":\\"$(command -v gh)\\",\\"session_id\\":\\"s\\",\\"total_cost_usd\\":0}"\n`,
  );
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), "");
  const guard = join(dir, "run-1.gh");
  const outcome = await runTurn(
    {
      harness: "claude",
      model: undefined,
      cwd: dir,
      prompt: "do it",
      systemPromptFile: join(dir, "system.md"),
      permissionMode: "bypassPermissions",
      idleTimeoutMs: 10_000,
      logPath: join(dir, "log"),
      ghGuard: guard,
    },
    { claude: fake, qwen: "qwen", codex: fake, codexHome: join(dir, "home") },
  );
  assert.equal(outcome.ok, true);
  assert.equal(outcome.result, join(guard, "gh"));
});

test("in a container the gh guard is mounted read-only and put first on the image's PATH", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-session-guard-docker-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const argsFile = join(dir, "docker-args.json");
  const docker = join(dir, "docker");
  await writeFile(
    docker,
    `#!${process.execPath}
const fs = require("node:fs");
if (process.argv[2] === "run") fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdin.resume();
process.stdin.on("end", () => console.log('{"type":"result","subtype":"success","result":"ok","session_id":"s","total_cost_usd":0}'));
`,
  );
  await chmod(docker, 0o755);
  process.env.PATH = `${dir}:${oldPath}`;
  const fake = join(dir, "claude");
  await writeFile(fake, "#!/bin/sh\n");
  await chmod(fake, 0o755);
  await writeFile(join(dir, "system.md"), "");
  const guard = join(dir, "run-1.gh");
  const outcome = await runTurn(
    {
      harness: "claude",
      model: undefined,
      cwd: dir,
      prompt: "do it",
      systemPromptFile: join(dir, "system.md"),
      permissionMode: "bypassPermissions",
      idleTimeoutMs: 10_000,
      logPath: join(dir, "log"),
      ghGuard: guard,
      docker: { image: "nakara-agent", mounts: [], home: join(dir, "home") },
    },
    { claude: fake, qwen: "qwen", codex: fake, codexHome: join(dir, "home") },
  );
  assert.equal(outcome.ok, true);
  const args = JSON.parse(await readFile(argsFile, "utf8")) as string[];
  assert.ok(args.includes(`${guard}:${guard}:ro`));
  const inner = args.slice(args.indexOf("nakara-agent") + 1);
  assert.deepEqual(inner.slice(0, 5), [
    "/bin/sh",
    "-c",
    'PATH="$0:$PATH" exec "$@"',
    guard,
    "claude",
  ]);
  // The wrapper keeps the image's PATH after the guard.
  const which = spawnSync(
    inner[0] ?? "",
    [...inner.slice(1, 4), "sh", "-c", 'command -v gh; echo "$PATH"'],
    { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } },
  );
  assert.deepEqual(which.stdout.trim().split("\n"), [
    join(guard, "gh"),
    `${guard}:/usr/bin:/bin`,
  ]);
  // In the container the guard runs with the image's node.
  assert.match(await readFile(join(guard, "gh"), "utf8"), /exec "node" /);
});
