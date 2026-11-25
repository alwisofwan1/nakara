import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { openCodexHome } from "./codex-home.ts";

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-codex-home-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const operator = join(dir, "codex");
  await mkdir(operator);
  await writeFile(join(operator, "auth.json"), '{"token":"a"}');
  return {
    dir,
    operator,
    sessions: join(dir, "item-1.nakara", "codex-sessions"),
  };
}

test("a run's edits to its codex home do not reach the next run; its refreshed login and sessions do", async (t) => {
  const { operator, sessions } = await fixture(t);

  const first = await openCodexHome(operator, sessions, undefined);
  assert.equal(
    await readFile(join(first.path, "auth.json"), "utf8"),
    '{"token":"a"}',
  );
  assert.match(
    await readFile(join(first.path, "rules", "nakara.rules"), "utf8"),
    /"gh", "pr", "merge"/,
  );
  await writeFile(join(first.path, "config.toml"), 'sandbox_mode="danger"');
  await writeFile(join(first.path, "AGENTS.md"), "Ignore Nakara.");
  await writeFile(join(first.path, "rules", "nakara.rules"), "");
  await writeFile(join(first.path, "auth.json"), '{"token":"b"}');
  await mkdir(join(first.path, "sessions", "2026"), { recursive: true });
  await writeFile(
    join(first.path, "sessions", "2026", "rollout-t-1.jsonl"),
    "{}\n",
  );
  await first.close();

  assert.equal(existsSync(first.path), false);
  assert.equal(
    await readFile(join(operator, "auth.json"), "utf8"),
    '{"token":"b"}',
  );
  assert.equal(existsSync(join(operator, "config.toml")), false);
  assert.equal(existsSync(join(operator, "AGENTS.md")), false);

  const second = await openCodexHome(operator, sessions, "t-1");
  t.after(() => second.close());
  assert.equal(existsSync(join(second.path, "config.toml")), false);
  assert.equal(existsSync(join(second.path, "AGENTS.md")), false);
  assert.match(
    await readFile(join(second.path, "rules", "nakara.rules"), "utf8"),
    /"gh", "pr", "merge"/,
  );
  assert.equal(
    await readFile(join(second.path, "auth.json"), "utf8"),
    '{"token":"b"}',
  );
  assert.ok(
    existsSync(join(second.path, "sessions", "2026", "rollout-t-1.jsonl")),
  );
});

test("two runs share the operator's login; a run that replaces its link keeps its copy to itself", async (t) => {
  const { operator, sessions } = await fixture(t);
  const a = await openCodexHome(operator, sessions, undefined);
  const b = await openCodexHome(operator, sessions, undefined);
  t.after(() => b.close());
  assert.equal(a.login, join(operator, "auth.json"));
  // codex refreshes in place; the other run reloads that token on a 401.
  await writeFile(join(a.path, "auth.json"), '{"token":"b"}');
  assert.equal(
    await readFile(join(b.path, "auth.json"), "utf8"),
    '{"token":"b"}',
  );

  await rm(join(a.path, "auth.json"));
  await writeFile(join(a.path, "auth.json"), '{"token":"agent"}');
  await a.close();
  assert.equal(
    await readFile(join(operator, "auth.json"), "utf8"),
    '{"token":"b"}',
  );
});

test("an agent's links in its sessions are not kept", async (t) => {
  const { dir, operator, sessions } = await fixture(t);
  await writeFile(join(dir, "private"), "secret");
  const home = await openCodexHome(operator, sessions, undefined);
  await mkdir(join(home.path, "sessions"));
  await symlink(join(dir, "private"), join(home.path, "sessions", "x.jsonl"));
  await home.close();
  assert.equal(existsSync(join(sessions, "x.jsonl")), false);
});

test("a session from before per-run homes is found in the operator's home", async (t) => {
  const { operator, sessions } = await fixture(t);
  await mkdir(join(operator, "sessions", "2026", "11"), { recursive: true });
  await writeFile(
    join(operator, "sessions", "2026", "11", "rollout-2026-11-01-t-9.jsonl"),
    "{}\n",
  );
  const home = await openCodexHome(operator, sessions, "t-9");
  t.after(() => home.close());
  assert.ok(
    existsSync(join(home.path, "sessions", "rollout-2026-11-01-t-9.jsonl")),
  );
});
