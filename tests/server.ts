// Isolated browser fixture: production server, Store and poller; no external intake or agents.
import { execFileSync } from "node:child_process";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { snapshot } from "../src/backup.ts";
import { loadConfig } from "../src/config.ts";
import { Store, stubFactorySeed } from "../src/db.ts";
import { GithubPoller } from "../src/intake/github.ts";
import type { Factory } from "../src/orchestrator/factory.ts";
import { FactoryRegistry } from "../src/orchestrator/registry.ts";
import {
  endSnapshots,
  recordDiff,
  startSnapshots,
} from "../src/runner/snapshot.ts";
import { internalDir, repoPaths } from "../src/runner/workspace.ts";
import { createApp } from "../src/web/server.ts";
import type { Gh } from "../src/web/wizard.ts";
import {
  smokeDefinitionDir,
  smokeHarborDir,
  smokeLighthouseDir,
} from "./smoke.ts";

// Agents would get the operator's own gh token: the UI and /healthz must say so.
delete process.env.NAKARA_AGENT_GH_TOKEN;
process.env.NAKARA_ALLOW_PERSONAL_GH_TOKEN = "1";

// The repository's factory/ is also the operator's live definition, so a copy
// pins the switches the smoke tests read: Slack off, Telegram on.
const fixtureSwitches = { "slack-request": false, "telegram-request": true };
const copyFactory = async (dest: string) => {
  await cp("factory", dest, { recursive: true });
  for (const [name, enabled] of Object.entries(fixtureSwitches)) {
    const path = join(dest, "automations", name, "automation.md");
    const text = readFileSync(path, "utf8");
    const line = `enabled: ${enabled}`;
    writeFileSync(
      path,
      /^enabled: /m.test(text)
        ? text.replace(/^enabled: .*$/m, line)
        : text.replace(/^---\n/, `---\n${line}\n`),
    );
  }
};

// A per-server copy of the definition the smoke test may edit.
const dir = smokeDefinitionDir(Number(process.env.NAKARA_PORT));
await rm(dir, { recursive: true, force: true });
await copyFactory(dir);
// A second factory with its own copy, which the factories smoke test breaks and restores.
const harborDir = smokeHarborDir(Number(process.env.NAKARA_PORT));
await rm(harborDir, { recursive: true, force: true });
await copyFactory(harborDir);
// A third factory whose definition is broken from the start.
const lighthouseDir = smokeLighthouseDir(Number(process.env.NAKARA_PORT));
await rm(lighthouseDir, { recursive: true, force: true });
await mkdir(lighthouseDir, { recursive: true });
await writeFile(join(lighthouseDir, "factory.yaml"), "kind: [unclosed\n");
// A claude that only answers the model lookup, so the model picker shows a fixed list.
const effort = ["low", "medium", "high", "xhigh", "max"];
const fakeClaude = join(dir, "..", "fake-claude");
writeFileSync(
  fakeClaude,
  `#!/bin/sh\nread -r _\necho '${JSON.stringify({
    type: "control_response",
    response: {
      subtype: "success",
      request_id: "models",
      response: {
        models: [
          {
            value: "opus",
            resolvedModel: "claude-opus-5-5",
            displayName: "Opus 5.5",
            supportedEffortLevels: effort,
          },
          {
            value: "sonnet",
            resolvedModel: "claude-sonnet-5-5",
            displayName: "Sonnet 5.5",
            supportedEffortLevels: effort,
          },
          { value: "claude-haiku-4-5", displayName: "Haiku 4.5" },
        ],
      },
    },
  })}'\n`,
  { mode: 0o755 },
);
const config = loadConfig({
  ...process.env,
  NAKARA_CLAUDE_BIN: fakeClaude,
  // The host's real codex must not decide what the smoke pages show.
  NAKARA_CODEX_BIN: "/bin/false",
  NAKARA_DEFINITION_DIR: dir,
  NAKARA_DATA_DIR: join(dir, "..", "data"),
  NAKARA_GITHUB_MIRROR: "false",
  NAKARA_TELEGRAM_BOT_TOKEN: "",
  NAKARA_TELEGRAM_CHAT_ID: "",
});
// Definitions the wizard or Settings wrote in an earlier run of this server.
await rm(join(config.dataDir, "factories"), { recursive: true, force: true });
await rm(join(config.dataDir, "checkouts"), { recursive: true, force: true });
await rm(join(config.dataDir, "archive"), { recursive: true, force: true });
await rm(config.workDir, { recursive: true, force: true });
// A fourth factory, Quarry, Nakara-managed, which the settings smoke test
// renames, moves into a repository folder and deletes.
const quarryDir = join(config.dataDir, "factories", "quarry");
await copyFactory(quarryDir);
// The first factory, "default", runs the per-server definition copy; the
// second, "harbor", its own copy; the third, "lighthouse", has none that loads.
const store = new Store(":memory:", {
  defaultBudgetUsd: 15,
  factory: () => ({ ...stubFactorySeed(), definition_dir: dir }),
});
store.repos.factories.createFactory({
  ...stubFactorySeed(),
  slug: "harbor",
  name: "Harbor",
  avatar_color: "#0e7490",
  definition_dir: harborDir,
});
store.repos.factories.createFactory({
  ...stubFactorySeed(),
  slug: "lighthouse",
  name: "Lighthouse",
  avatar_color: "#b45309",
  definition_dir: lighthouseDir,
});
const quarry = store.repos.factories.createFactory({
  ...stubFactorySeed(),
  slug: "quarry",
  name: "Quarry",
  avatar_color: "#15803d",
  definition_dir: quarryDir,
  definition_mode: "managed",
});
const registry = new FactoryRegistry(store, config);
const factory = registry.default;
// biome-ignore lint/style/noNonNullAssertion: Registered above.
const harbor = registry.get("harbor")!;
// Work items and follow-ups are created, but no foreman turn or agent ever starts.
for (const f of registry.factories) f.pump = async () => {};
// The definition page may reload the definition from disk, so the fixture
// overrides are applied again after every successful reload.
function prepare(definition: NonNullable<Factory["definition"]>) {
  definition.factory.repositories = [
    { owner: "acme", name: "widgets" },
    { owner: "acme", name: "gadgets" },
  ];
  // Automations stay listed in the UI, but an explicit empty repo filter keeps
  // every GitHub trigger from polling a real repository.
  for (const automation of definition.automations)
    for (const trigger of automation.frontmatter.triggers)
      if (trigger.provider === "github")
        trigger.filter = { ...trigger.filter, repos: [] };
  // The New work form defaults to a manual automation.
  definition.automations.push({
    name: "nakara-manual",
    agent: definition.foreman.name,
    instructions: "",
    frontmatter: {
      enabled: true,
      displayName: "Nakara manual",
      triggers: [{ provider: "nakara", event: "manual" }],
    },
  });
  // An enabled schedule for Run now; the smoke server starts no scheduler.
  definition.automations.push({
    name: "nightly-digest",
    agent: definition.foreman.name,
    instructions: "Summarize yesterday's work.",
    frontmatter: {
      enabled: true,
      displayName: "Nightly digest",
      triggers: [
        {
          provider: "schedule",
          event: "cron_fired",
          schedule: { cron: "0 6 * * *" },
        },
      ],
    },
  });
}
// Repository access is recorded offline: one clone succeeds without branch
// protection, one is refused.
const probe: Factory["probeRepository"] = async (_cache, owner, name) => {
  if (name === "gadgets")
    throw Object.assign(new Error("Command failed"), {
      cmd: `gh repo clone ${owner}/${name}`,
      stderr: `GraphQL: Could not resolve to a Repository with the name '${owner}/${name}'. (repository)`,
    });
  return {
    defaultBranch: "main",
    protection:
      "main allows direct pushes or merges without an approving review. Protect it on GitHub: agents run with a token that can push.",
  };
};
for (const f of registry.factories) {
  const reload = f.reloadDefinition.bind(f);
  f.reloadDefinition = async () => {
    const result = await reload();
    if (result.ok && f.definition) prepare(f.definition);
    return result;
  };
  f.probeRepository = probe;
  await f.reloadDefinition();
}
if (!factory.definition || !harbor.definition)
  throw new Error("Missing fixture definition");
if (registry.get("lighthouse")?.definition)
  throw new Error("The lighthouse definition must not load");
await registry.checkRepositories();
// A fresh backup, so the shell shows no stale-backup alert.
snapshot(store.db, { ...config.backup, reason: "smoke" });
const item = store.createItem({
  title: "Smoke test work item",
  request: "Verify legacy navigation",
  source: "manual",
  automation: "issue-labeled",
});
store.createRun({
  item_id: item.id,
  role: "agent",
  agent: "implement",
  agent_type: "IMPLEMENT",
  harness: "claude",
  model: null,
  session_id: null,
  input: "Smoke test run",
  status: "succeeded",
});
store.updateItem(item.id, { status: "waiting_human" });
// One reviewed item per browser project (root and dev share this server): a
// finished agent run to follow up, and a live foreman turn whose log the test
// appends to. A SMOKE_FINISH line ends the turn, as a harness exit would.
/**
 * Real clones of acme/widgets and acme/gadgets for an item, snapshotted
 * around a run: a shell edit in widgets, and a generated file in gadgets
 * large enough to truncate its diff.
 */
async function snapshotRun(itemId: number, runId: number) {
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, stdio: "ignore" });
  const repos = [];
  for (const name of ["widgets", "gadgets"]) {
    const { path, bare, objects } = repoPaths(config, itemId, "acme", name);
    await rm(path, { recursive: true, force: true });
    if (!existsSync(bare)) {
      const seed = mkdtempSync(join(tmpdir(), `nakara-smoke-${name}-`));
      writeFileSync(join(seed, "config.yaml"), "color: red\nsize: 2\n");
      git(seed, "init", "--quiet", "--initial-branch=main");
      git(seed, "add", ".");
      git(
        seed,
        "-c",
        "user.name=smoke",
        "-c",
        "user.email=smoke@example.com",
        "commit",
        "-qm",
        "init",
      );
      git(seed, "clone", "--bare", "--quiet", seed, bare);
      rmSync(seed, { recursive: true, force: true });
    }
    git(bare, "clone", "--quiet", "--shared", bare, path);
    repos.push({ slug: `acme/${name}`, path, bare, objects });
  }
  const started = await startSnapshots(repos);
  const [widgets, gadgets] = repos;
  execFileSync("bash", ["-c", "sed -i 's/red/blue/' config.yaml"], {
    cwd: widgets?.path,
  });
  writeFileSync(
    join(gadgets?.path ?? "", "generated.txt"),
    Array.from({ length: 20_000 }, (_, i) => `generated line ${i}`).join("\n"),
  );
  const ended = await endSnapshots(repos, started);
  store.setRunSnapshots(runId, ended);
  // As the agent runner does at the run's end: its diff next to its log.
  const logPath = logFile({ id: runId, item_id: itemId });
  writeFileSync(logPath, "");
  await recordDiff(logPath, ended, repos);
  store.finishRun(runId, {
    status: "succeeded",
    result: null,
    error: null,
    cost_usd: 0,
    num_turns: null,
    duration_ms: null,
    session_id: null,
    log_path: logPath,
  });
}
/** Where a run logs, as the runners write it: the only place the API serves logs from. */
function logFile(run: { id: number; item_id: number }) {
  const dir = join(internalDir(config.workDir, run.item_id), "logs");
  mkdirSync(dir, { recursive: true });
  return join(dir, `run-${run.id}.jsonl`);
}
for (const name of ["A", "B"]) {
  const live = store.createItem({
    title: `Smoke run ${name}`,
    request: "Stream a run log",
    source: "manual",
  });
  store.updateItem(live.id, { stage: "reviewing", review_count: 1 });
  const agentRun = store.createRun({
    item_id: live.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    session_id: "smoke-session-7f3ca91",
    input: "Build the smoke feature and open a draft PR.",
    status: "succeeded",
  });
  await snapshotRun(live.id, agentRun.id);
  const turn = store.createRun({
    item_id: live.id,
    role: "foreman",
    agent: "foreman",
    agent_type: "FOREMAN",
    harness: "claude",
    model: "opus",
    session_id: null,
    input: "## New work item",
    status: "running",
  });
  const logPath = logFile(turn);
  writeFileSync(
    logPath,
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Reading the request." }] } })}\n`,
  );
  store.markRunStarted(turn.id, logPath);
  watchFile(logPath, { interval: 100 }, () => {
    if (!readFileSync(logPath, "utf8").includes("SMOKE_FINISH")) return;
    unwatchFile(logPath);
    store.finishRun(turn.id, {
      status: "succeeded",
      result: "Dispatched implement.",
      error: null,
      cost_usd: 0.12,
      num_turns: 3,
      duration_ms: 42_000,
      session_id: "smoke-foreman",
      log_path: logPath,
    });
  });
}
const review = store.createRun({
  item_id: item.id,
  role: "agent",
  agent: "review",
  agent_type: "REVIEW",
  harness: "claude",
  model: "opus",
  session_id: null,
  input: "Smoke test review",
  status: "running",
});
store.finishRun(review.id, {
  status: "failed",
  result: null,
  error: "Smoke test failure",
  cost_usd: 0.42,
  num_turns: 1,
  duration_ms: 65_000,
  session_id: null,
  log_path: null,
});
const live = store.createItem({
  title: "Live run item",
  request: "Show a live duration",
  source: "manual",
});
// A foreman turn shows a running run without taking an agent slot.
store.createRun({
  item_id: live.id,
  role: "foreman",
  agent: "foreman",
  agent_type: "FOREMAN",
  harness: "claude",
  model: "sonnet",
  session_id: null,
  input: "Smoke test turn",
  status: "running",
});
// One item per Activity stage group, source and needs-you state.
const spec = store.createItem({
  title: "Support month and day names in cron",
  request:
    "Support JAN–DEC and SUN–SAT in schedule cron so automations read naturally.",
  requester: "alwisofwan1",
  source: "github",
  sourceUrl: "https://github.com/alwisofwan1/nakara/issues/5",
});
store.updateItem(spec.id, {
  stage: "planning",
  status: "waiting_human",
  spec_state: "awaiting_approval",
  cost_usd: 1.12,
});
// The Work Item mockup: a conversation with run cards and a pending spec.
store.addMessage(
  spec.id,
  "factory",
  "Picked up the issue. Triage first, then a spec for your approval before any code changes.",
);
for (const [agent, type, result] of [
  [
    "triage",
    "TRIAGE",
    "Names are not supported today; parseCron throws on MON. Small, single file.",
  ],
  [
    "spec",
    "SPEC",
    "Draft spec PR #12: names in month and day-of-week fields, case-insensitive.",
  ],
] as const) {
  const run = store.createRun({
    item_id: spec.id,
    role: "agent",
    agent,
    agent_type: type,
    harness: "claude",
    model: "opus",
    session_id: null,
    input: "Fixture",
    status: "running",
  });
  store.finishRun(run.id, {
    status: "succeeded",
    result,
    error: null,
    cost_usd: 0.48,
    num_turns: 4,
    duration_ms: 245_000,
    session_id: null,
    log_path: null,
  });
}
store.addApproval(
  spec.id,
  "spec",
  "Approve the spec",
  "https://github.com/alwisofwan1/nakara/pull/12",
);
const building = store.createItem({
  title: "Daily digest of open work in Telegram",
  request: "Building fixture",
  source: "telegram",
});
store.updateItem(building.id, { stage: "building", cost_usd: 0.31 });
store.createRun({
  item_id: building.id,
  role: "agent",
  agent: "implement",
  agent_type: "IMPLEMENT",
  harness: "claude",
  model: null,
  session_id: null,
  input: "Smoke test run",
  // Queued or running runs would be dispatched or occupy a slot.
  status: "succeeded",
});
const done = store.createItem({
  title: "Weekly health check",
  request: "Complete fixture",
  source: "schedule",
  automation: "weekly-health-check",
});
store.updateItem(done.id, {
  stage: "complete",
  status: "done",
  review_count: 1,
});
// One running turn per browser project for the Stop run smoke test. No process
// runs it here, so stopping it ends it at once (runs 11 and 12).
for (const name of ["A", "B"]) {
  const stoppable = store.createItem({
    title: `Stop run ${name}`,
    request: "Stop a running run",
    source: "manual",
  });
  const turn = store.createRun({
    item_id: stoppable.id,
    role: "foreman",
    agent: "foreman",
    agent_type: "FOREMAN",
    harness: "claude",
    model: "opus",
    session_id: null,
    input: "## New work item",
    status: "running",
  });
  const logPath = logFile(turn);
  writeFileSync(
    logPath,
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Dispatching implement." }] } })}\n`,
  );
  store.markRunStarted(turn.id, logPath);
}
// The complete item's review, after the Stop run turns so their ids stay put.
const doneReview = store.createRun({
  item_id: done.id,
  role: "agent",
  agent: "review",
  agent_type: "REVIEW",
  harness: "claude",
  model: null,
  session_id: null,
  input: "Review the PR",
  status: "running",
});
store.finishRun(doneReview.id, {
  status: "succeeded",
  result: "Verdict: accepted",
  error: null,
  cost_usd: 0,
  num_turns: 1,
  duration_ms: 1000,
  session_id: null,
  log_path: null,
  review_verdict: "accepted",
});
// Inbox: a ready PR, plus specs and a question per browser project to act on.
const handoff = store.createItem({
  title: "Dashboard card for cost per merged PR",
  request: "PR fixture",
  source: "manual",
});
store.updateItem(handoff.id, {
  stage: "handoff",
  status: "waiting_human",
  pr_url: "https://github.com/alwisofwan1/nakara/pull/10",
  cost_usd: 2.4,
});
// The PR is fixture data: the poller must not ask GitHub about it.
store.itemsWithOpenPr = () => [];
for (const project of ["root", "proxy", "dev"]) {
  for (const decision of ["approve", "reject"]) {
    const spec = store.createItem({
      title: `Cron spec to ${decision} (${project})`,
      request: "Spec fixture",
      source: "manual",
    });
    store.updateItem(spec.id, {
      stage: "planning",
      status: "waiting_human",
      spec_state: "awaiting_approval",
    });
    store.addMessage(spec.id, "factory", "Spec ready for approval.");
    store.addApproval(
      spec.id,
      "spec",
      "parseCron accepts JAN–DEC and SUN–SAT in the month and day-of-week fields.",
      "https://github.com/alwisofwan1/nakara/pull/12",
    );
  }
  const question = store.createItem({
    title: `Digest question (${project})`,
    request: "Question fixture",
    source: "manual",
  });
  store.updateItem(question.id, { stage: "planning", status: "waiting_human" });
  const ask = "Which time should the digest go out, and only on weekdays?";
  store.addMessage(question.id, "factory", ask);
  store.addApproval(question.id, "question", ask, null, [
    "09:00 UTC on weekdays",
    "17:00 UTC every day",
  ]);
}
// One item per remaining Work Item action card.
const question = store.createItem({
  title: "Retry the last agent",
  request: "Question fixture",
  source: "manual",
});
store.updateItem(question.id, { stage: "triage", status: "waiting_human" });
store.addApproval(
  question.id,
  "question",
  "If the last run was the reviewer, should retry re-run review or go back to implement?",
  null,
);
const verifying = store.createItem({
  title: "Verify the retry flow",
  request: "Live fixture",
  source: "manual",
});
store.updateItem(verifying.id, { stage: "building", cost_usd: 0.9 });
// A running agent run: it occupies one slot, and its log tails into the card.
const verifyRun = store.createRun({
  item_id: verifying.id,
  role: "agent",
  agent: "verify",
  agent_type: "VERIFY",
  harness: "codex",
  model: null,
  session_id: null,
  input: "Verify the retry flow",
  status: "running",
});
const verifyLog = logFile(verifyRun);
writeFileSync(
  verifyLog,
  ["$ npm test -- src/web", "✓ items.test.ts (12)", "✓ retry.test.ts (4)"]
    .map((text) =>
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text }] },
      }),
    )
    .join("\n")
    .concat("\n"),
);
store.markRunStarted(verifyRun.id, verifyLog);
const retry = store.createItem({
  title: "Retry failed work items",
  request: "Handoff fixture",
  source: "github",
  sourceUrl: "https://github.com/acme/widgets/issues/23",
  repo: "acme/widgets",
});
store.updateItem(retry.id, {
  stage: "handoff",
  pr_url: "https://github.com/acme/widgets/pull/14",
  review_count: 1,
  cost_usd: 3.4,
});
const exhausted = store.createItem({
  title: "Budget exhausted item",
  request: "Failed fixture",
  source: "manual",
  budgetUsd: 15,
});
store.updateItem(exhausted.id, { stage: "building", cost_usd: 15 });
store.addMessage(
  exhausted.id,
  "factory",
  "Budget exhausted after 2 revisions. Raise the budget to let the foreman continue.",
);
// A codex item that spent nothing and stopped at its run limit.
const looping = store.createItem({
  title: "Run limit item",
  request: "Run limit fixture",
  source: "manual",
});
store.updateItem(looping.id, {
  stage: "building",
  status: "paused",
  cost_usd: 0,
  run_count: 50,
  max_runs: 50,
});
store.addMessage(
  looping.id,
  "factory",
  "Run limit reached (50 of 50 runs, foreman turns and failed runs included). Press Raise run limit on the work item to continue, or cancel it.",
);
const cancelled = store.createItem({
  title: "Cancelled item",
  request: "Cancelled fixture",
  source: "manual",
});
store.updateItem(cancelled.id, { stage: "cancelled", status: "done" });
// A run a restart cut short, recovered as at startup: interrupted, with a
// queued run that resumes it in its session (pump never starts it here).
const restarted = store.createItem({
  title: "Interrupted by a restart",
  request: "Interrupted fixture",
  source: "manual",
});
store.updateItem(restarted.id, { stage: "building", cost_usd: 1.8 });
const cut = store.createRun({
  item_id: restarted.id,
  role: "agent",
  agent: "implement",
  agent_type: "IMPLEMENT",
  harness: "claude",
  model: "opus",
  session_id: "smoke-session-4b21e07",
  input: "Build the restart fixture and open a draft PR.",
  status: "running",
});
store.transaction(() =>
  store.interruptRun(
    cut.id,
    {
      result: null,
      cost_usd: 0,
      num_turns: null,
      duration_ms: 95_000,
      session_id: null,
    },
    "Nakara restarted while this run was in progress.",
  ),
);
// Harbor's work, created last so the default factory's item and run ids stay
// as the other specs expect: a question in the Inbox and a finished run.
const harborQuestion = store.createItem({
  title: "Harbor berth schedule question",
  request: "Question fixture",
  source: "manual",
  factoryId: harbor.record?.id,
});
store.updateItem(harborQuestion.id, {
  stage: "planning",
  status: "waiting_human",
});
store.addApproval(
  harborQuestion.id,
  "question",
  "Should berth slots be bookable a week ahead?",
  null,
);
const harborWork = store.createItem({
  title: "Harbor tide table import",
  request: "Run fixture",
  source: "manual",
  factoryId: harbor.record?.id,
});
store.updateItem(harborWork.id, { stage: "building", cost_usd: 0.6 });
const harborRun = store.createRun({
  item_id: harborWork.id,
  role: "agent",
  agent: "implement",
  agent_type: "IMPLEMENT",
  harness: "claude",
  model: "opus",
  session_id: null,
  input: "Import the tide tables",
  status: "running",
});
// A run without snapshots whose log records an edit: its Diff tab falls back to the log.
const harborLog = logFile(harborRun);
writeFileSync(
  harborLog,
  `${JSON.stringify({
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          name: "Edit",
          input: {
            file_path: "src/tides.ts",
            old_string: 'const source = "csv";',
            new_string: 'const source = "noaa";',
          },
        },
      ],
    },
  })}\n`,
);
store.finishRun(harborRun.id, {
  status: "succeeded",
  result: "Imported.",
  error: null,
  cost_usd: 0.6,
  num_turns: 3,
  duration_ms: 75_000,
  session_id: null,
  log_path: harborLog,
});
// Quarry's active item, which keeps it from being deleted until it is cancelled.
store.createItem({
  title: "Quarry gravel survey",
  request: "Settings fixture",
  source: "manual",
  factoryId: quarry.id,
});
// The New factory wizard's gh, offline: logged in, one organization, and an
// agent token that can't see acme/gadgets.
const wizardRepos: Record<string, object[]> = {
  "smoke-operator": [
    {
      nameWithOwner: "smoke-operator/dotfiles",
      isPrivate: false,
      primaryLanguage: { name: "Shell" },
      updatedAt: "2026-09-01T00:00:00Z",
    },
  ],
  acme: ["widgets", "gadgets", "sprockets"].map((name, index) => ({
    nameWithOwner: `acme/${name}`,
    isPrivate: index < 2,
    primaryLanguage: index === 0 ? { name: "TypeScript" } : null,
    updatedAt: new Date(Date.now() - (index + 1) * 3_600_000).toISOString(),
  })),
};
// Creating a factory: its "-api" repository already has the label, and its
// first clone fails, so Retry has a failed step to resume.
const wizardGh: Gh = async (args) => {
  const done = (stdout: string) => ({ ok: true, stdout, stderr: "" });
  if (args[0] === "label")
    return args[4]?.endsWith("-api")
      ? {
          ok: false,
          stdout: "",
          stderr: `label with name "${args[2]}" already exists; use \`--force\` to update its color and description`,
        }
      : done("");
  if (args[0] === "repo" && args[1] === "clone") {
    await mkdir(join(args[3] ?? "", ".git"), { recursive: true });
    return done("");
  }
  if (args[0] === "auth")
    return done(
      "github.com\n  ✓ Logged in to github.com account smoke-operator (keyring)\n  - Token scopes: 'repo', 'read:org'\n",
    );
  if (args[1] === "user/orgs") return done("acme\n");
  if (args[0] === "repo")
    return done(JSON.stringify(wizardRepos[args[2] ?? ""] ?? []));
  return args[1] === "repos/acme/gadgets"
    ? { ok: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
    : done("true\n");
};
const failedOnce = new Set<string>();
const wizardClone = async (_cache: string, owner: string, name: string) => {
  const repo = `${owner}/${name}`;
  if (name.endsWith("-api") && !failedOnce.has(repo)) {
    failedOnce.add(repo);
    throw Object.assign(new Error("Command failed: gh repo clone"), {
      stderr: `fatal: unable to access \x27https://github.com/${repo}.git/\x27: Could not resolve host: github.com`,
    });
  }
};
// The Warp examples, offline: the default example only.
const wizardWarp = async (dest: string) => {
  const example = join(dest, "examples", "00-warp-default-agents");
  await cp("factory", example, { recursive: true });
  await rm(join(example, "automations"), { recursive: true, force: true });
  await writeFile(join(dest, "LICENSE"), "MIT License\n");
};
// A factory the wizard creates starts no work and checks its repositories offline.
registry.onAdded((created) => {
  created.pump = async () => {};
  created.probeRepository = probe;
});
// The registry is never started, so its scheduler starts no work either.
const poller = new GithubPoller(registry.factories);
poller.start(1);
const server = serve({
  fetch: createApp(
    registry,
    poller,
    config,
    "smoke-token",
    async () => ({
      title: "feat: retry failed work items",
      headRefName: "nakara/item-23",
      headRefOid: "9f3c2a1d4e5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d",
      baseRefName: "main",
      additions: 184,
      deletions: 22,
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
    }),
    {
      gh: wizardGh,
      env: { NAKARA_AGENT_GH_TOKEN: "github_pat_smoke" },
      scaffold: { cloneWarpExamples: wizardWarp },
      clone: wizardClone,
    },
  ).fetch,
  hostname: "127.0.0.1",
  port: config.port,
});
const stop = () => {
  poller.stop();
  server.close();
  store.db.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
