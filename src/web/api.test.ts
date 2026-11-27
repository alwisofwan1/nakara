import assert from "node:assert/strict";
import {
  appendFile,
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
import type { HttpBindings } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { HARNESS_FALLBACK, loadDefinition } from "../definition/load.ts";
import { GithubPoller } from "../intake/github.ts";
import { ActionApplier } from "../orchestrator/action-applier.ts";
import {
  GH_PULL_REQUESTS,
  PullRequestGate,
} from "../orchestrator/pull-request-gate.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { internalDir } from "../runner/workspace.ts";
import type { ActivityDto, ItemDetailDto } from "./api.ts";
import { createApp } from "./test-support.ts";
import { readStatus } from "./status.ts";

/** Where a run of the item logs: inside its internal directory, the only place the API serves logs from. */
async function internalLog(workDir: string, itemId: number) {
  const logs = join(internalDir(workDir, itemId), "logs");
  await mkdir(logs, { recursive: true });
  return join(logs, "run-1.jsonl");
}

const bindings = (peer = "127.0.0.1") =>
  ({ incoming: { socket: { remoteAddress: peer } } }) as HttpBindings;
function fixture(basePath = "", dataDir?: string) {
  const config = loadConfig({
    ...(dataDir ? { NAKARA_DATA_DIR: dataDir } : {}),
    NAKARA_BASE_PATH: basePath,
    NAKARA_ALLOW: "192.0.2.1",
    NAKARA_TELEGRAM_BOT_TOKEN: "secret",
    NAKARA_TELEGRAM_CHAT_ID: "123",
    // Never read the snapshots of a real installation.
    NAKARA_BACKUP_DIR: join(tmpdir(), `nakara-api-backups-${process.pid}`),
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, config);
  const factory = registry.default;
  const poller = new GithubPoller(factory);
  return {
    config,
    store,
    registry,
    factory,
    poller,
    app: createApp(registry, poller, config, "token"),
  };
}

test("status projection exposes poll, configuration and agent slots without secrets or writes", async () => {
  const { store, poller, config } = fixture();
  const options = {
    telegramConfigured: true,
    concurrency: config.concurrency,
    factories: [{ slug: "default", loaded: true, errors: 0, repositories: 2 }],
    backup: config.backup,
  };
  assert.deepEqual(readStatus(store, options), {
    factories: options.factories,
    github: null,
    telegram: { configured: true },
    slots: { busy: 0, total: 2 },
    inbox: 0,
    backup: { at: null, intervalHours: 24 },
  });
  const item = store.createItem({
    title: "Status",
    request: "Test",
    source: "manual",
  });
  for (const role of ["agent", "foreman"] as const) {
    store.createRun({
      item_id: item.id,
      role,
      agent: role,
      agent_type: role === "agent" ? "IMPLEMENT" : "FOREMAN",
      harness: "claude",
      model: null,
      input: "",
      session_id: null,
      status: "running",
    });
  }
  store.addApproval(item.id, "question", "Question", null);
  poller.lastPoll = { at: "2026-10-21T10:00:00Z", error: "Offline" };
  const dto = readStatus(store, options);
  assert.deepEqual(dto, {
    factories: options.factories,
    github: poller.lastPoll,
    telegram: { configured: true },
    slots: { busy: 1, total: 2 },
    inbox: 1,
    backup: { at: null, intervalHours: 24 },
  });
  assert.ok(!JSON.stringify(dto).includes("secret"));
  assert.deepEqual(readStatus(store, options), dto);
  store.db.close();
});

for (const base of ["", "/proxy/7788"]) {
  test(`API, SPA fallback and security at ${base || "/"}`, async () => {
    const { app, store } = fixture(base);
    const request = (path: string, init: RequestInit = {}, peer?: string) =>
      app.request(`http://localhost${path}`, init, bindings(peer));
    for (const path of new Set(["/api/status", `${base}/api/status`])) {
      const response = await request(path);
      assert.equal(response.status, 200);
      // The fixture never loads a definition.
      assert.deepEqual(await response.json(), {
        factories: [
          { slug: "default", loaded: false, errors: 0, repositories: 0 },
        ],
        github: null,
        telegram: { configured: true },
        slots: { busy: 0, total: 2 },
        inbox: 0,
        backup: { at: null, intervalHours: 24 },
      });
    }
    for (const [peer, headers, status, code] of [
      ["192.0.2.2", {}, 403, "forbidden"],
      ["192.0.2.1", { authorization: "" }, 401, "unauthorized"],
      ["127.0.0.1", { authorization: "" }, 401, "unauthorized"],
      ["127.0.0.1", { host: "evil.example" }, 403, "forbidden"],
      [
        "127.0.0.1",
        { origin: "https://evil.example", host: "localhost:7788" },
        403,
        "cross_origin",
      ],
      [
        "127.0.0.1",
        { origin: "null", host: "localhost:7788" },
        403,
        "cross_origin",
      ],
    ] as const) {
      for (const endpoint of ["status", "f/default/items", "events"]) {
        const response = await request(
          `${base}/api/${endpoint}`,
          { headers },
          peer,
        );
        assert.equal(response.status, status);
        assert.equal(
          ((await response.json()) as { error: { code: string } }).error.code,
          code,
        );
      }
    }
    assert.equal(
      (
        await request(
          `${base}/api/status`,
          { headers: { cookie: "nakara_token=token" } },
          "192.0.2.1",
        )
      ).status,
      200,
    );
    const item = store.createItem({
      title: "Listed",
      request: "Test",
      source: "manual",
    });
    store.addApproval(item.id, "question", "Which?", null);
    const items = await request(`${base}/api/f/default/items`);
    assert.equal(items.status, 200);
    const listed = (await items.json()) as ActivityDto;
    assert.deepEqual(
      listed.items.map((view) => [view.id, view.group, view.needsYou.kind]),
      [[item.id, "triage", "question"]],
    );
    assert.ok(!("request" in (listed.items[0] ?? {})));
    const missing = await request(`${base}/api/missing`);
    assert.equal(missing.status, 404);
    assert.equal(
      ((await missing.json()) as { error: { code: string } }).error.code,
      "not_found",
    );
    for (const path of [
      "/",
      "/f/default/activity",
      "/items/99999",
      "/future-client-route",
    ]) {
      const response = await request(`${base}${path}`);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.ok(html.includes(`"basePath":"${base}"`));
      assert.ok(html.includes(`./assets/`));
      assert.ok(html.includes(`<base href="${base}/">`));
    }
    assert.equal((await request(`${base}/assets/missing.js`)).status, 404);
    store.db.close();
  });
}

test("SSE sends invalidations from real poller writes and cleans up on disconnect", {
  timeout: 5000,
}, async () => {
  const { app, store, poller, factory } = fixture();
  await factory.reloadDefinition();
  assert.ok(factory.definition);
  // Exercise poll() itself without contacting GitHub or dispatching work.
  factory.definition.automations = [];
  const response = await app.request("/api/events", {}, bindings());
  assert.match(
    response.headers.get("content-type") ?? "",
    /text\/event-stream/,
  );
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  const reader = response.body?.getReader();
  assert.ok(reader);
  const decoder = new TextDecoder();
  // Every connection revalidates each resource before streaming changes.
  let initial = "";
  while (!initial.includes('"type":"runs"'))
    initial += decoder.decode((await reader.read()).value);
  assert.match(initial, /data: {"type":"status","id":"global"}/);
  assert.match(initial, /data: {"type":"runs","id":"global"}/);
  assert.match(initial, /data: {"type":"items","id":"global"}/);
  await poller.poll();
  assert.ok(poller.lastPoll?.at);
  const event = decoder.decode((await reader.read()).value);
  assert.match(event, /data: {"type":"status","id":"global"}/);
  assert.ok(!event.includes(poller.lastPoll.at));
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.changes.listenerCount("change"), 0);
  store.db.close();
});

test("SSE heartbeat arrives at 15 seconds and reconnect revalidates", async (t) => {
  const { app, store } = fixture();
  t.mock.timers.enable({ apis: ["setInterval"] });
  const response = await app.request("/api/events", {}, bindings());
  const reader = response.body?.getReader();
  assert.ok(reader);
  let initial = "";
  while (!initial.includes('"type":"runs"'))
    initial += new TextDecoder().decode((await reader.read()).value);
  t.mock.timers.tick(15_000);
  assert.equal(
    new TextDecoder().decode((await reader.read()).value),
    ": heartbeat\n\n",
  );
  await reader.cancel();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.changes.listenerCount("change"), 0);
  const reconnect = await app.request("/api/events", {}, bindings());
  const next = reconnect.body?.getReader();
  assert.ok(next);
  assert.match(
    new TextDecoder().decode((await next.read()).value),
    /"type":"status"/,
  );
  await next.cancel();
  store.db.close();
});

test("terminal item stages invalidate the pending inbox count", async () => {
  const { store, config } = fixture();
  const item = store.createItem({
    title: "Inbox",
    request: "Test",
    source: "manual",
  });
  store.addApproval(item.id, "question", "Continue?", null);
  await new Promise((resolve) => setImmediate(resolve));
  const events: unknown[] = [];
  store.changes.on("change", (event) => events.push(event));
  const options = {
    telegramConfigured: false,
    concurrency: 2,
    factories: [{ slug: "default", loaded: true, errors: 0, repositories: 1 }],
    backup: config.backup,
  };
  assert.equal(readStatus(store, options).inbox, 1);
  store.updateItem(item.id, { stage: "complete" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(readStatus(store, options).inbox, 0);
  assert.deepEqual(events, [
    { type: "status", id: "global" },
    { type: "items", id: "global" },
    { type: "item", id: String(item.id) },
  ]);
  assert.equal(store.changes.getMaxListeners(), 0);
  store.db.close();
});

test("run detail and follow-up endpoints return DTOs, validation errors and policy refusals", async () => {
  const { app, store, factory } = fixture();
  await factory.reloadDefinition();
  // Queue only: starting the agent would clone repositories and spawn a harness.
  factory.pump = async () => {};
  const request = (path: string, init: RequestInit = {}) =>
    app.request(path, init, bindings());
  const item = store.createItem({
    title: "Run page",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, { stage: "reviewing", review_count: 1 });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "codex",
    model: null,
    input: "Build it",
    session_id: "session-1",
    status: "succeeded",
  });
  const detail = await request(`/api/runs/${run.id}`);
  assert.equal(detail.status, 200);
  const dto = (await detail.json()) as {
    runner: string;
    docker: boolean;
    followUp: { allowed: boolean; countsAsRevision: boolean };
  };
  assert.equal(dto.runner, "docker-browser · nakara-agent-browser");
  assert.equal(dto.docker, true);
  assert.deepEqual(
    { allowed: dto.followUp.allowed, counts: dto.followUp.countsAsRevision },
    { allowed: true, counts: true },
  );
  const error = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error.code;
  assert.equal(await error(await request("/api/runs/999")), "not_found");
  assert.equal(await error(await request("/api/runs/abc")), "invalid");

  const post = (id: number, body: unknown) =>
    request(`/api/runs/${id}/follow-up`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const empty = await post(run.id, { message: "  " });
  assert.equal(empty.status, 400);
  assert.equal(await error(empty), "invalid");
  assert.equal((await post(999, { message: "Hi" })).status, 404);
  const queued = await post(run.id, { message: "Fix the finding" });
  assert.equal(queued.status, 202);
  const { run: next } = (await queued.json()) as { run: { id: number } };
  assert.equal(store.runById(next.id)?.input, "Fix the finding");
  assert.equal(store.item(item.id)?.revision_count, 1);
  store.cancelQueuedRuns(item.id);
  store.updateItem(item.id, { revision_count: 2 });
  const capped = await post(run.id, { message: "Again" });
  assert.equal(capped.status, 409);
  assert.equal(await error(capped), "policy");
  store.db.close();
});

test("stop endpoint stops running runs and refuses the rest with 409", async () => {
  const { app, store, factory } = fixture();
  factory.pump = async () => {};
  const stop = (id: number | string) =>
    app.request(`/api/runs/${id}/stop`, { method: "POST" }, bindings());
  const error = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error;
  const item = store.createItem({
    title: "Stop",
    request: "Test",
    source: "manual",
  });
  const run = (status: "queued" | "running") =>
    store.createRun({
      item_id: item.id,
      role: "foreman",
      agent: "foreman",
      agent_type: "FOREMAN",
      harness: "claude",
      model: null,
      input: "Turn",
      session_id: null,
      status,
    });
  const running = run("running");
  const stopped = await stop(running.id);
  assert.equal(stopped.status, 202);
  assert.deepEqual(await stopped.json(), { run: { id: running.id } });
  assert.equal(store.runById(running.id)?.status, "cancelled");
  assert.equal(store.item(item.id)?.stage, "intake");

  const again = await stop(running.id);
  assert.equal(again.status, 409);
  assert.deepEqual(await error(again), {
    code: "policy",
    message: "Only a running run can be stopped. This run is cancelled.",
  });
  assert.equal((await stop(run("queued").id)).status, 409);
  assert.equal((await stop(999)).status, 404);
  assert.equal((await stop("abc")).status, 400);
  store.db.close();
});

test("run log streams complete lines, resumes from the last offset and ends with the run", {
  timeout: 10_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { app, store, config } = fixture("", dir);
  const item = store.createItem({
    title: "Log",
    request: "Test",
    source: "manual",
  });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    input: "Build it",
    session_id: null,
    status: "queued",
  });
  const logPath = await internalLog(config.workDir, item.id);
  const open = async (headers: Record<string, string> = {}, query = "") => {
    const response = await app.request(
      `/api/runs/${run.id}/log${query}`,
      { headers },
      bindings(),
    );
    assert.match(
      response.headers.get("content-type") ?? "",
      /text\/event-stream/,
    );
    // biome-ignore lint/style/noNonNullAssertion: An SSE response always has a body.
    const reader = response.body!.getReader();
    let text = "";
    const until = async (pattern: RegExp) => {
      while (!pattern.test(text)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream closed before ${pattern}: ${text}`);
        text += new TextDecoder().decode(value);
      }
      return text;
    };
    return { reader, until, text: () => text };
  };

  // A queued run has no log yet: the stream waits instead of ending.
  const live = await open();
  store.markRunStarted(run.id, logPath);
  await writeFile(logPath, "line one\npart");
  await live.until(/id: 9\n/);
  assert.match(live.text(), /data: "line one\\n"\nid: 9\n\n/);
  assert.ok(
    !live.text().includes("part"),
    "partial lines wait for their newline",
  );
  await appendFile(logPath, "ial\nline three\n");
  await live.until(/id: 28\n/);
  assert.match(live.text(), /data: "partial\\nline three\\n"\nid: 28\n/);
  await appendFile(logPath, "no newline at the end");
  store.finishRun(run.id, {
    status: "succeeded",
    result: "Done",
    error: null,
    cost_usd: 0,
    num_turns: 1,
    duration_ms: 10,
    session_id: "s",
    log_path: logPath,
  });
  await live.until(/event: end\n/);
  assert.match(
    live.text(),
    /data: "no newline at the end"\nid: 49\n\nevent: end\ndata: \nid: 49\n\n$/,
  );
  assert.equal((await live.reader.read()).done, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(store.changes.listenerCount("change"), 0);

  // EventSource reconnects with Last-Event-ID; ?offset= works for plain clients.
  for (const [headers, query] of [
    [{ "last-event-id": "9" }, ""],
    [{}, "?offset=9"],
  ] as const) {
    const resumed = await open(headers, query);
    await resumed.until(/event: end\n/);
    assert.equal(
      resumed.text(),
      'data: "partial\\nline three\\n"\nid: 28\n\ndata: "no newline at the end"\nid: 49\n\nevent: end\ndata: \nid: 49\n\n',
    );
  }
  const missing = await app.request("/api/runs/999/log", {}, bindings());
  assert.equal(missing.status, 404);
  store.db.close();
});

test("run log reads large transcripts in windows that end at line boundaries", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { app, store, config } = fixture("", dir);
  const item = store.createItem({
    title: "Big",
    request: "Test",
    source: "manual",
  });
  const run = store.createRun({
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
  const logPath = await internalLog(config.workDir, item.id);
  // Lines shorter and longer than one 256 KiB window, then a final partial line.
  const lines = [200_000, 600_000, 10, 300_000].map(
    (n, i) => "x".repeat(n) + i,
  );
  const content = `${lines.slice(0, 3).join("\n")}\n${lines[3]}`;
  await writeFile(logPath, content);
  store.markRunStarted(run.id, logPath);
  store.finishRun(run.id, {
    status: "succeeded",
    result: null,
    error: null,
    cost_usd: 0,
    num_turns: null,
    duration_ms: 1,
    session_id: null,
    log_path: logPath,
  });
  const response = await app.request(`/api/runs/${run.id}/log`, {}, bindings());
  const text = await response.text();
  const events = [...text.matchAll(/data: (.*)\nid: (\d+)\n\n/g)];
  const chunks = events
    .slice(0, -1)
    .map((e) => JSON.parse(e[1] ?? "") as string);
  assert.equal(chunks.join(""), content);
  let offset = 0;
  for (const [index, chunk] of chunks.entries()) {
    offset += Buffer.byteLength(chunk);
    assert.equal(Number(events[index]?.[2]), offset);
    if (index < chunks.length - 1) assert.ok(chunk.endsWith("\n"));
  }
  assert.ok(chunks.length >= 3, "the 1.1 MB log is sent in several windows");
  assert.match(text, /event: end\ndata: \nid: (\d+)\n\n$/);
  assert.equal(
    Number(/event: end\ndata: \nid: (\d+)/.exec(text)?.[1]),
    Buffer.byteLength(content),
  );
  store.db.close();
});

test("run log, prompt and diff are never served from a file outside the item's internal directory", {
  timeout: 10_000,
}, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-log-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { app, store, config } = fixture("", dir);
  const secret = join(dir, "secret");
  await writeFile(secret, "host secret\n");
  const item = store.createItem({
    title: "Leak",
    request: "Test",
    source: "manual",
  });
  const ended = (logPath: string) => {
    const run = store.createRun({
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
    store.markRunStarted(run.id, logPath);
    store.setRunSnapshots(run.id, [
      { slug: "acme/widgets", start: "a", end: "b" },
    ]);
    store.finishRun(run.id, {
      status: "succeeded",
      result: null,
      error: null,
      cost_usd: 0,
      num_turns: null,
      duration_ms: 1,
      session_id: null,
      log_path: logPath,
    });
    return run.id;
  };
  // A planted symlink at each internal path, and a log path elsewhere on the host.
  const logPath = await internalLog(config.workDir, item.id);
  const internal = internalDir(config.workDir, item.id);
  await symlink(secret, logPath);
  await symlink(secret, join(internal, "logs", "run-1.diff.json"));
  await symlink(secret, join(internal, "run-1.system.md"));
  for (const id of [ended(logPath), ended(secret)]) {
    const log = await app.request(`/api/runs/${id}/log`, {}, bindings());
    assert.equal(await log.text(), "event: end\ndata: \nid: 0\n\n");
    const detail = await app.request(`/api/runs/${id}`, {}, bindings());
    assert.equal(
      ((await detail.json()) as { systemPrompt: unknown }).systemPrompt,
      null,
    );
    const diff = await app.request(`/api/runs/${id}/diff`, {}, bindings());
    assert.deepEqual(await diff.json(), { source: "log" });
  }
  store.db.close();
});

test("work item endpoints return the detail, PR summary, messages, approvals and cancel", async () => {
  const { store, registry, factory, poller, config } = fixture();
  factory.pump = async () => {};
  const prUrls: string[] = [];
  const app = createApp(registry, poller, config, "token", async (url) => {
    prUrls.push(url);
    if (url.endsWith("/500")) throw new Error("gh: not found");
    return {
      title: "feat: names in cron",
      headRefName: "nakara/item-1",
      headRefOid: "0123456789abcdef0123456789abcdef01234567",
      baseRefName: "main",
      additions: 12,
      deletions: 3,
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    };
  });
  const request = (path: string, body?: unknown) =>
    app.request(
      path,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
      bindings(),
    );
  const error = async (response: Response) =>
    ((await response.json()) as { error: { code: string } }).error.code;
  const item = store.createItem({
    title: "Detail",
    request: "Test",
    source: "manual",
  });

  const detail = await request(`/api/items/${item.id}`);
  assert.equal(detail.status, 200);
  const dto = (await detail.json()) as ItemDetailDto;
  assert.equal(dto.title, "Detail");
  assert.deepEqual(dto.runLimit, {
    used: 0,
    max: config.limits.maxRuns,
    exhausted: false,
  });
  assert.equal(await error(await request("/api/items/999")), "not_found");
  assert.equal(await error(await request("/api/items/abc")), "invalid");

  assert.equal((await request(`/api/items/${item.id}/pr`)).status, 404);
  store.updateItem(item.id, {
    stage: "handoff",
    pr_url: "https://github.com/acme/app/pull/14",
  });
  const pr = await request(`/api/items/${item.id}/pr`);
  assert.equal(pr.status, 200);
  assert.deepEqual(await pr.json(), {
    title: "feat: names in cron",
    repo: "acme/app",
    head: "nakara/item-1",
    headSha: "0123456789abcdef0123456789abcdef01234567",
    base: "main",
    additions: 12,
    deletions: 3,
    checks: "passing",
  });
  store.updateItem(item.id, { pr_url: "https://github.com/acme/app/pull/500" });
  assert.equal(
    await error(await request(`/api/items/${item.id}/pr`)),
    "github",
  );
  assert.equal(prUrls.length, 2);

  // Request changes on a handed-off PR is a message to the foreman.
  const messages = `/api/items/${item.id}/messages`;
  assert.equal((await request(messages, { message: " " })).status, 400);
  assert.equal(
    (await request("/api/items/999/messages", { message: "Hi" })).status,
    404,
  );
  const changes: string[] = [];
  store.changes.on("change", (event) => changes.push(event.type));
  const sent = await request(messages, {
    message: "Changes requested on PR #14:\n\nRename the flag",
  });
  assert.equal(sent.status, 202);
  // A new message refreshes the item page through the items query.
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(changes.includes("items"));
  assert.equal(
    store.messages(item.id).at(-1)?.body.endsWith("Rename the flag"),
    true,
  );
  assert.equal(
    store.pendingEvents(item.id).some((e) => e.kind === "human_message"),
    true,
  );

  const spec = store.addApproval(item.id, "spec", "Spec", null);
  const question = store.addApproval(item.id, "question", "Which?", null);
  const decide = (id: number, body: unknown) =>
    request(`/api/approvals/${id}`, body);
  assert.equal((await decide(spec, { decision: "reject" })).status, 400);
  assert.equal(
    await error(await decide(spec, { decision: "answer", answer: "A" })),
    "invalid",
  );
  assert.equal(
    await error(await decide(question, { decision: "approve" })),
    "invalid",
  );
  assert.equal((await decide(999, { decision: "approve" })).status, 404);
  assert.equal((await decide(spec, { decision: "approve" })).status, 200);
  assert.equal(store.approval(spec)?.status, "approved");
  assert.equal(
    await error(await decide(spec, { decision: "approve" })),
    "policy",
  );
  assert.equal(
    (await decide(question, { decision: "answer", answer: "B" })).status,
    200,
  );
  assert.equal(store.approval(question)?.answer, "B");

  const cancel = `/api/items/${item.id}/cancel`;
  assert.equal((await request(cancel, {})).status, 200);
  assert.equal(store.item(item.id)?.stage, "cancelled");
  assert.equal(await error(await request(cancel, {})), "policy");
  assert.equal(
    await error(await request(messages, { message: "Hi" })),
    "policy",
  );
  store.db.close();
});

test("retry, raise-budget and raise-run-limit endpoints map refusals to 409 and unknown items to 404", async () => {
  const { app, store, factory } = fixture();
  factory.pump = async () => {};
  const post = (path: string) =>
    app.request(`/api/items/${path}`, { method: "POST" }, bindings());
  const item = store.createItem({
    title: "Budget",
    request: "Test",
    source: "manual",
  });
  const raised = await post(`${item.id}/raise-budget`);
  assert.equal(raised.status, 200);
  assert.deepEqual(await raised.json(), {
    item: { id: item.id, budgetUsd: 25 },
  });
  const retry = await post(`${item.id}/retry`);
  assert.equal(retry.status, 409);
  assert.deepEqual(await retry.json(), {
    error: {
      code: "policy",
      message: "Only a failed agent run can be retried.",
    },
  });
  assert.equal((await post("999/retry")).status, 404);
  assert.equal((await post("999/raise-budget")).status, 404);
  // An item stopped by its run limit wakes when the limit is raised.
  store.updateItem(item.id, {
    status: "paused",
    run_count: item.max_runs,
  });
  const runs = await post(`${item.id}/raise-run-limit`);
  assert.equal(runs.status, 200);
  assert.deepEqual(await runs.json(), {
    item: { id: item.id, maxRuns: item.max_runs + 10 },
  });
  assert.equal(store.item(item.id)?.status, "active");
  assert.equal((await post("999/raise-run-limit")).status, 404);
  store.updateItem(item.id, { stage: "cancelled", status: "done" });
  assert.equal((await post(`${item.id}/raise-budget`)).status, 409);
  assert.equal((await post(`${item.id}/raise-run-limit`)).status, 409);
  store.db.close();
});

/**
 * A fake gh on PATH for the Operator's merge: answers `pr checks`, `repo view`,
 * `pr merge` and `pr view` from github.json (rewritten between requests) and
 * records every call.
 */
async function fakeMergeGh(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-merge-gh-"));
  const state = join(dir, "github.json");
  const calls = join(dir, "calls.jsonl");
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n");
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const cmd = args.slice(0, 2).join(" ");
if (cmd === "pr checks") console.log(JSON.stringify(gh.checks));
else if (cmd === "repo view") console.log(JSON.stringify(gh.allowed));
else if (cmd === "pr view") console.log(JSON.stringify({ state: gh.state }));
else if (cmd === "pr merge" && gh.mergeError) {
  console.error(gh.mergeError);
  process.exit(1);
} else if (cmd === "pr merge") gh.state = "MERGED";
else process.exit(2);
fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(gh));
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const github = (value: {
    checks: { name: string; bucket: string }[];
    allowed: Record<string, boolean>;
    state?: string;
    mergeError?: string;
  }) => writeFile(state, JSON.stringify({ state: "OPEN", ...value }));
  const read = async () =>
    (await readFile(calls, "utf8").catch(() => ""))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[]);
  const merges = async () =>
    (await read()).filter((a) => a[0] === "pr" && a[1] === "merge");
  return { github, merges };
}

const MERGE_PR = "https://github.com/o/r/pull/7";
const ALL_METHODS = {
  squashMergeAllowed: true,
  mergeCommitAllowed: true,
  rebaseMergeAllowed: true,
};

test("the Operator merges a PR only at handoff with passing checks, by the repository's first allowed method", async (t) => {
  const { app, store } = fixture();
  t.after(() => store.db.close());
  const gh = await fakeMergeGh(t);
  const merge = (id: number) =>
    app.request(`/api/items/${id}/merge`, { method: "POST" }, bindings());
  const refusal = async (response: Response) => {
    assert.equal(response.status, 409);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(body.error.code, "policy");
    return body.error.message;
  };
  const item = store.createItem({
    title: "Merge",
    request: "Test",
    source: "manual",
  });
  const nothingRecorded = () => {
    assert.deepEqual(store.messages(item.id), []);
    assert.deepEqual(store.events(item.id), []);
    assert.equal(store.item(item.id)?.pr_merged, 0);
  };
  await gh.github({
    checks: [{ name: "CI", bucket: "pass" }],
    allowed: ALL_METHODS,
  });

  assert.equal((await merge(999)).status, 404);
  // Not at handoff, then at handoff without a PR.
  store.updateItem(item.id, { stage: "building", pr_url: MERGE_PR });
  assert.match(await refusal(await merge(item.id)), /Handoff/);
  store.updateItem(item.id, { stage: "handoff", pr_url: null });
  assert.match(await refusal(await merge(item.id)), /no pull request/);
  store.updateItem(item.id, { pr_url: MERGE_PR, pr_merged: 1 });
  assert.match(await refusal(await merge(item.id)), /already merged/);
  store.updateItem(item.id, { pr_merged: 0 });
  // Checks failing or pending.
  for (const bucket of ["fail", "pending"]) {
    await gh.github({ checks: [{ name: "CI", bucket }], allowed: ALL_METHODS });
    assert.match(await refusal(await merge(item.id)), /Checks are not passing/);
  }
  assert.deepEqual(await gh.merges(), []);
  nothingRecorded();

  // GitHub refuses: its message is returned and nothing is recorded.
  const protectedBranch =
    "GraphQL: Base branch policy prohibits the merge (mergePullRequest)";
  await gh.github({
    checks: [{ name: "CI", bucket: "pass" }],
    allowed: ALL_METHODS,
    mergeError: protectedBranch,
  });
  assert.equal(await refusal(await merge(item.id)), protectedBranch);
  nothingRecorded();

  // The method follows the repository settings: squash, merge, then rebase.
  await gh.github({
    checks: [{ name: "CI", bucket: "pass" }],
    allowed: {
      squashMergeAllowed: false,
      mergeCommitAllowed: false,
      rebaseMergeAllowed: false,
    },
  });
  assert.match(await refusal(await merge(item.id)), /no merge method/);
  nothingRecorded();
  await gh.github({
    checks: [
      { name: "CI", bucket: "pass" },
      { name: "Optional", bucket: "skipping" },
    ],
    allowed: { ...ALL_METHODS, squashMergeAllowed: false },
  });
  const merged = await merge(item.id);
  assert.equal(merged.status, 200);
  assert.deepEqual(await merged.json(), {
    item: { id: item.id },
    method: "merge",
  });
  // No --admin and no branch deletion, ever.
  assert.deepEqual(
    (await gh.merges()).map((a) => a.slice(2)),
    [
      [MERGE_PR, "--squash"],
      [MERGE_PR, "--merge"],
    ],
  );
  assert.deepEqual(
    store.messages(item.id).map((m) => [m.author, m.body]),
    [["factory", "Merged by the Operator"]],
  );
  // The merge itself completes nothing: the poller reports it.
  assert.equal(store.item(item.id)?.stage, "handoff");
  assert.equal(store.item(item.id)?.pr_merged, 0);
  assert.deepEqual(store.events(item.id), []);
  // A repeat before the poller reports the merge never merges again.
  assert.match(await refusal(await merge(item.id)), /waiting for GitHub/);
  assert.equal((await gh.merges()).length, 2);
  assert.equal(store.messages(item.id).length, 1);
});

test("after the poller reports the Operator's merge, the item completes through the normal path", async (t) => {
  const { app, store, config } = fixture();
  t.after(() => store.db.close());
  const gh = await fakeMergeGh(t);
  const loaded = await loadDefinition("factory", HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  const definition = {
    ...loaded.definition,
    factory: {
      ...loaded.definition.factory,
      repositories: [{ owner: "o", name: "r" }],
    },
  };
  const applier = new ActionApplier(store, config, () => definition, {
    ...GH_PULL_REQUESTS,
    markReady: async () => {},
    comment: async () => {},
    removeWorkspace: async () => {},
  });
  const item = store.createItem({
    title: "Merge",
    request: "Test",
    source: "manual",
  });
  store.updateItem(item.id, {
    stage: "handoff",
    status: "waiting_human",
    pr_url: MERGE_PR,
  });
  const complete = () =>
    applier.applyActions(item.id, [
      {
        action: { type: "complete_task", summary: "Merged and done." },
        accepted: true,
      },
    ]);
  await gh.github({
    checks: [{ name: "CI", bucket: "pass" }],
    allowed: ALL_METHODS,
  });
  const merged = await app.request(
    `/api/items/${item.id}/merge`,
    { method: "POST" },
    bindings(),
  );
  assert.equal(merged.status, 200);
  // Until the poller reports the merge, the foreman cannot complete.
  assert.deepEqual(await complete(), []);
  assert.equal(store.item(item.id)?.stage, "handoff");

  await new PullRequestGate(store).poll(item.id);
  assert.equal(store.item(item.id)?.pr_merged, 1);
  assert.deepEqual(
    store.pendingEvents(item.id).map((e) => e.kind),
    ["pr_merged"],
  );
  assert.equal((await complete()).length, 1);
  assert.equal(store.item(item.id)?.stage, "complete");
});

test("instance concurrency: the env default until saved, a saved value in range wins, clearing returns to the default", async () => {
  const { app, store, registry } = fixture();
  // Nothing is queued; the pump after a save must not start a harness.
  registry.pump = async () => {};
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await app.request(
      `/api/${path}`,
      body === undefined
        ? { method }
        : {
            method,
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
      bindings(),
    );
    return {
      status: response.status,
      body: (await response.json()) as {
        concurrency: { concurrency: number };
        slots: { total: number };
        error: { code: string };
      },
    };
  };
  const total = async () => (await call("GET", "status")).body.slots.total;

  // No saved value: NAKARA_CONCURRENCY (2).
  assert.deepEqual((await call("GET", "settings")).body, {
    concurrency: { concurrency: 2, saved: null, default: 2 },
  });
  assert.equal(await total(), 2);

  assert.deepEqual(
    await call("PUT", "settings/concurrency", { concurrency: 3 }),
    {
      status: 200,
      body: { concurrency: { concurrency: 3, saved: 3, default: 2 } },
    },
  );
  assert.equal(await total(), 3);

  // Out of range, not whole, or not a number: 400, and the saved value stays.
  for (const concurrency of [0, 11, 1.5, "3", "many", true, undefined]) {
    const refused = await call("PUT", "settings/concurrency", { concurrency });
    assert.equal(refused.status, 400, JSON.stringify(concurrency));
    assert.equal(refused.body.error.code, "invalid_input");
  }
  assert.equal(
    (await call("PUT", "settings/concurrency", { concurrency: 3, other: 1 }))
      .status,
    400,
  );
  assert.equal(await total(), 3);

  // The bounds themselves are accepted.
  for (const concurrency of [1, 10])
    assert.equal(
      (await call("PUT", "settings/concurrency", { concurrency })).body
        .concurrency.concurrency,
      concurrency,
    );

  // Clearing the field returns to the env default.
  assert.deepEqual(
    (await call("PUT", "settings/concurrency", { concurrency: null })).body,
    { concurrency: { concurrency: 2, saved: null, default: 2 } },
  );
  assert.equal(await total(), 2);

  // The same auth as the rest of the API.
  const remote = await app.request(
    "/api/settings/concurrency",
    {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: "" },
      body: JSON.stringify({ concurrency: 5 }),
    },
    bindings("192.0.2.1"),
  );
  assert.equal(remote.status, 401);
  assert.equal(await total(), 2);
  store.db.close();
});
