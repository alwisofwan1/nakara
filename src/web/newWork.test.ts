import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { createApi } from "./api.ts";
import type { FetchIssue } from "./newWork.ts";
import { readNewWorkOptions } from "./newWork.ts";

async function fixture(
  fetchIssue: FetchIssue = async () => {
    throw new Error("unexpected GitHub call");
  },
) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, loadConfig({}));
  const factory = registry.default;
  assert.ok((await factory.reloadDefinition()).ok);
  // Create items without starting foreman turns.
  factory.pump = async () => {};
  const api = createApi(registry, factory.config, fetchIssue);
  const post = async (body: unknown) => {
    const response = await api.request("/f/default/items", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return {
      status: response.status,
      body: (await response.json()) as {
        id?: number;
        error?: { code: string; message: string };
      },
    };
  };
  return { store, factory, api, post };
}

const form = {
  title: "Add retry",
  request: "When a run fails, offer **Retry**.",
  repo: "alwisofwan1/nakara",
  automation: "issue-labeled",
  budgetUsd: 7.5,
  requester: "alwi",
};

test("options list the definition's repositories, enabled automations and known requesters", async () => {
  const { store, factory } = await fixture();
  store.createItem({
    title: "T",
    request: "R",
    source: "manual",
    requester: "zoe",
  });
  const options = readNewWorkOptions(store, factory.definition);
  assert.equal(options.ready, true);
  assert.equal(options.issueLabel, "factory:Nakara");
  assert.deepEqual(options.repositories, [
    "alwisofwan1/nakara-sandbox",
    "alwisofwan1/nakara",
  ]);
  assert.ok(options.automations.some((a) => a.name === "issue-labeled"));
  assert.deepEqual(options.defaults, {
    automation: null,
    budgetUsd: 15,
    requester: "operator",
  });
  assert.deepEqual(options.requesters, ["operator", "zoe"]);
  assert.equal(readNewWorkOptions(store, undefined).ready, false);
  store.db.close();
});

test("creates a manual item with the chosen repository, automation, budget and requester", async () => {
  const { store, post } = await fixture();
  const { status, body } = await post(form);
  assert.equal(status, 201);
  const item = store.item(body.id ?? 0);
  assert.ok(item);
  assert.equal(item.source, "manual");
  assert.equal(item.title, form.title);
  assert.equal(item.request, form.request);
  assert.equal(item.repo, form.repo);
  assert.equal(item.automation, form.automation);
  assert.equal(item.budget_usd, 7.5);
  assert.equal(item.requester, "alwi");
  assert.deepEqual(
    store.pendingEvents(item.id).map((e) => [e.kind, JSON.parse(e.payload)]),
    [["work_received", { automation: "issue-labeled" }]],
  );
  store.db.close();
});

test("imports a GitHub issue's title and body as the request and links it", async () => {
  const calls: string[] = [];
  const url = "https://github.com/alwisofwan1/nakara/issues/9";
  const { store, post } = await fixture(async (u) => {
    calls.push(u);
    return { title: "Imported title", body: "Imported body", url };
  });
  const { status, body } = await post({
    ...form,
    title: "",
    request: "",
    repo: null,
    issueUrl: url,
  });
  assert.equal(status, 201);
  assert.deepEqual(calls, [url]);
  const item = store.item(body.id ?? 0);
  assert.ok(item);
  assert.equal(item.title, "Imported title");
  assert.equal(item.request, "Imported body");
  assert.equal(item.source, "github");
  assert.equal(item.source_ref, "github:alwisofwan1/nakara#9");
  assert.equal(item.issue_url, url);
  assert.equal(item.source_url, url);
  assert.equal(item.repo, "alwisofwan1/nakara");
  assert.equal(item.budget_usd, 7.5);

  const again = await post({ ...form, issueUrl: `${url}/` });
  assert.equal(again.status, 409);
  assert.equal(again.body.error?.code, "conflict");
  assert.match(again.body.error?.message ?? "", new RegExp(`#${item.id}`));
  assert.equal(calls.length, 1);
  store.db.close();
});

test("matches the issue's repository case-insensitively and keeps the factory's spelling", async () => {
  const { store, post } = await fixture(async () => ({
    title: "Mixed case",
    body: "Body",
    url: "https://github.com/alwisofwan1/nakara/issues/12",
  }));
  const created = await post({
    ...form,
    repo: "alwisofwan1/nakara",
    issueUrl: "https://github.com/AlwiSofwan1/Nakara/issues/12",
  });
  assert.equal(created.status, 201);
  const item = store.item(created.body.id ?? 0);
  assert.equal(item?.repo, "alwisofwan1/nakara");
  assert.equal(item?.source_ref, "github:alwisofwan1/nakara#12");

  // An issue the label poller already imported is refused before calling GitHub.
  const polled = store.createItem({
    title: "Polled",
    request: "Body",
    source: "github",
    sourceRef: "github:alwisofwan1/nakara#13",
  });
  const again = await post({
    ...form,
    issueUrl: "https://github.com/ALWISOFWAN1/NAKARA/issues/13",
  });
  assert.equal(again.status, 409);
  assert.equal(
    again.body.error?.message,
    `This issue is already work item #${polled.id}.`,
  );
  store.db.close();
});

test("an issue imported while gh runs is refused as a conflict, not a server error", async () => {
  const url = "https://github.com/alwisofwan1/nakara/issues/20";
  const polled = (store: Store) =>
    store.createItem({
      title: "Polled",
      request: "Body",
      source: "github",
      sourceRef: "github:alwisofwan1/nakara#20",
      issueUrl: url,
    });
  let store: Store | undefined;
  const during = await fixture(async () => {
    assert.ok(store);
    polled(store);
    return { title: "Imported", body: "Body", url };
  });
  store = during.store;
  const response = await during.post({ ...form, issueUrl: url });
  assert.equal(response.status, 409);
  assert.equal(response.body.error?.code, "conflict");
  assert.equal(store.items().length, 1);
  store.db.close();

  // The same race between the last check and the insert hits the UNIQUE source_ref.
  const late = await fixture(async () => ({
    title: "Imported",
    body: "Body",
    url,
  }));
  const create = late.factory.createWorkItem.bind(late.factory);
  late.factory.createWorkItem = (input) => {
    const winner = polled(late.store);
    assert.ok(winner);
    return create(input);
  };
  const raced = await late.post({ ...form, issueUrl: url });
  assert.equal(raced.status, 409);
  assert.match(raced.body.error?.message ?? "", /already work item #1\./);
  assert.equal(late.store.items().length, 1);
  late.store.db.close();
});

test("refuses invalid input with 400 and definition violations with 409", async () => {
  const { store, post, factory } = await fixture(async () => {
    throw new Error("gh: not found");
  });
  for (const body of [
    "{not json",
    { ...form, title: "" },
    { ...form, budgetUsd: 0 },
    { ...form, requester: " " },
    { ...form, issueUrl: "https://example.com/issues/1" },
  ]) {
    const response = await post(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(response.body.error?.code, "invalid");
  }
  for (const [body, code, status] of [
    [{ ...form, repo: "someone/else" }, "policy", 409],
    [{ ...form, automation: "missing" }, "policy", 409],
    [
      { ...form, issueUrl: "https://github.com/someone/else/issues/1" },
      "policy",
      409,
    ],
    [
      {
        ...form,
        repo: "alwisofwan1/nakara-sandbox",
        issueUrl: "https://github.com/alwisofwan1/nakara/issues/1",
      },
      "policy",
      409,
    ],
    [
      { ...form, issueUrl: "https://github.com/alwisofwan1/nakara/issues/1" },
      "github",
      502,
    ],
  ] as const) {
    const response = await post(body);
    assert.equal(response.status, status, JSON.stringify(body));
    assert.equal(response.body.error?.code, code);
  }
  factory.definition = undefined;
  assert.equal((await post(form)).status, 409);
  assert.equal(store.items().length, 0);
  store.db.close();
});
