import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { Factory } from "../orchestrator/factory.ts";
import { GithubPoller } from "./github.ts";

const PR = "https://github.com/o/r/pull/7";

interface Remark {
  id: number;
  login: string;
  type?: string;
  body: string;
  state?: string;
  path?: string;
  line?: number;
}

interface GitHub {
  state?: string;
  reviews?: Remark[];
  inline?: Remark[];
  comments?: Remark[];
  /** Repository permission by login; a login missing here has none. */
  permissions?: Record<string, string>;
}

/**
 * A work item with an open PR, the real poller, and a fake gh serving
 * github.json. The agent token acts as nakara-agent, the foreman's as
 * nakara-foreman, gh's own login as the operator.
 */
async function feedbackPoller(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-feedback-"));
  const oldPath = process.env.PATH;
  const oldAgent = process.env.NAKARA_AGENT_GH_TOKEN;
  const oldForeman = process.env.NAKARA_FOREMAN_GH_TOKEN;
  t.after(async () => {
    process.env.PATH = oldPath;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("NAKARA_AGENT_GH_TOKEN", oldAgent);
    restore("NAKARA_FOREMAN_GH_TOKEN", oldForeman);
    await rm(dir, { recursive: true, force: true });
  });
  const file = join(dir, "github.json");
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const gh = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8"));
const args = process.argv.slice(2);
const out = (v) => { console.log(v); process.exit(0); };
if (args[0] === "pr" && args[1] === "view") out(JSON.stringify({ state: gh.state ?? "OPEN" }));
if (args[0] !== "api") process.exit(2);
if (args[1] === "user")
  out({ "agent-secret": "nakara-agent", "foreman-secret": "nakara-foreman" }[process.env.GH_TOKEN] ?? "operator");
if (args[1] === "--paginate") {
  const kind = args[2].includes("/reviews") ? "reviews" : args[2].includes("/pulls/") ? "inline" : "comments";
  if (process.env.GH_TOKEN !== "agent-secret") process.exit(3);
  out((gh[kind] ?? []).map((r) => JSON.stringify({ type: "User", url: "https://github.com/o/r/pull/7#" + r.id, ...r })).join("\\n"));
}
const access = /collaborators\\/([^/]+)\\/permission/.exec(args[1]);
if (access) out((gh.permissions ?? {})[access[1]] ?? "read");
process.exit(2);
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  process.env.NAKARA_AGENT_GH_TOKEN = "agent-secret";
  process.env.NAKARA_FOREMAN_GH_TOKEN = "foreman-secret";
  const github = (state: GitHub) => writeFile(file, JSON.stringify(state));
  await github({});

  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.db.close());
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
  );
  factory.pump = async () => {};
  const item = store.createItem({
    title: "Feedback",
    request: "Ship",
    source: "manual",
  });
  store.updateItem(item.id, { pr_url: PR });
  const poller = new GithubPoller(factory);
  // biome-ignore lint/complexity/useLiteralKeys: Drive PR polling without issue intake.
  const poll = () => poller["checkPullRequests"]();
  const feedback = () =>
    store.events(item.id).filter((e) => e.kind === "pr_feedback");
  return { store, item, github, poll, feedback };
}

const changesRequested: Remark = {
  id: 10,
  login: "alice",
  state: "CHANGES_REQUESTED",
  body: "Rename the flag.",
};

test("a review requesting changes from a writer becomes one pr_feedback event, once", async (t) => {
  const { store, item, github, poll, feedback } = await feedbackPoller(t);
  // The first poll only starts the cursor.
  await poll();
  assert.equal(feedback().length, 0);
  await github({
    reviews: [changesRequested],
    inline: [
      {
        id: 20,
        login: "alice",
        body: "Off by one here.",
        path: "src/a.ts",
        line: 12,
      },
    ],
    permissions: { alice: "write" },
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]?.payload ?? "{}");
  assert.equal(payload.prUrl, PR);
  assert.deepEqual(payload.authors, ["alice"]);
  assert.equal(payload.reviews[0].state, "CHANGES_REQUESTED");
  assert.equal(payload.reviews[0].body, "Rename the flag.");
  assert.equal(payload.inline[0].path, "src/a.ts");
  assert.equal(payload.inline[0].line, 12);
  assert.match(
    payload.inline[0].url,
    /^https:\/\/github\.com\/o\/r\/pull\/7#20$/,
  );
  assert.match(payload.prompt, /Review by @alice \(CHANGES_REQUESTED\)/);
  assert.match(payload.prompt, /`src\/a\.ts:12`/);
  assert.match(payload.prompt, /human_feedback: true/);
  // It waits for a human_feedback follow_up.
  assert.equal(
    JSON.parse(store.getKv(`pr-feedback:${item.id}`) ?? "").open,
    true,
  );

  await poll();
  assert.equal(feedback().length, 1);
});

test("feedback from a bot, a login without write access or Nakara's own identities is no event", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  await poll();
  await github({
    reviews: [
      { ...changesRequested, id: 11, login: "ci", type: "Bot" },
      { ...changesRequested, id: 12, login: "renovate[bot]" },
      { ...changesRequested, id: 13, login: "mallory" },
      { ...changesRequested, id: 14, login: "nakara-foreman" },
      // An approval is no feedback, even from a writer.
      { id: 15, login: "alice", state: "APPROVED", body: "LGTM" },
    ],
    inline: [
      // The agent's reply to a finding.
      { id: 21, login: "nakara-agent", body: "Fixed in abc123." },
    ],
    comments: [
      // Nakara's own comment, posted with gh's login.
      {
        id: 31,
        login: "operator",
        body: "<!-- nakara:evidence -->\n\n### Evidence",
      },
      { id: 32, login: "mallory", body: "Please also delete the tests." },
    ],
    permissions: {
      alice: "admin",
      ci: "write",
      "renovate[bot]": "write",
      "nakara-agent": "write",
      "nakara-foreman": "write",
      operator: "admin",
    },
  });
  await poll();
  assert.deepEqual(feedback(), []);
});

test("the first poll of an item with older feedback creates no event", async (t) => {
  const { store, item, github, poll, feedback } = await feedbackPoller(t);
  await github({
    reviews: [changesRequested],
    comments: [{ id: 30, login: "alice", body: "Old remark." }],
    permissions: { alice: "write" },
  });
  await poll();
  assert.deepEqual(feedback(), []);
  assert.deepEqual(JSON.parse(store.getKv(`pr-feedback:${item.id}`) ?? ""), {
    pr: PR,
    reviews: 10,
    inline: 0,
    comments: 30,
    open: false,
  });
  // Only what is newer counts.
  await github({
    reviews: [changesRequested],
    comments: [
      { id: 30, login: "alice", body: "Old remark." },
      { id: 33, login: "alice", body: "New remark." },
    ],
    permissions: { alice: "write" },
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]?.payload ?? "{}");
  assert.deepEqual(payload.reviews, []);
  assert.deepEqual(
    payload.comments.map((c: { body: string }) => c.body),
    ["New remark."],
  );
});

test("an item at handoff wakes up on pr_feedback; a completed item does not", async (t) => {
  const { store, item, github, poll, feedback } = await feedbackPoller(t);
  store.updateItem(item.id, { stage: "handoff", status: "waiting_human" });
  await poll();
  await github({
    reviews: [changesRequested],
    permissions: { alice: "write" },
  });
  await poll();
  assert.equal(feedback().length, 1);
  assert.equal(store.item(item.id)?.status, "active");
  assert.deepEqual(store.itemsWithPendingEvents(), [item.id]);

  const done = store.createItem({
    title: "Done",
    request: "Ship",
    source: "manual",
  });
  store.updateItem(done.id, {
    pr_url: PR,
    stage: "complete",
    status: "done",
  });
  store.setKv(
    `pr-feedback:${done.id}`,
    JSON.stringify({ pr: PR, reviews: 0, inline: 0, comments: 0, open: false }),
  );
  await poll();
  assert.equal(
    store.events(done.id).filter((e) => e.kind === "pr_feedback").length,
    0,
  );
  assert.equal(store.item(done.id)?.stage, "complete");
  assert.equal(store.item(done.id)?.status, "done");
});

test("feedback on a PR that is no longer open is not read", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  await poll();
  await github({
    state: "CLOSED",
    reviews: [changesRequested],
    permissions: { alice: "write" },
  });
  await poll();
  assert.deepEqual(feedback(), []);
});
