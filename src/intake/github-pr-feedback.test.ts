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
  review?: number;
}

interface GitHub {
  state?: string;
  reviews?: Remark[];
  inline?: Remark[];
  comments?: Remark[];
  /** Repository permission by login; a login missing here has none. */
  permissions?: Record<string, string>;
  /** The login each token acts as, over the defaults (agent-secret: nakara-agent). */
  users?: Record<string, string>;
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
  const oldGhToken = process.env.GH_TOKEN;
  const oldGithubToken = process.env.GITHUB_TOKEN;
  t.after(async () => {
    process.env.PATH = oldPath;
    const restore = (name: string, value: string | undefined) => {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    };
    restore("NAKARA_AGENT_GH_TOKEN", oldAgent);
    restore("NAKARA_FOREMAN_GH_TOKEN", oldForeman);
    restore("GH_TOKEN", oldGhToken);
    restore("GITHUB_TOKEN", oldGithubToken);
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
if (args[1] === "user") {
  // As gh: GH_TOKEN over GITHUB_TOKEN over the stored login; empty is unset.
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "stored";
  out(({ "agent-secret": "nakara-agent", "foreman-secret": "nakara-foreman", ...gh.users })[token] ?? "operator");
}
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
  // gh's own stored login, "stored" in users: no ambient token.
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
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
    waiting: { reviews: [], inline: [] },
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

test("a review pending when polled becomes feedback once it is submitted, with its inline comments", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  const draft = { id: 10, login: "alice", state: "PENDING", body: "" };
  const inline = {
    id: 20,
    login: "alice",
    body: "Off by one here.",
    path: "src/a.ts",
    line: 12,
    review: 10,
  };
  await github({ reviews: [draft], inline: [inline] });
  // The first poll: the draft is not older feedback, it waits.
  await poll();
  // A later comment moves the cursor past the draft's ids.
  await github({
    reviews: [draft],
    inline: [inline],
    comments: [{ id: 30, login: "alice", body: "One more thing." }],
    permissions: { alice: "write" },
  });
  await poll();
  assert.equal(feedback().length, 1);
  await poll();
  assert.equal(feedback().length, 1);
  // Submitted: the review and its inline comment are feedback now.
  await github({
    reviews: [{ ...draft, state: "CHANGES_REQUESTED", body: "See inline." }],
    inline: [inline],
    comments: [{ id: 30, login: "alice", body: "One more thing." }],
    permissions: { alice: "write" },
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 2);
  const payload = JSON.parse(events[1]?.payload ?? "{}");
  assert.deepEqual(
    payload.reviews.map((r: { state: string }) => r.state),
    ["CHANGES_REQUESTED"],
  );
  assert.deepEqual(
    payload.inline.map((r: { body: string }) => r.body),
    ["Off by one here."],
  );
  assert.deepEqual(payload.comments, []);
  // Once.
  await poll();
  assert.equal(feedback().length, 2);
});

test("with a shared identity, only a comment that starts with /nakara is feedback", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  // The agent token acts as the Operator, a writer.
  const shared = {
    users: { "agent-secret": "operator" },
    permissions: { operator: "admin" },
  };
  await github(shared);
  await poll();
  await github({
    ...shared,
    reviews: [
      { id: 11, login: "operator", state: "COMMENTED", body: "Done, fixed." },
    ],
    comments: [{ id: 31, login: "operator", body: "Rename the flag." }],
  });
  await poll();
  assert.deepEqual(feedback(), []);
  await github({
    ...shared,
    reviews: [
      { id: 11, login: "operator", state: "COMMENTED", body: "Done, fixed." },
      {
        id: 12,
        login: "operator",
        state: "COMMENTED",
        body: "/nakara Split the module.",
      },
    ],
    comments: [
      { id: 31, login: "operator", body: "Rename the flag." },
      { id: 32, login: "operator", body: "  /NAKARA rename the flag, please." },
    ],
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]?.payload ?? "{}");
  // The text after the trigger is the feedback.
  assert.deepEqual(
    payload.reviews.map((r: { body: string }) => r.body),
    ["Split the module."],
  );
  assert.deepEqual(
    payload.comments.map((r: { body: string }) => r.body),
    ["rename the flag, please."],
  );
  // An agent's reply that slipped through with the trigger still needs write
  // access: a shared login without it writes no feedback.
  await github({
    users: { "agent-secret": "operator" },
    comments: [{ id: 33, login: "operator", body: "/nakara loop" }],
  });
  await poll();
  assert.equal(feedback().length, 1);
});

test("with separate identities, a writer's comment counts with or without /nakara, and the agent's never without it", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  await poll();
  await github({
    comments: [
      { id: 31, login: "alice", body: "/nakara Rename the flag." },
      { id: 32, login: "nakara-agent", body: "Fixed in abc123." },
    ],
    permissions: { alice: "write", "nakara-agent": "write" },
  });
  await poll();
  const payload = JSON.parse(feedback()[0]?.payload ?? "{}");
  assert.deepEqual(
    payload.comments.map((r: { author: string; body: string }) => [
      r.author,
      r.body,
    ]),
    [["alice", "Rename the flag."]],
  );
});

test("with distinct agent and foreman accounts, their /nakara is never feedback; a writer's comment without it is", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  // The tokens act as nakara-agent and nakara-foreman, gh's login as the
  // Operator: both of Nakara's logins are distinct, even with write access.
  const distinct = {
    permissions: {
      alice: "write",
      "nakara-agent": "write",
      "nakara-foreman": "write",
      operator: "admin",
    },
  };
  await github(distinct);
  await poll();
  await github({
    ...distinct,
    reviews: [
      {
        id: 11,
        login: "nakara-foreman",
        state: "COMMENTED",
        body: "/nakara Redo it.",
      },
    ],
    inline: [{ id: 21, login: "nakara-agent", body: "/nakara loop" }],
    comments: [
      // Posted past the gh guard, e.g. with curl and the agent token.
      { id: 31, login: "nakara-agent", body: "/nakara Fix it again." },
      { id: 32, login: "nakara-foreman", body: "/nakara" },
    ],
  });
  await poll();
  assert.deepEqual(feedback(), []);
  await github({
    ...distinct,
    comments: [
      { id: 31, login: "nakara-agent", body: "/nakara Fix it again." },
      { id: 32, login: "nakara-foreman", body: "/nakara" },
      { id: 33, login: "alice", body: "Rename the flag." },
      { id: 34, login: "nakara-agent", body: "/nakara Once more." },
    ],
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]?.payload ?? "{}");
  assert.deepEqual(payload.authors, ["alice"]);
  assert.deepEqual(
    payload.comments.map((r: { body: string }) => r.body),
    ["Rename the flag."],
  );
});

test("a shared foreman token keeps the /nakara rule; an unreadable Operator login reads the remark again", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  // The foreman token acts as the Operator; the agent's is distinct. gh's
  // own login cannot be read yet.
  const users = { "foreman-secret": "operator", stored: "" };
  const permissions = { operator: "admin", "nakara-agent": "write" };
  await github({ users, permissions });
  await poll();
  const comments = [
    { id: 31, login: "operator", body: "Done, fixed." },
    { id: 32, login: "operator", body: "/nakara Rename the flag." },
    { id: 33, login: "nakara-agent", body: "/nakara loop" },
  ];
  await github({ users, permissions, comments });
  await assert.rejects(poll(), /no GitHub login for Operator/);
  assert.deepEqual(feedback(), []);
  // Once it reads, the same remarks are read again.
  await github({
    users: { "foreman-secret": "operator" },
    permissions,
    comments,
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]?.payload ?? "{}");
  assert.deepEqual(
    payload.comments.map((r: { author: string; body: string }) => [
      r.author,
      r.body,
    ]),
    [["operator", "Rename the flag."]],
  );
});

test("an agent or foreman token exported as GH_TOKEN or GITHUB_TOKEN never answers for the Operator", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  // The deployment exports the bot tokens too: neither may make its login
  // the Operator's, so both stay distinct.
  process.env.GH_TOKEN = "agent-secret";
  process.env.GITHUB_TOKEN = "foreman-secret";
  const permissions = {
    alice: "write",
    "nakara-agent": "write",
    "nakara-foreman": "write",
  };
  await github({ permissions });
  await poll();
  await github({
    permissions,
    comments: [
      { id: 31, login: "nakara-agent", body: "/nakara Fix it again." },
      { id: 32, login: "nakara-foreman", body: "/nakara Redo it." },
    ],
  });
  await poll();
  assert.deepEqual(feedback(), []);
});

test("the Operator logged in through an ambient token of their own keeps a shared identity", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  // No stored login: the Operator's own token in GH_TOKEN is their login,
  // as with the personal opt-in; the foreman token is theirs too.
  process.env.GH_TOKEN = "operator-secret";
  const state = {
    users: {
      "operator-secret": "operator",
      "foreman-secret": "operator",
      stored: "",
    },
    permissions: { operator: "admin" },
  };
  await github(state);
  await poll();
  await github({
    ...state,
    comments: [{ id: 31, login: "operator", body: "/nakara Rename the flag." }],
  });
  await poll();
  assert.equal(feedback().length, 1);
});

test("a bare /nakara, with nothing or only whitespace after it, is feedback too", async (t) => {
  const { github, poll, feedback } = await feedbackPoller(t);
  // Shared identity: the agent token acts as the Operator, a writer.
  const shared = {
    users: { "agent-secret": "operator" },
    permissions: { operator: "admin", alice: "write" },
  };
  await github(shared);
  await poll();
  await github({
    ...shared,
    reviews: [
      { id: 11, login: "operator", state: "COMMENTED", body: "/nakara" },
    ],
    comments: [
      { id: 31, login: "operator", body: "  /NAKARA  \n\t " },
      // Separate identity: a writer's bare trigger counts the same way.
      { id: 32, login: "alice", body: "/nakara" },
    ],
  });
  await poll();
  const events = feedback();
  assert.equal(events.length, 1);
  const payload = JSON.parse(events[0]?.payload ?? "{}");
  assert.deepEqual(
    payload.reviews.map((r: { author: string; body: string }) => [
      r.author,
      r.body,
    ]),
    [["operator", ""]],
  );
  assert.deepEqual(
    payload.comments.map((r: { author: string; body: string }) => [
      r.author,
      r.body,
    ]),
    [
      ["operator", ""],
      ["alice", ""],
    ],
  );
  assert.match(payload.prompt, /\(no text after \/nakara\)/);
});
