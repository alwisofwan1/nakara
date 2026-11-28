import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HttpBindings } from "@hono/node-server";

import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { verifyLogPath } from "../orchestrator/verify.ts";
import { internalDir } from "../runner/workspace.ts";
import { createApp } from "./test-support.ts";

test("the run page links the verify output Nakara kept beside the run's log", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "nakara-verify-log-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig({
    NAKARA_DATA_DIR: dir,
    NAKARA_BACKUP_DIR: join(dir, "backups"),
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const item = store.createItem({
    title: "Verify",
    request: "Verify it",
    source: "manual",
  });
  const run = (logPath: string) => {
    const r = store.createRun({
      item_id: item.id,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "Build it",
      session_id: null,
      status: "running",
    });
    store.finishRun(r.id, {
      status: "succeeded",
      result: "Done",
      error: null,
      cost_usd: 0,
      num_turns: null,
      duration_ms: 1,
      session_id: null,
      log_path: logPath,
    });
    return r;
  };
  const logs = join(internalDir(config.workDir, item.id), "logs");
  mkdirSync(logs, { recursive: true });
  const verified = run(join(logs, "run-1.jsonl"));
  writeFileSync(
    verifyLogPath(join(logs, "run-1.jsonl")),
    "$ npm test\nnot ok 1\n",
  );
  const plain = run(join(logs, "run-2.jsonl"));

  const registry = new FactoryRegistry(store, config);
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "token",
  );
  const bindings = {
    incoming: { socket: { remoteAddress: "127.0.0.1" } },
  } as HttpBindings;
  const get = (path: string) => app.request(path, {}, bindings);

  const detail = async (id: number) =>
    ((await (await get(`/api/runs/${id}`)).json()) as { verifyLog: boolean })
      .verifyLog;
  assert.equal(await detail(verified.id), true);
  assert.equal(await detail(plain.id), false);
  const response = await get(`/api/runs/${verified.id}/verify-log`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/plain/);
  assert.equal(await response.text(), "$ npm test\nnot ok 1\n");
  assert.equal((await get(`/api/runs/${plain.id}/verify-log`)).status, 404);
  assert.equal((await get("/api/runs/999/verify-log")).status, 404);
});
