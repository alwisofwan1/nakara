import { type TestContext, test } from "node:test";
import assert from "node:assert/strict";

import { loadConfig } from "../config.ts";
import { Store, stubFactorySeed } from "../db.ts";
import type { Factory } from "../orchestrator/factory.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { envSecrets, Logger } from "../telemetry/log.ts";
import { Metrics } from "../telemetry/metrics.ts";
import { type TelegramApi, TelegramBridge } from "./telegram.ts";

/** A bridge over the in-memory default factory and, with `docs`, a second factory "Docs" (@docs). */
function setup(env: NodeJS.ProcessEnv = {}, { docs = false } = {}) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  if (docs)
    store.repos.factories.createFactory({
      ...stubFactorySeed(),
      slug: "documentation",
      name: "Docs",
      foreman_handle: "docs",
      definition_dir: "docs",
    });
  const registry = new FactoryRegistry(store, loadConfig(env));
  for (const f of registry.factories) f.pump = async () => {}; // no foreman turns in tests
  const factory = registry.default;
  const calls: [string, Record<string, unknown>][] = [];
  let nextId = 100;
  const api = async (method: string, body: Record<string, unknown>) => {
    calls.push([method, body]);
    return { message_id: nextId++, chat: { id: 42 } };
  };
  const bridge = new TelegramBridge(registry, api, "42");
  const item = store.createItem({
    title: "Add login",
    request: "r",
    source: "manual",
  });
  return { store, registry, factory, calls, bridge, item };
}
const msg = (text: string, chat = 42, reply?: number) => ({
  update_id: 1,
  message: {
    message_id: 7,
    chat: { id: chat },
    text,
    ...(reply ? { reply_to_message: { message_id: reply } } : {}),
  },
});

test("spec approval: buttons out, approve and request-changes in", async () => {
  const { store, calls, bridge, item } = setup();
  const approval = store.addApproval(
    item.id,
    "spec",
    "s",
    "https://github.com/o/r/pull/1",
  );
  store.addMessage(item.id, "factory", "Spec ready for approval");
  await bridge.flush();
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  const [method, body] = calls[0]!;
  assert.equal(method, "sendMessage");
  assert.match(String(body.text), /^#1 Add login\nNeeds you · spec\n\nSpec/);
  assert.ok(JSON.stringify(body.reply_markup).includes(`a:${approval}:y`));

  // Request changes, then reply to the prompt with the feedback.
  await bridge.handle({
    update_id: 2,
    callback_query: {
      id: "c",
      data: `a:${approval}:n`,
      message: { message_id: 100, chat: { id: 42 } },
    },
  });
  const prompt = 100 + calls.length - 1; // ids count every call; the prompt was the last one
  await bridge.handle(msg("keep the URL whole", 42, prompt));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.approval(approval)!.status, "rejected");
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.approval(approval)!.answer, "keep the URL whole");

  const second = store.addApproval(item.id, "spec", "s2", "u");
  await bridge.handle({
    update_id: 3,
    callback_query: {
      id: "d",
      data: `a:${second}:y`,
      message: { message_id: 100, chat: { id: 42 } },
    },
  });
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.approval(second)!.status, "approved");
});

test("notifications carry the state label and link to the Work Item page", async () => {
  const { store, calls, bridge, item } = setup({
    NAKARA_PUBLIC_URL: "https://nakara.example/proxy/7788/",
  });
  const question = store.addApproval(item.id, "question", "Which repo?", null);
  store.addMessage(item.id, "factory", "Which repo?");
  await bridge.flush();
  store.resolveApproval(question, "rejected", "the sandbox");
  store.updateItem(item.id, {
    stage: "handoff",
    pr_url: "https://github.com/o/r/pull/14",
  });
  store.addMessage(item.id, "factory", "PR ready");
  await bridge.flush();
  assert.deepEqual(
    calls.map(([, b]) => String(b.text).split("\n").slice(0, 3)),
    [
      [
        "#1 Add login",
        "Needs you · question",
        "https://nakara.example/proxy/7788/items/1",
      ],
      [
        "#1 Add login",
        "Handoff · PR #14",
        "https://nakara.example/proxy/7788/items/1",
      ],
    ],
  );
});

test("replies answer questions or message the item; other chats are ignored", async () => {
  const { store, calls, bridge, item } = setup();
  const question = store.addApproval(item.id, "question", "Which repo?", null);
  store.addMessage(item.id, "factory", "Which repo?");
  await bridge.flush();
  await bridge.handle(msg("the sandbox", 999, 100));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.approval(question)!.status, "pending");
  await bridge.handle(msg("the sandbox", 42, 100));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.approval(question)!.answer, "the sandbox");
  await bridge.handle(msg("also add tests", 42, 100));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.messages(item.id).at(-1)!.body, "also add tests");
  const again = store.addApproval(item.id, "question", "Which branch?", null);
  await bridge.handle(msg(`#${item.id} main`));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.approval(again)!.answer, "main");
  await bridge.handle(msg(`#${item.id} thanks`));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.equal(store.messages(item.id).at(-1)!.body, "thanks");
  assert.ok(
    calls.every(([, b]) => b.chat_id === undefined || b.chat_id === "42"),
  );
});

test("new text needs a telegram/message automation", async () => {
  const { store, factory, calls, bridge } = setup();
  await bridge.handle(msg("Fix the footer\nIt overlaps on mobile"));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.match(String(calls.at(-1)![1].text), /telegram\/message trigger/);
  factory.definition = telegramAutomation;
  await bridge.handle(msg("/start"));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.match(String(calls.at(-1)![1].text), /^Send a request/);
  await bridge.handle(msg("Fix the footer\nIt overlaps on mobile"));
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  const created = store.itemBySourceRef("telegram:42:7")!;
  assert.equal(created.title, "Fix the footer");
  assert.equal(created.automation, "tg");
});

test("a leading @handle routes a new request to that factory, no handle to the first", async () => {
  const { store, registry, calls, bridge } = setup({}, { docs: true });
  const [first, docs] = registry.factories as [Factory, Factory];
  first.definition = telegramAutomation;
  docs.definition = telegramAutomation;
  const created = async (text: string, id: number) => {
    await bridge.handle({
      ...msg(text),
      message: { ...msg(text).message, message_id: id },
    });
    // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
    return store.itemBySourceRef(`telegram:42:${id}`)!;
  };

  const byHandle = await created("@Docs Fix the README\nThe links are dead", 1);
  assert.equal(byHandle.factory_id, docs.record?.id);
  assert.equal(byHandle.title, "Fix the README");
  assert.equal(byHandle.request, "Fix the README\nThe links are dead");
  assert.equal(
    calls.at(-1)?.[1].text,
    `Created #${byHandle.id} in Docs. Reply here to add to it.`,
  );
  assert.equal(
    (await created("@documentation Add a FAQ", 2)).factory_id,
    docs.record?.id,
  );
  assert.equal(
    (await created("Fix the footer", 3)).factory_id,
    first.record?.id,
  );

  const unknown =
    "Unknown handle @nobody. Start a request with one of @foreman or @default (Default), @docs or @documentation (Docs), or with no handle for Default.";
  await bridge.handle(msg("@nobody Fix the footer"));
  assert.equal(calls.at(-1)?.[1].text, unknown);
  // A bare handle is not a request.
  await bridge.handle(msg("@nobody"));
  assert.equal(calls.at(-1)?.[1].text, unknown);
  await bridge.handle(msg("@docs"));
  assert.equal(
    calls.at(-1)?.[1].text,
    'Send the request after the handle: "@docs <request>".',
  );
  assert.equal(store.itemBySourceRef("telegram:42:7"), undefined);
});

test("a handle to a factory without a telegram/message automation names that factory", async () => {
  const { store, factory, calls, bridge } = setup({}, { docs: true });
  factory.definition = telegramAutomation;
  await bridge.handle(msg("@docs Fix the README"));
  assert.equal(
    calls.at(-1)?.[1].text,
    "Docs has no automation with a telegram/message trigger.",
  );
  assert.equal(store.itemBySourceRef("telegram:42:7"), undefined);
});

test("notifications start with the factory name only when there are several factories", async () => {
  const one = setup();
  one.store.addMessage(one.item.id, "factory", "Hello");
  await one.bridge.flush();
  // biome-ignore lint/style/noNonNullAssertion: Keep a missing fixture value as a hard failure rather than adding optional access.
  assert.match(String(one.calls[0]![1].text), /^#1 Add login\n/);

  const { store, registry, calls, bridge, item } = setup({}, { docs: true });
  const docs = registry.get("documentation");
  const other = store.createItem({
    title: "Fix README",
    request: "r",
    source: "manual",
    factoryId: docs?.record?.id,
  });
  store.addMessage(item.id, "factory", "Hello");
  store.addMessage(other.id, "factory", "Hello");
  await bridge.flush();
  assert.deepEqual(
    calls.map(([, b]) => String(b.text).split("\n")[0]),
    ["[Default] #1 Add login", "[Docs] #2 Fix README"],
  );
});

const telegramAutomation = {
  automations: [
    {
      name: "tg",
      agent: "foreman",
      instructions: "",
      frontmatter: {
        enabled: true,
        triggers: [{ provider: "telegram", event: "message" }],
      },
    },
  ],
} as unknown as Factory["definition"];

const BOT_TOKEN = "123456789:AAH-abcdefghijklmnopqrstuvwxyz012345";

/** A bridge whose getUpdates answers once with `first`, then waits for stop(). */
function polling(t: TestContext, first: () => Promise<unknown>) {
  // The 10 s back-off after a failed poll never fires.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const lines: string[] = [];
  const registry = new FactoryRegistry(store, loadConfig({}), {
    log: new Logger({
      write: (l) => lines.push(l),
      secrets: envSecrets({ NAKARA_TELEGRAM_BOT_TOKEN: BOT_TOKEN }),
    }),
    metrics: new Metrics(),
  });
  const factory = registry.default;
  factory.pump = async () => {};
  let polls = 0;
  const api: TelegramApi = (method, _body, signal) => {
    if (method === "getUpdates" && polls++ === 0) return first();
    if (method === "sendMessage")
      return Promise.reject(
        new Error(`fetch https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`),
      );
    return new Promise((_, reject) =>
      signal?.addEventListener("abort", () => reject(new Error("aborted"))),
    );
  };
  const bridge = new TelegramBridge(registry, api, "");
  t.after(() => bridge.stop());
  const until = async (done: () => boolean) => {
    while (!done()) await new Promise((r) => setImmediate(r));
  };
  return {
    store,
    factory,
    bridge,
    lines,
    until,
    metrics: factory.telemetry.metrics,
  };
}

test("a failed Telegram poll is counted and logged without the bot token", async (t) => {
  const { bridge, lines, until, metrics } = polling(t, () =>
    Promise.reject(
      new Error(
        `request to https://api.telegram.org/bot${BOT_TOKEN}/getUpdates failed`,
      ),
    ),
  );
  bridge.start();
  await until(() => metrics.pollErrors.get({ source: "telegram" }) === 1);
  assert.equal(metrics.lastPoll.get({ source: "telegram" }), undefined);
  assert.equal(lines.length, 1);
  assert.ok(!lines[0]?.includes(BOT_TOKEN), lines[0]);
  assert.ok(!lines[0]?.includes("AAH-abcdefghij"), lines[0]);
  const logged = JSON.parse(lines[0] ?? "{}");
  assert.equal(logged.event, "intake.poll_failed");
  assert.equal(logged.source, "telegram");
  assert.match(logged.error, /bot\[redacted\]\/getUpdates/);
});

test("a failed Telegram delivery is counted and logged without the bot token", async (t) => {
  const { store, bridge, lines, metrics } = polling(t, async () => []);
  const item = store.createItem({ title: "T", request: "r", source: "manual" });
  store.addMessage(item.id, "factory", "Hello");
  await bridge.flush();
  assert.equal(metrics.pollErrors.get({ source: "telegram" }), 1);
  assert.ok(!lines.join("\n").includes(BOT_TOKEN));
  assert.equal(JSON.parse(lines[0] ?? "{}").event, "telegram.send_failed");
});

test("a completed Telegram poll stamps the last poll time", async (t) => {
  const { bridge, until, metrics } = polling(t, async () => []);
  const before = Date.now() / 1000;
  bridge.start();
  await until(() => metrics.lastPoll.get({ source: "telegram" }) !== undefined);
  assert.ok((metrics.lastPoll.get({ source: "telegram" }) ?? 0) >= before);
  assert.equal(metrics.pollErrors.get({ source: "telegram" }), 0);
});

test("a message after deleting the factory with the newest messages is still sent (#52)", async () => {
  const { store, calls, bridge, item } = setup({}, { docs: true });
  const docs = store.repos.factories.factories()[1];
  assert.ok(docs);
  const gone = store.createItem({
    title: "Docs page",
    request: "r",
    source: "manual",
    factoryId: docs.id,
  });
  store.addMessage(gone.id, "factory", "one");
  store.addMessage(gone.id, "factory", "two");
  await bridge.flush();
  assert.equal(calls.length, 2);
  store.updateItem(gone.id, { stage: "complete" });
  store.repos.factories.deleteFactory(docs.id);

  // Without AUTOINCREMENT the new message took a freed id, at or below tg:cursor.
  store.addMessage(item.id, "factory", "after the delete");
  assert.ok(store.lastMessageId() > Number(store.getKv("tg:cursor")));
  await bridge.flush();
  assert.equal(calls.length, 3);
  assert.match(String(calls[2]?.[1].text), /after the delete$/);
});
