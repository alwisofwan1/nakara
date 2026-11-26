import assert from "node:assert/strict";
import { test } from "node:test";
import type { HttpBindings } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { GithubPoller } from "../intake/github.ts";
import { createApp } from "./server.ts";
import {
  ACCESS_AUD,
  ACCESS_NOW,
  ACCESS_TEAM,
  accessKeys,
} from "./test-support.ts";

const bindings = {
  incoming: { socket: { remoteAddress: "127.0.0.1" } },
} as HttpBindings;

const HOST = "localhost:7788";
const operator = (token: string) => ({
  host: HOST,
  authorization: `Bearer ${token}`,
});

for (const basePath of ["", "/proxy/7788"]) {
  test(`shell and existing actions with base path ${basePath || "/"}`, async () => {
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    const config = loadConfig({
      NAKARA_BASE_PATH: basePath,
      NAKARA_GITHUB_MIRROR: "false",
    });
    const registry = new FactoryRegistry(store, config);
    const factory = registry.default;
    await factory.reloadDefinition();
    const poller = new GithubPoller(factory);
    const app = createApp(registry, poller, config, "test");
    const request = (path: string, data?: Record<string, string>) =>
      app.request(
        path,
        {
          headers: operator("test"),
          ...(data ? { method: "POST", body: new URLSearchParams(data) } : {}),
        },
        bindings,
      );
    const item = store.createItem({
      title: "Shell test",
      request: "Keep existing actions working",
      source: "manual",
    });
    const itemPath = `/items/${item.id}`;
    store.updateItem(item.id, { stage: "reviewing" });
    const approval = store.addApproval(item.id, "question", "Continue?", null);
    const run = store.createRun({
      item_id: item.id,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "Test",
      session_id: null,
      status: "running",
    });
    store.createRun({
      item_id: item.id,
      role: "foreman",
      agent: "foreman",
      agent_type: "FOREMAN",
      harness: "claude",
      model: null,
      input: "Test",
      session_id: null,
      status: "running",
    });
    // The run and work item pages are client routes now.
    for (const path of [`/runs/${run.id}`, itemPath]) {
      const page = await request(path);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /id="nakara-config"/);
    }
    assert.equal((await request("/items", {})).status, 404);
    // The Inbox is a client route now.
    const inbox = await request("/inbox");
    assert.equal(inbox.status, 200);
    assert.match(await inbox.text(), /id="nakara-config"/);
    assert.equal(
      (
        await request(`/approvals/${approval}`, {
          decision: "answer",
          answer: "Continue",
        })
      ).status,
      302,
    );
    assert.equal(store.approval(approval)?.status, "answered");
    // The server-rendered item actions are gone; the API replaces them.
    for (const action of ["message", "cancel"])
      assert.equal(
        (await request(`${itemPath}/${action}`, { message: "A message" }))
          .status,
        404,
      );
    // The Definition page and its reload action moved to the SPA and /api.
    assert.equal((await request("/definition/reload", {})).status, 404);

    // Factory pages live under /f/<slug>/ and the shell knows every factory.
    const slug = store.repos.factories.defaultFactory().slug;
    for (const path of [
      `/f/${slug}`,
      `/f/${slug}/activity`,
      `/f/${slug}/agents/foreman`,
      `/f/${slug}/definition`,
    ]) {
      const page = await request(path);
      assert.equal(page.status, 200, path);
      const html = await page.text();
      const runtime = JSON.parse(
        /id="nakara-config" type="application\/json">(.*?)<\/script>/.exec(
          html,
        )?.[1] ?? "{}",
      );
      assert.deepEqual(runtime.factories, [
        { slug, name: "Default", avatarColor: "#6366f1" },
      ]);
    }
    assert.deepEqual(await (await request("/api/factories")).json(), [
      { slug, name: "Default", avatarColor: "#6366f1" },
    ]);
    assert.equal((await request("/f/missing/activity")).status, 404);
    assert.equal((await request("/f/%E0/activity")).status, 404);
    // Old factory page links redirect to the first factory, keeping the query.
    for (const [path, target] of [
      ["/activity", `/f/${slug}/activity`],
      ["/activity?source=github", `/f/${slug}/activity?source=github`],
      ["/agents", `/f/${slug}/agents`],
      ["/agents/new", `/f/${slug}/agents/new`],
      ["/agents/review", `/f/${slug}/agents/review`],
      ["/automations", `/f/${slug}/automations`],
      ["/definition", `/f/${slug}/definition`],
    ]) {
      const response = await request(`${basePath}${path}`);
      assert.equal(response.status, 302, path);
      assert.equal(response.headers.get("location"), `${basePath}${target}`);
    }
  });
}

test("pages and refusals carry the security headers", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const config = loadConfig({
    NAKARA_ALLOW: "10.0.0.5",
    NAKARA_GITHUB_MIRROR: "false",
  });
  const registry = new FactoryRegistry(store, config);
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "s3cret",
  );
  const remote = {
    incoming: { socket: { remoteAddress: "10.0.0.5" } },
  } as HttpBindings;
  for (const response of [
    await app.request("/healthz", { headers: { host: HOST } }, bindings),
    await app.request("/api/status", { headers: { host: HOST } }, remote),
  ]) {
    const csp = response.headers.get("content-security-policy") ?? "";
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /script-src 'self'(;|$)/);
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.equal(response.headers.get("strict-transport-security"), null);
  }
  assert.equal(
    (await app.request("/api/status", { headers: { host: HOST } }, remote))
      .status,
    401,
  );
});

test("/metrics serves the Prometheus exposition behind the API token", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const config = loadConfig({
    NAKARA_ALLOW: "10.0.0.5",
    NAKARA_GITHUB_MIRROR: "false",
  });
  const registry = new FactoryRegistry(store, config);
  const factory = registry.default;
  const app = createApp(registry, new GithubPoller(factory), config, "s3cret");
  const item = store.createItem({
    title: "Queued",
    request: "Wait",
    source: "manual",
  });
  store.addEvent(item.id, "work_received", {});
  store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    input: "Test",
    session_id: null,
    status: "queued",
  });
  factory.telemetry.metrics.runsTotal.inc({
    agent: "implement",
    harness: "claude",
    status: "succeeded",
  });
  const remote = {
    incoming: { socket: { remoteAddress: "10.0.0.5" } },
  } as HttpBindings;
  const scrape = (headers: Record<string, string>) =>
    app.request("/metrics", { headers: { host: HOST, ...headers } }, remote);

  assert.equal((await scrape({})).status, 401);
  assert.equal((await scrape({ authorization: "Bearer wrong" })).status, 401);
  const res = await scrape({ authorization: "Bearer s3cret" });
  assert.equal(res.status, 200);
  assert.match(
    res.headers.get("content-type") ?? "",
    /text\/plain; version=0\.0\.4/,
  );
  const body = await res.text();
  assert.match(body, /^nakara_queue_depth\{role="agent"\} 1$/m);
  assert.match(body, /^nakara_queue_depth\{role="foreman"\} 1$/m);
  assert.match(
    body,
    /^nakara_runs_total\{agent="implement",harness="claude",status="succeeded"\} 1$/m,
  );
  for (const name of [
    "nakara_runs_total",
    "nakara_run_duration_seconds",
    "nakara_queue_depth",
    "nakara_run_wait_seconds",
    "nakara_cost_usd_total",
    "nakara_items_over_budget_total",
    "nakara_intake_poll_errors_total",
    "nakara_last_poll_timestamp",
  ])
    assert.match(body, new RegExp(`^# TYPE ${name} `, "m"));
  // A peer outside the allowlist is refused even with the token.
  const stranger = {
    incoming: { socket: { remoteAddress: "10.0.0.6" } },
  } as HttpBindings;
  assert.equal(
    (
      await app.request(
        "/metrics",
        { headers: { host: HOST, authorization: "Bearer s3cret" } },
        stranger,
      )
    ).status,
    403,
  );
  store.close();
});

function fixture(env: Record<string, string> = {}) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const config = loadConfig({
    NAKARA_ALLOW: "10.0.0.5",
    NAKARA_GITHUB_MIRROR: "false",
    ...env,
  });
  const registry = new FactoryRegistry(store, config);
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "s3cret",
  );
  const from = (remoteAddress: string) =>
    ({ incoming: { socket: { remoteAddress } } }) as HttpBindings;
  return { store, app, from };
}

test("a Bearer token or the cookie opens any route; a missing or wrong one is refused", async () => {
  const { store, app, from } = fixture();
  for (const peer of ["10.0.0.5", "127.0.0.1"]) {
    const call = (
      path: string,
      headers: Record<string, string>,
      method = "GET",
    ) =>
      app.request(
        path,
        { method, headers: { host: HOST, ...headers } },
        from(peer),
      );
    for (const [method, path] of [
      ["GET", "/api/status"],
      ["GET", "/inbox"],
      ["POST", "/api/definition/validate"],
    ] as const) {
      const label = `${peer} ${method} ${path}`;
      assert.equal((await call(path, {}, method)).status, 401, label);
      assert.equal(
        (await call(path, { authorization: "Bearer wrong" }, method)).status,
        401,
        label,
      );
      assert.notEqual(
        (await call(path, { authorization: "Bearer s3cret" }, method)).status,
        401,
        label,
      );
      assert.notEqual(
        (await call(path, { cookie: "nakara_token=s3cret" }, method)).status,
        401,
        label,
      );
    }
    const refused = await call("/api/definition/validate", {}, "POST");
    assert.equal(
      ((await refused.json()) as { error: { code: string } }).error.code,
      "unauthorized",
    );
  }
  store.close();
});

test("the token cookie is Lax for a year and a page visit with it renews it", async () => {
  const { store, app, from } = fixture();
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(
      path,
      { headers: { host: HOST, ...headers } },
      from("127.0.0.1"),
    );
  const cookie = (r: Response) => r.headers.get("set-cookie") ?? "";
  const login = await get("/inbox?token=s3cret");
  assert.equal(login.status, 302);
  assert.match(cookie(login), /SameSite=Lax/);
  assert.match(cookie(login), /Max-Age=31536000/);
  assert.match(
    cookie(await get("/inbox", { cookie: "nakara_token=s3cret" })),
    /Max-Age=31536000/,
  );
  assert.equal(
    cookie(await get("/api/status", { cookie: "nakara_token=s3cret" })),
    "",
  );
  assert.equal(
    cookie(await get("/inbox", { authorization: "Bearer s3cret" })),
    "",
  );
  store.close();
});

test("a valid Cloudflare Access JWT for an Operator email signs in without the token", async (t) => {
  const { jwk, jwt } = accessKeys();
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ keys: [jwk] }),
  );
  t.mock.method(Date, "now", () => ACCESS_NOW);
  const { store, app, from } = fixture({
    NAKARA_ACCESS_TEAM_DOMAIN: `${ACCESS_TEAM}/`,
    NAKARA_ACCESS_AUD: ACCESS_AUD,
    NAKARA_ACCESS_EMAILS: "op@example.com",
  });
  const get = (path: string, assertion: string) =>
    app.request(
      path,
      { headers: { host: HOST, "cf-access-jwt-assertion": assertion } },
      from("127.0.0.1"),
    );
  const page = await get("/inbox", jwt({}));
  assert.notEqual(page.status, 401);
  assert.match(page.headers.get("set-cookie") ?? "", /nakara_token=s3cret/);
  assert.equal((await get("/api/status", jwt({}))).status, 200);
  assert.equal(
    (await get("/inbox", jwt({ email: "x@example.com" }))).status,
    401,
  );
  assert.equal((await get("/inbox", jwt({ aud: ["other"] }))).status, 401);
  store.close();
});

test("NAKARA_ACCESS_* must be set together", () => {
  assert.throws(
    () => loadConfig({ NAKARA_ACCESS_AUD: "a" }),
    /together, or none of them/,
  );
});

test("/healthz and /metrics answer a loopback peer without the token, others still need it", async () => {
  const { store, app, from } = fixture();
  const get = (path: string, peer: string) =>
    app.request(path, { headers: { host: HOST } }, from(peer));
  assert.equal((await get("/healthz", "127.0.0.1")).status, 200);
  assert.equal((await get("/metrics", "::1")).status, 200);
  assert.equal((await get("/healthz", "10.0.0.5")).status, 401);
  assert.equal((await get("/metrics", "10.0.0.5")).status, 401);
  store.close();
});

test("a foreign Host is refused even from loopback and with the token", async () => {
  const { store, app, from } = fixture({
    NAKARA_PUBLIC_URL: "https://vps-me.example.com/proxy/7788",
  });
  const get = (host: string | undefined, peer = "127.0.0.1") =>
    app.request(
      "/api/status",
      {
        headers: {
          authorization: "Bearer s3cret",
          ...(host === undefined ? {} : { host }),
        },
      },
      from(peer),
    );
  for (const host of [
    "evil.example.com",
    "evil.example.com:7788",
    "127.0.0.1",
    "127.0.0.1:9999",
    "localhost:80",
    undefined,
  ])
    assert.equal((await get(host)).status, 403, String(host));
  assert.equal((await get("evil.example.com", "10.0.0.5")).status, 403);
  for (const host of [
    "127.0.0.1:7788",
    "localhost:7788",
    "[::1]:7788",
    "vps-me.example.com",
  ])
    assert.equal((await get(host)).status, 200, host);
  store.close();
});

test("x-forwarded-host does not pass the Origin check", async () => {
  const { store, app, from } = fixture();
  const post = (headers: Record<string, string>) =>
    app.request(
      "/api/definition/validate",
      {
        method: "POST",
        headers: { host: HOST, authorization: "Bearer s3cret", ...headers },
      },
      from("127.0.0.1"),
    );
  const spoofed = await post({
    origin: "https://evil.example.com",
    "x-forwarded-host": "evil.example.com",
  });
  assert.equal(spoofed.status, 403);
  assert.equal(
    ((await spoofed.json()) as { error: { code: string } }).error.code,
    "cross_origin",
  );
  assert.notEqual((await post({ origin: `http://${HOST}` })).status, 403);
  store.close();
});

test("a non-ASCII cookie of the token's character length gets 401, not 500", async () => {
  const { store, app, from } = fixture();
  // "s3cret" is 6 characters; this is 6 characters but 7 bytes.
  const cookie = `nakara_token=${encodeURIComponent("s3cré!")}`;
  for (const peer of ["10.0.0.5", "127.0.0.1"]) {
    const res = await app.request(
      "/api/status",
      { headers: { host: HOST, cookie } },
      from(peer),
    );
    assert.equal(res.status, 401, peer);
  }
  const bearer = await app.request(
    "/api/status",
    { headers: { host: HOST, authorization: "Bearer s3cré!" } },
    from("127.0.0.1"),
  );
  assert.equal(bearer.status, 401);
  store.close();
});
