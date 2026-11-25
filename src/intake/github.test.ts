import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { Factory } from "../orchestrator/factory.ts";
import { Logger } from "../telemetry/log.ts";
import { Metrics } from "../telemetry/metrics.ts";
import { GithubPoller } from "./github.ts";

const PR1 = "https://github.com/o/r/pull/1";
const PR2 = "https://github.com/o/r/pull/2";

/** One work item, the real poller, and a fake gh serving prs.json. */
async function pollerWithGh(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-poll-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const prsFile = join(dir, "prs.json");
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(prsFile)}, "utf8"));
const [, , , sub, url] = process.argv;
const pr = prs[url];
console.log(JSON.stringify(sub === "checks" ? [{ name: "CI", bucket: pr.checks }] : { state: pr.state }));
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  const github = (prs: Record<string, { state: string; checks: string }>) =>
    writeFile(prsFile, JSON.stringify(prs));

  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Two PRs",
    request: "Ship",
    source: "manual",
  });
  const poller = new GithubPoller(factory);
  // biome-ignore lint/complexity/useLiteralKeys: Drive PR polling without issue intake.
  const poll = () => poller["checkPullRequests"]();
  return { store, item, github, poll };
}

test("a failing GitHub poll is counted, logged and still stamps the last poll", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-poll-errors-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(
    join(dir, "gh"),
    `#!/bin/sh\necho "HTTP 502: bad gateway" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const lines: string[] = [];
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
    {
      log: new Logger({ write: (l) => lines.push(l), secrets: [] }),
      metrics: new Metrics(),
    },
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const before = Date.now() / 1000;
  await new GithubPoller(factory).poll();

  const { metrics } = factory.telemetry;
  assert.ok(metrics.pollErrors.get({ source: "github" }) >= 1);
  assert.ok((metrics.lastPoll.get({ source: "github" }) ?? 0) >= before);
  const failed = lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "intake.poll_failed");
  assert.equal(failed.length, metrics.pollErrors.get({ source: "github" }));
  assert.equal(failed[0]?.source, "github");
  assert.match(failed[0]?.error, /HTTP 502/);
});

test("a PR gh cannot read does not stop the check of the others", async (t) => {
  const { store, item, github, poll } = await pollerWithGh(t);
  const other = store.createItem({
    title: "Other",
    request: "Ship",
    source: "manual",
  });
  // The fake gh knows PR 2 only, so reading PR 1 fails.
  store.updateItem(item.id, { pr_url: PR1 });
  store.updateItem(other.id, { pr_url: PR2 });
  await github({ [PR2]: { state: "MERGED", checks: "pass" } });
  await assert.rejects(poll(), new RegExp(`item ${item.id}: `));
  assert.equal(store.item(other.id)?.pr_merged, 1);
});
