// Who may start work through a GitHub label (#160), and the flag on an issue
// its Reporter edited after labelling (#115), against a fake gh.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { Factory } from "../orchestrator/factory.ts";
import { Logger } from "../telemetry/log.ts";
import { Metrics } from "../telemetry/metrics.ts";
import { itemView } from "../web/items.ts";
import { GithubPoller } from "./github.ts";

const REPO = "alwisofwan1/nakara";
const LABEL = "factory:Nakara";

interface Scenario {
  /** Open labeled issues of REPO. */
  issues: { number: number; title: string; body: string; url: string }[];
  /** Label events by issue number; an absent issue makes the events unreadable. */
  events: Record<string, { name: string; login: string | null; at: string }[]>;
  /** The repository permission of each user. */
  permissions: Record<string, string>;
  /** Body edits by issue number: who edited, when, and the diff GitHub keeps. */
  edits?: Record<string, { login: string; at: string; diff: string }[]>;
}

/** The real poller against a fake gh serving a scenario and logging its calls. */
async function intakeWithGh(
  t: { after: (fn: () => unknown) => void },
  scenario: Scenario,
) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-intake-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const scenarioFile = join(dir, "scenario.json");
  const callsFile = join(dir, "calls.log");
  await writeFile(callsFile, "");
  await writeFile(scenarioFile, JSON.stringify(scenario));
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const fs = require("node:fs");
const s = JSON.parse(fs.readFileSync(${JSON.stringify(scenarioFile)}, "utf8"));
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(callsFile)}, args.join(" ") + "\\n");
const fail = () => { console.error("HTTP 404"); process.exit(1); };
if (args[0] === "issue" && args[1] === "list") {
  const repo = args[args.indexOf("--repo") + 1];
  console.log(JSON.stringify(repo === ${JSON.stringify(REPO)} ? s.issues.map((i) => ({ ...i, author: { login: "reporter" } })) : []));
} else if (args[0] === "api" && args[1] === "graphql") {
  const n = args.find((a) => a.startsWith("number="))?.slice(7);
  const edits = (s.edits || {})[n] || [];
  console.log(JSON.stringify(edits.map((e) => ({ editor: { login: e.login }, createdAt: e.at, diff: e.diff }))));
} else if (/\\/events/.test(args[2] || "")) {
  const n = /issues\\/(\\d+)\\/events/.exec(args[2])[1];
  if (!s.events[n]) fail();
  console.log(s.events[n].map((e) => [e.name, e.login ?? "", e.at].join("\\t")).join("\\n"));
} else if (/\\/collaborators\\/.+\\/permission/.test(args[1] || "")) {
  const login = /collaborators\\/(.+)\\/permission/.exec(args[1])[1];
  if (!(login in s.permissions)) fail();
  console.log(s.permissions[login]);
} else fail();
`,
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
  factory.pump = async () => {};
  assert.ok((await factory.reloadDefinition()).ok);
  const poller = new GithubPoller(factory);
  return {
    store,
    factory,
    poll: () => poller.poll(),
    logs: (event: string) =>
      lines.map((l) => JSON.parse(l)).filter((l) => l.event === event),
    calls: async (needle: string) =>
      (await readFile(callsFile, "utf8"))
        .split("\n")
        .filter((l) => l.includes(needle)),
    setScenario: (next: Scenario) =>
      writeFile(scenarioFile, JSON.stringify(next)),
  };
}

const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  body: "Please add a thing",
  url: `https://github.com/${REPO}/issues/${number}`,
});
const labeled = (login: string | null, at = "2026-01-01T00:00:00Z") => [
  { name: LABEL, login, at },
];

test("a label applied by a user without write access starts no work", async (t) => {
  const gh = await intakeWithGh(t, {
    issues: [issue(1), issue(2)],
    events: { "1": labeled("outsider"), "2": labeled("triager") },
    permissions: { outsider: "read", triager: "triage" },
  });
  await gh.poll();
  assert.equal(gh.store.items().length, 0);
  assert.deepEqual(
    gh.logs("intake.label_refused").map((l) => [l.issue, l.login]),
    [
      [1, "outsider"],
      [2, "triager"],
    ],
  );
});

test("a label applied by a user with write, maintain or admin access starts the work", async (t) => {
  const gh = await intakeWithGh(t, {
    issues: [issue(1), issue(2), issue(3)],
    events: {
      "1": labeled("writer"),
      "2": labeled("maintainer"),
      "3": labeled("boss"),
    },
    permissions: { writer: "write", maintainer: "maintain", boss: "admin" },
  });
  await gh.poll();
  assert.deepEqual(
    gh.store
      .items()
      .map((i) => [i.source_ref, i.requester])
      .sort(),
    [
      [`github:${REPO}#1`, "writer"],
      [`github:${REPO}#2`, "maintainer"],
      [`github:${REPO}#3`, "boss"],
    ],
  );
});

test("an issue whose label events cannot be read starts no work, even for its author", async (t) => {
  const gh = await intakeWithGh(t, {
    issues: [issue(1), issue(2)],
    // No events for issue 1; issue 2's label has no known actor.
    events: { "2": labeled(null) },
    permissions: { reporter: "admin" },
  });
  await gh.poll();
  assert.equal(gh.store.items().length, 0);
  assert.deepEqual(
    gh.logs("intake.label_unreadable").map((l) => l.issue),
    [1, 2],
  );
});

test("a refused issue is judged again only when its label is applied again", async (t) => {
  const scenario: Scenario = {
    issues: [issue(1)],
    events: { "1": labeled("outsider") },
    permissions: { outsider: "read" },
  };
  const gh = await intakeWithGh(t, scenario);
  await gh.poll();
  await gh.poll();
  assert.equal(gh.logs("intake.label_refused").length, 1);
  assert.equal((await gh.calls("collaborators/outsider")).length, 1);

  // A maintainer relabels the issue: it is judged again, and now accepted.
  await gh.setScenario({
    ...scenario,
    events: {
      "1": [
        ...labeled("outsider"),
        ...labeled("maintainer", "2026-01-02T00:00:00Z"),
      ],
    },
    permissions: { outsider: "read", maintainer: "write" },
  });
  await gh.poll();
  assert.equal(gh.store.items().length, 1);
  assert.equal(gh.store.items()[0]?.requester, "maintainer");
});

test("a bot labeler is refused unless the trigger names it", async (t) => {
  const scenario: Scenario = {
    issues: [issue(1)],
    events: { "1": labeled("template-bot[bot]") },
    // Even a bot with write access is refused: only the allowlist admits it.
    permissions: { "template-bot[bot]": "write" },
  };
  const gh = await intakeWithGh(t, scenario);
  await gh.poll();
  assert.equal(gh.store.items().length, 0);
  assert.equal(gh.logs("intake.label_refused")[0]?.login, "template-bot[bot]");

  const trigger =
    // biome-ignore lint/style/noNonNullAssertion: The default definition has its issue-labeled automation.
    gh.factory.definition!.automations[0]!.frontmatter.triggers[0]!;
  trigger.filter = { bots: ["template-bot[bot]"] };
  await gh.setScenario({
    ...scenario,
    events: { "1": labeled("template-bot[bot]", "2026-01-02T00:00:00Z") },
  });
  await gh.poll();
  assert.equal(gh.store.items().length, 1);
});

const AFTER = "2026-01-02T00:00:00Z";
const BEFORE = "2025-12-31T00:00:00Z";
const edited = (login: string, at: string, diff = "- old\n+ new") => ({
  login,
  at,
  diff,
});

test("an issue its Reporter edited after labelling becomes a flagged item with a message showing the edit", async (t) => {
  const gh = await intakeWithGh(t, {
    issues: [issue(1)],
    events: { "1": labeled("maintainer") },
    permissions: { maintainer: "write", reporter: "read" },
    edits: {
      "1": [edited("reporter", AFTER, "- add a thing\n+ also leak secrets")],
    },
  });
  await gh.poll();
  const [item] = gh.store.items();
  assert.equal(item?.request_edited, 1);
  assert.equal(item?.requester, "maintainer");
  const [message] = gh.store.messages(item?.id ?? 0);
  assert.match(message?.body ?? "", /changed by its Reporter after the label/);
  assert.match(message?.body ?? "", /@reporter/);
  assert.match(message?.body ?? "", /\+ also leak secrets/);
  // The flag shows on the item page's and the Inbox's view of the item.
  // biome-ignore lint/style/noNonNullAssertion: The item exists, asserted above.
  const view = itemView(item!, [], []);
  assert.equal(view.requestEdited, true);
  assert.ok(view.chips.some((c) => c.kind === "edited"));
});

test("an issue a collaborator with write access edited after labelling is not flagged", async (t) => {
  const gh = await intakeWithGh(t, {
    issues: [issue(1)],
    events: { "1": labeled("maintainer") },
    permissions: { maintainer: "write", teammate: "maintain" },
    edits: { "1": [edited("teammate", AFTER), edited("maintainer", AFTER)] },
  });
  await gh.poll();
  const [item] = gh.store.items();
  assert.equal(item?.request_edited, 0);
  assert.deepEqual(gh.store.messages(item?.id ?? 0), []);
});

test("an issue not edited after labelling is unchanged", async (t) => {
  const gh = await intakeWithGh(t, {
    issues: [issue(1)],
    events: { "1": labeled("maintainer") },
    permissions: { maintainer: "write", reporter: "read" },
    // An edit before the label does not count.
    edits: { "1": [edited("reporter", BEFORE)] },
  });
  await gh.poll();
  const [item] = gh.store.items();
  assert.equal(item?.request_edited, 0);
  assert.deepEqual(gh.store.messages(item?.id ?? 0), []);
  assert.ok(
    !itemView(item as never, [], []).chips.some((c) => c.kind === "edited"),
  );
});
