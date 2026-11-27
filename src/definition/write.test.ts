import assert from "node:assert/strict";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { AGENT_NAME as WEB_AGENT_NAME } from "../../web/features/agents/agent-name.ts";
import {
  slugify,
  AUTOMATION_NAME as WEB_AUTOMATION_NAME,
} from "../../web/features/automations/automation-name.ts";
import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { Scheduler } from "../intake/schedule.ts";
import { SlackBridge } from "../intake/slack.ts";
import { routeRequest, type TelegramFactories } from "../intake/telegram.ts";
import { Factory } from "../orchestrator/factory.ts";
import { fileRevision, HARNESS_FALLBACK, loadDefinition } from "./load.ts";
import {
  AGENT_NAME,
  AUTOMATION_NAME,
  type AgentDefaultsEdit,
  type AgentEdit,
  type AutomationEdit,
  appendLearning,
  LEARNINGS_CAP,
  LEARNINGS_PATH,
  createAgent,
  createAutomation,
  deleteAgent,
  deleteAutomation,
  isGitTracked,
  serializeAgent,
  serializeFactory,
  writeAgent,
  writeAutomation,
  writeFactoryFile,
} from "./write.ts";

const HELPER = `---
# Kept: comments, key order and keys Nakara does not know.
description: Helps.
x-team: platform # owner
model: sonnet
required_repos: [{ owner: o, name: r }]
---

# Helper

Help with **care**.
`;

async function tree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nakara-write-"));
  const files: Record<string, string> = {
    "factory.yaml": `schemaVersion: v1alpha1
name: t
repositories: [{ owner: o, name: r }]
agentDefaults: { model: auto, runner: std }
`,
    "runners/std.yaml": "description: std\n",
    "runners/big.yaml": "description: big\n",
    "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\nLead.\n",
    "agents/helper/agent.md": HELPER,
  };
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

/** The revision of an agent.md as the settings form would have loaded it. */
const revision = async (root: string, name: string) =>
  fileRevision(await readFile(join(root, "agents", name, "agent.md")));

/** Every file below `root` with its bytes. */
async function snapshot(root: string): Promise<Map<string, Buffer>> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = new Map<string, Buffer>();
  for (const e of entries.filter((e) => e.isFile())) {
    const path = join(e.parentPath, e.name);
    files.set(path, await readFile(path));
  }
  return files;
}

const edit: AgentEdit = {
  description: "Helps with releases.",
  harness: "codex",
  model: "gpt-5.5",
  effort: "high",
  runner: "big",
  spawnableBy: ["boss"],
  idleTimeoutMinutes: 15,
  prompt: "# Helper\n\nShip the release.",
};

test("a written agent loads with the edited values, its body and unknown keys", async () => {
  const root = await tree();
  const result = await writeAgent(
    root,
    "helper",
    edit,
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  // The result names the written bytes, so the page can save again without a reload.
  assert.deepEqual(result, {
    ok: true,
    changed: true,
    warnings: [],
    revision: await revision(root, "helper"),
  });

  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.errors));
  const agent = loaded.definition.agents.get("helper");
  assert.ok(agent);
  assert.equal(agent.description, "Helps with releases.");
  assert.deepEqual(agent.harness, {
    kind: "codex",
    model: "gpt-5.5",
    effort: "high",
  });
  assert.equal(agent.runner, "big");
  assert.deepEqual(agent.spawnableBy, ["boss"]);
  assert.equal(agent.idleTimeoutMinutes, 15);
  assert.equal(agent.instructions, "# Helper\n\nShip the release.");
  // Unknown keys survive with their comments; `model` moved into `harness`.
  assert.equal(agent.frontmatter?.["x-team"], "platform");
  assert.deepEqual(agent.frontmatter?.required_repos, [
    { owner: "o", name: "r" },
  ]);
  assert.equal(agent.frontmatter?.model, undefined);
  const text = await readFile(join(root, "agents/helper/agent.md"), "utf8");
  assert.match(text, /^---\n# Kept: comments.*\n/);
  assert.match(text, /x-team: platform # owner/);

  // Clearing every setting restores the defaults and keeps the body byte for byte.
  const cleared = await writeAgent(
    root,
    "helper",
    {
      description: null,
      harness: null,
      model: null,
      effort: null,
      runner: null,
      spawnableBy: null,
      idleTimeoutMinutes: null,
      prompt: agent.instructions,
    },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(cleared.ok);
  const reloaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(reloaded.ok);
  const plain = reloaded.definition.agents.get("helper");
  assert.equal(plain?.description, "");
  assert.equal(plain?.runner, "std");
  assert.equal(plain?.spawnableBy, undefined);
  assert.equal(plain?.idleTimeoutMinutes, 60);
  assert.equal(plain?.frontmatter?.["x-team"], "platform");
  assert.ok(
    (await readFile(join(root, "agents/helper/agent.md"), "utf8")).endsWith(
      "---\n\n# Helper\n\nShip the release.\n",
    ),
  );
});

test("an invalid edit returns the loader errors and leaves every file byte-identical", async () => {
  const root = await tree();
  const before = await snapshot(root);
  const result = await writeAgent(
    root,
    "helper",
    { ...edit, harness: "gemini" },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(!result.ok && result.code === "invalid");
  assert.equal(result.errors[0]?.path, "agents/helper/agent.md");
  assert.match(result.errors[0]?.message ?? "", /^harness\.type: /);
  assert.equal(result.errors[0]?.line, 7);

  const missingRunner = await writeAgent(
    root,
    "helper",
    { ...edit, runner: "gpu" },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(!missingRunner.ok && missingRunner.code === "invalid");
  assert.deepEqual(missingRunner.errors, [
    {
      path: "agents/helper/agent.md",
      message: 'runner "gpu" is not defined',
      line: 10,
    },
  ]);
  assert.deepEqual(await snapshot(root), before);
});

test("an unchanged form rewrites nothing, and a file without frontmatter gains one", () => {
  const same: AgentEdit = {
    description: "Helps.",
    harness: null,
    model: "sonnet",
    effort: null,
    runner: null,
    spawnableBy: null,
    idleTimeoutMinutes: null,
    prompt: "# Helper\n\nHelp with **care**.",
  };
  assert.equal(serializeAgent(HELPER, same), HELPER);
  assert.equal(
    serializeAgent("Help.\n", {
      ...same,
      description: null,
      model: null,
      prompt: "Help.",
    }),
    "Help.\n",
  );
  assert.equal(
    serializeAgent("Help.\n", { ...same, model: null, prompt: "Help more." }),
    "---\ndescription: Helps.\n---\nHelp more.\n",
  );
});

test("a definition inside a git work tree is reported as tracked", async () => {
  const root = await tree();
  assert.equal(await isGitTracked(join(root, "agents")), false);
  await mkdir(join(root, ".git"));
  assert.equal(await isGitTracked(join(root, "agents")), true);
});

test("the Default harness refuses to drop harness keys the form does not edit", async () => {
  const root = await tree();
  const path = join(root, "agents/helper/agent.md");
  await writeFile(
    path,
    "---\nharness:\n  type: claude\n  model: opus\n  reasoningLevel: high\n  auth: { kind: oauth }\n---\nHelp.\n",
  );
  const before = await snapshot(root);
  const result = await writeAgent(
    root,
    "helper",
    { ...edit, harness: null, model: null, effort: null, prompt: "Help." },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(!result.ok && result.code === "invalid");
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.path, "agents/helper/agent.md");
  assert.match(result.errors[0]?.message ?? "", /drop auth/);
  assert.deepEqual(await snapshot(root), before);

  // Changing the type keeps them.
  const kept = await writeAgent(
    root,
    "helper",
    { ...edit, harness: "claude-code", model: "opus", prompt: "Help." },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(kept.ok);
  assert.match(
    await readFile(path, "utf8"),
    /type: claude-code\n {2}model: opus\n {2}reasoningLevel: high\n {2}auth:/,
  );
});

test("a stale revision is a conflict and never overwrites the newer file", async () => {
  const root = await tree();
  const path = join(root, "agents/helper/agent.md");
  const stale = await revision(root, "helper");
  const newer = HELPER.replace("Help with", "Someone else edited");
  await writeFile(path, newer);
  const result = await writeAgent(
    root,
    "helper",
    edit,
    stale,
    HARNESS_FALLBACK,
  );
  assert.ok(!result.ok && result.code === "conflict");
  assert.match(result.message, /agents\/helper\/agent\.md changed on disk/);
  assert.equal(await readFile(path, "utf8"), newer);

  // A write that lands while the copy is validated is caught before the swap.
  const raced = await writeAgent(
    root,
    "helper",
    edit,
    await revision(root, "helper"),
    HARNESS_FALLBACK,
    () => writeFile(path, "---\nagentType: CUSTOM\n---\nRaced.\n"),
  );
  assert.ok(!raced.ok && raced.code === "conflict");
  assert.equal(
    await readFile(path, "utf8"),
    "---\nagentType: CUSTOM\n---\nRaced.\n",
  );
  // The temporary file is removed.
  assert.deepEqual(await readdir(join(root, "agents/helper")), ["agent.md"]);
});

test("the swap keeps the file mode and writes through a symlinked agent.md", async () => {
  const root = await tree();
  const outside = await mkdtemp(join(tmpdir(), "nakara-link-"));
  const real = join(outside, "helper.md");
  const link = join(root, "agents/helper/agent.md");
  await rename(link, real);
  await symlink(real, link);
  await chmod(real, 0o640);
  const result = await writeAgent(
    root,
    "helper",
    edit,
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(result.ok);
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal((await stat(real)).mode & 0o777, 0o640);
  assert.match(await readFile(real, "utf8"), /Ship the release\./);
  assert.deepEqual(await readdir(outside), ["helper.md"]);
  assert.deepEqual(await readdir(join(root, "agents/helper")), ["agent.md"]);
});

test("a CRLF agent.md keeps CRLF line endings throughout", async () => {
  const root = await tree();
  const path = join(root, "agents/helper/agent.md");
  const crlf = HELPER.replaceAll("\n", "\r\n");
  await writeFile(path, crlf);
  const result = await writeAgent(
    root,
    "helper",
    { ...edit, prompt: "# Helper\r\n\r\nShip the release.\r\nCarefully." },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(result.ok);
  const text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /[^\r]\n/);
  assert.match(text, /^---\r\n# Kept: comments/);
  assert.ok(
    text.endsWith(
      "---\r\n\r\n# Helper\r\n\r\nShip the release.\r\nCarefully.\r\n",
    ),
  );
  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  const agent = loaded.definition.agents.get("helper");
  assert.equal(
    agent?.instructions,
    "# Helper\r\n\r\nShip the release.\r\nCarefully.",
  );
  assert.equal(agent?.frontmatter?.["x-team"], "platform");
  assert.equal(agent?.runner, "big");
  // Saving the same values again is a no-op.
  const same = await writeAgent(
    root,
    "helper",
    { ...edit, prompt: agent?.instructions ?? "" },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.deepEqual(same, {
    ok: true,
    changed: false,
    warnings: [],
    revision: await revision(root, "helper"),
  });
  assert.equal(await readFile(path, "utf8"), text);
});

test("an edit that changes nothing writes nothing", async () => {
  const root = await tree();
  const path = join(root, "agents/helper/agent.md");
  const { mtimeMs } = await stat(path);
  const result = await writeAgent(
    root,
    "helper",
    {
      description: "Helps.",
      harness: null,
      model: "sonnet",
      effort: null,
      runner: null,
      spawnableBy: null,
      idleTimeoutMinutes: null,
      prompt: "# Helper\n\nHelp with **care**.",
    },
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.deepEqual(result, {
    ok: true,
    changed: false,
    warnings: [],
    revision: await revision(root, "helper"),
  });
  assert.equal((await stat(path)).mtimeMs, mtimeMs);
  // Clearing the last setting leaves an empty frontmatter the loader reads.
  assert.equal(
    serializeAgent("---\ndescription: x\n---\nHelp.\n", {
      description: null,
      harness: null,
      model: null,
      effort: null,
      runner: null,
      spawnableBy: null,
      idleTimeoutMinutes: null,
      prompt: "Help.",
    }),
    "---\n{}\n---\nHelp.\n",
  );
});

test("a created agent writes a valid agent.md that loads under the foreman", async () => {
  const root = await tree();
  const result = await createAgent(
    root,
    {
      name: "docs-writer",
      type: "CUSTOM",
      description: "Writes docs: guides and READMEs.",
      prompt: "# Docs\r\n\r\nWrite the docs.\r\n",
    },
    HARNESS_FALLBACK,
  );
  assert.deepEqual(result, { ok: true, changed: true, warnings: [] });
  assert.equal(
    await readFile(join(root, "agents/docs-writer/agent.md"), "utf8"),
    '---\ndescription: "Writes docs: guides and READMEs."\nagentType: CUSTOM\n---\n\n# Docs\n\nWrite the docs.\n',
  );
  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  const agent = loaded.definition.agents.get("docs-writer");
  assert.equal(agent?.type, "CUSTOM");
  assert.equal(agent?.description, "Writes docs: guides and READMEs.");
  assert.equal(agent?.instructions, "# Docs\n\nWrite the docs.");
  assert.equal(loaded.definition.foreman.name, "boss");

  // Without a description or prompt, only the type is written.
  assert.ok(
    (
      await createAgent(
        root,
        { name: "bare", type: "REVIEW", description: "  ", prompt: "" },
        HARNESS_FALLBACK,
      )
    ).ok,
  );
  assert.equal(
    await readFile(join(root, "agents/bare/agent.md"), "utf8"),
    "---\nagentType: REVIEW\n---\n",
  );
});

test("creating an agent refuses a taken or invalid name and an invalid tree, writing nothing", async () => {
  const root = await tree();
  const before = await snapshot(root);
  const agent = {
    type: "CUSTOM" as const,
    description: null,
    prompt: "Work.",
  };

  const taken = await createAgent(
    root,
    { ...agent, name: "helper" },
    HARNESS_FALLBACK,
  );
  assert.ok(!taken.ok && taken.code === "conflict");
  assert.match(taken.message, /agents\/helper already exists/);

  for (const name of ["../escape", "Helper", "-x", "new", "", "a/b"]) {
    const invalid = await createAgent(
      root,
      { ...agent, name },
      HARNESS_FALLBACK,
    );
    assert.ok(!invalid.ok && invalid.code === "invalid", name);
  }

  // A second foreman makes the tree invalid: the loader's error comes back.
  const foreman = await createAgent(
    root,
    { ...agent, name: "boss-2", type: "FOREMAN" },
    HARNESS_FALLBACK,
  );
  assert.ok(!foreman.ok && foreman.code === "invalid");
  assert.deepEqual(foreman.errors, [
    {
      path: "agents/",
      message: "exactly one agent must declare agentType: FOREMAN (found 2)",
    },
  ]);
  assert.deepEqual(await snapshot(root), before);
  assert.deepEqual((await readdir(join(root, "agents"))).sort(), [
    "boss",
    "helper",
  ]);
});

test("deleting an agent removes its folder and the tree still loads", async () => {
  const root = await tree();
  await mkdir(join(root, "agents/helper/skills/notes"), { recursive: true });
  await writeFile(
    join(root, "agents/helper/skills/notes/SKILL.md"),
    "---\nname: notes\ndescription: Notes.\n---\nTake notes.\n",
  );
  const result = await deleteAgent(
    root,
    "helper",
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.deepEqual(result, { ok: true, changed: true, warnings: [] });
  assert.deepEqual(await readdir(join(root, "agents")), ["boss"]);
  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  assert.deepEqual([...loaded.definition.agents.keys()], ["boss"]);
});

test("deleting the foreman or a referenced agent is refused with the loader's message", async () => {
  const root = await tree();
  await mkdir(join(root, "automations/release"), { recursive: true });
  await writeFile(
    join(root, "automations/release/automation.md"),
    "---\nagent: helper\ntriggers:\n  - provider: schedule\n    event: cron\n    schedule: { cron: '0 9 * * 1' }\n---\nRelease.\n",
  );
  const before = await snapshot(root);

  const referenced = await deleteAgent(
    root,
    "helper",
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(!referenced.ok && referenced.code === "invalid");
  assert.deepEqual(
    referenced.errors.map((e) => [e.path, e.message]),
    [["automations/release/automation.md", 'agent "helper" is not defined']],
  );

  const foreman = await deleteAgent(
    root,
    "boss",
    await revision(root, "boss"),
    HARNESS_FALLBACK,
  );
  assert.ok(!foreman.ok && foreman.code === "invalid");
  assert.deepEqual(
    foreman.errors.map((e) => e.message),
    ["exactly one agent must declare agentType: FOREMAN (found 0)"],
  );
  assert.deepEqual(await snapshot(root), before);
});

test("deleting an agent changed since it was loaded is a conflict", async () => {
  const root = await tree();
  const path = join(root, "agents/helper/agent.md");
  const stale = await revision(root, "helper");
  await writeFile(path, HELPER.replace("Help with", "Someone else edited"));
  const result = await deleteAgent(root, "helper", stale, HARNESS_FALLBACK);
  assert.ok(!result.ok && result.code === "conflict");
  assert.match(result.message, /agents\/helper\/agent\.md changed on disk/);

  // A write that lands while the copy is validated is caught before the delete.
  const raced = await deleteAgent(
    root,
    "helper",
    await revision(root, "helper"),
    HARNESS_FALLBACK,
    () => writeFile(path, "---\nagentType: CUSTOM\n---\nRaced.\n"),
  );
  assert.ok(!raced.ok && raced.code === "conflict");
  assert.equal(
    await readFile(path, "utf8"),
    "---\nagentType: CUSTOM\n---\nRaced.\n",
  );

  // Only a folder directly in agents/ can be deleted.
  const outside = await deleteAgent(
    root,
    "..",
    await revision(root, "helper"),
    HARNESS_FALLBACK,
  );
  assert.ok(!outside.ok && outside.code === "conflict");
  assert.ok(await stat(join(root, "factory.yaml")));
});

test("the New agent form checks names with the same rule as the writer", () => {
  assert.equal(WEB_AGENT_NAME.source, AGENT_NAME.source);
  assert.equal(WEB_AGENT_NAME.flags, AGENT_NAME.flags);
});

test("the New automation drawer checks names with the writer's rule and suggests valid ones", () => {
  assert.equal(WEB_AUTOMATION_NAME.source, AUTOMATION_NAME.source);
  assert.equal(WEB_AUTOMATION_NAME.flags, AUTOMATION_NAME.flags);
  assert.equal(slugify("Nightly report"), "nightly-report");
  assert.equal(slugify("  Déploiement — Prod!  "), "deploiement-prod");
  assert.equal(slugify("—"), "");
  for (const name of ["Nightly report", "_x", "x".repeat(80), "a-".repeat(40)])
    assert.match(slugify(name), AUTOMATION_NAME, name);
});

const NEW_AUTOMATION = {
  displayName: "Nightly report",
  trigger: { kind: "schedule", cron: "0 3 * * *" },
  agent: "helper",
  instructions: "Report\r\n\r\nthe night.",
  enabled: true,
} as const;

test("a created automation writes an automation.md that loads with its trigger", async () => {
  const root = await tree();
  const result = await createAutomation(
    root,
    { name: "nightly", ...NEW_AUTOMATION },
    HARNESS_FALLBACK,
  );
  assert.deepEqual(result, { ok: true, changed: true, warnings: [] });
  assert.equal(
    await readFile(join(root, "automations/nightly/automation.md"), "utf8"),
    "---\ndisplayName: Nightly report\nenabled: true\nagent: helper\ntriggers:\n  - provider: schedule\n    event: cron_fired\n    schedule:\n      cron: 0 3 * * *\n---\nReport\n\nthe night.\n",
  );
  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  const [nightly] = loaded.definition.automations;
  assert.equal(nightly?.name, "nightly");
  assert.equal(nightly?.agent, "helper");
  assert.equal(nightly?.instructions, "Report\n\nthe night.");
  assert.equal(nightly?.frontmatter.displayName, "Nightly report");
  assert.equal(nightly?.frontmatter.enabled, true);
  assert.deepEqual(nightly?.frontmatter.triggers, [
    {
      provider: "schedule",
      event: "cron_fired",
      schedule: { cron: "0 3 * * *" },
    },
  ]);

  // Without a display name the folder name shows; a disabled one says so.
  assert.ok(
    (
      await createAutomation(
        root,
        {
          name: "chat",
          displayName: " ",
          trigger: { kind: "telegram" },
          agent: "boss",
          instructions: "",
          enabled: false,
        },
        HARNESS_FALLBACK,
      )
    ).ok,
  );
  assert.equal(
    await readFile(join(root, "automations/chat/automation.md"), "utf8"),
    "---\nenabled: false\nagent: boss\ntriggers:\n  - provider: telegram\n    event: message\n---\n",
  );
});

test("creating an automation refuses a taken or invalid name, a bad trigger and an invalid tree, writing nothing", async () => {
  const root = await tree();
  await mkdir(join(root, "automations/nightly"), { recursive: true });
  await writeFile(
    join(root, "automations/nightly/automation.md"),
    "---\ntriggers:\n  - provider: telegram\n    event: message\n---\nChat.\n",
  );
  const before = await snapshot(root);

  const taken = await createAutomation(
    root,
    { name: "nightly", ...NEW_AUTOMATION },
    HARNESS_FALLBACK,
  );
  assert.ok(!taken.ok && taken.code === "conflict");
  assert.equal(
    taken.message,
    "automations/nightly already exists; choose another name",
  );

  for (const name of [
    "../escape",
    "Nightly",
    "-x",
    "",
    "a/b",
    "x".repeat(64),
  ]) {
    const invalid = await createAutomation(
      root,
      { ...NEW_AUTOMATION, name },
      HARNESS_FALLBACK,
    );
    assert.ok(!invalid.ok && invalid.code === "invalid", name);
    assert.match(invalid.errors[0]?.message ?? "", /an automation name uses/);
  }

  const cron = await createAutomation(
    root,
    {
      ...NEW_AUTOMATION,
      name: "weekly",
      trigger: { kind: "schedule", cron: "every day" },
    },
    HARNESS_FALLBACK,
  );
  assert.ok(!cron.ok && cron.code === "invalid");
  assert.deepEqual(
    cron.errors.map((e) => [e.path, e.message]),
    [
      [
        "automations/weekly/automation.md",
        'cron "every day" must have 5 fields',
      ],
    ],
  );

  // The loader's error for an agent that does not exist comes back.
  const ghost = await createAutomation(
    root,
    { ...NEW_AUTOMATION, name: "weekly", agent: "ghost" },
    HARNESS_FALLBACK,
  );
  assert.ok(!ghost.ok && ghost.code === "invalid");
  assert.deepEqual(
    ghost.errors.map((e) => [e.path, e.message]),
    [["automations/weekly/automation.md", 'agent "ghost" is not defined']],
  );
  assert.deepEqual(await snapshot(root), before);
});

test("deleting an automation removes its folder; a stale one is a conflict", async () => {
  const root = await tree();
  assert.ok(
    (
      await createAutomation(
        root,
        { name: "nightly", ...NEW_AUTOMATION },
        HARNESS_FALLBACK,
      )
    ).ok,
  );
  const path = join(root, "automations/nightly/automation.md");
  const stale = fileRevision(await readFile(path));
  await writeFile(path, (await readFile(path, "utf8")).replace("night", "day"));
  const conflict = await deleteAutomation(
    root,
    "nightly",
    stale,
    HARNESS_FALLBACK,
  );
  assert.ok(!conflict.ok && conflict.code === "conflict");
  assert.match(
    conflict.message,
    /automations\/nightly\/automation\.md changed on disk/,
  );
  assert.ok(await stat(path));

  // Only a folder directly in automations/ can be deleted.
  const outside = await deleteAutomation(
    root,
    "..",
    fileRevision(await readFile(path)),
    HARNESS_FALLBACK,
  );
  assert.ok(!outside.ok && outside.code === "conflict");

  const deleted = await deleteAutomation(
    root,
    "nightly",
    fileRevision(await readFile(path)),
    HARNESS_FALLBACK,
  );
  assert.deepEqual(deleted, { ok: true, changed: true, warnings: [] });
  assert.deepEqual(await readdir(join(root, "automations")), []);
  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.definition.automations, []);
});

test("an automation's enabled switch and instructions round-trip through automation.md", async () => {
  const root = await tree();
  const path = join(root, "automations/nightly/automation.md");
  const original = `---
displayName: Nightly # shown in the table
triggers:
  - provider: schedule
    event: cron_fired
    schedule: { cron: "0 3 * * *" }
---

Run the suite.
`;
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, original);
  const current = async () => fileRevision(await readFile(path));
  const load = async () => {
    const loaded = await loadDefinition(root, HARNESS_FALLBACK);
    assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.errors));
    return loaded.definition.automations.find((a) => a.name === "nightly");
  };

  // Enabled by default: saving it enabled with the same body writes nothing.
  assert.deepEqual(
    await writeAutomation(
      root,
      "nightly",
      { enabled: true, instructions: "Run the suite." },
      await current(),
      HARNESS_FALLBACK,
    ),
    { ok: true, changed: false, warnings: [], revision: await current() },
  );
  assert.equal(await readFile(path, "utf8"), original);

  const disabled = await writeAutomation(
    root,
    "nightly",
    { enabled: false, instructions: "Run the suite." },
    await current(),
    HARNESS_FALLBACK,
  );
  assert.equal(disabled.ok && disabled.revision, await current());
  assert.equal(
    await readFile(path, "utf8"),
    original.replace("---\n\n", "enabled: false\n---\n\n"),
  );
  assert.equal((await load())?.frontmatter.enabled, false);

  const stale = await current();
  await writeAutomation(
    root,
    "nightly",
    {
      enabled: true,
      instructions: "Run the suite.\r\n\r\nReport **failures**.\n",
    },
    stale,
    HARNESS_FALLBACK,
  );
  const loaded = await load();
  assert.equal(loaded?.frontmatter.enabled, true);
  assert.equal(loaded?.instructions, "Run the suite.\n\nReport **failures**.");
  assert.equal(
    await readFile(path, "utf8"),
    `---
displayName: Nightly # shown in the table
triggers:
  - provider: schedule
    event: cron_fired
    schedule: { cron: "0 3 * * *" }
enabled: true
---

Run the suite.

Report **failures**.
`,
  );
  // A page loaded before the last save is a conflict and writes nothing.
  const before = await readFile(path, "utf8");
  const conflict = await writeAutomation(
    root,
    "nightly",
    { enabled: false, instructions: "Gone." },
    stale,
    HARNESS_FALLBACK,
  );
  assert.equal(conflict.ok || conflict.code, "conflict");
  assert.equal(await readFile(path, "utf8"), before);
});

test("approved lessons append to a shared learnings skill that every agent loads", async () => {
  const root = await tree();
  const path = join(root, LEARNINGS_PATH);

  const first = await appendLearning(
    root,
    ["  Run the linter before the PR. "],
    HARNESS_FALLBACK,
  );
  assert.equal(first.ok && first.changed, true);
  const second = await appendLearning(
    root,
    ["Never edit generated files.", "Cite the issue."],
    HARNESS_FALLBACK,
  );
  assert.equal(second.ok, true);
  const text = await readFile(path, "utf8");
  assert.match(text, /^---\nname: learnings\n/);
  assert.ok(
    text.endsWith(
      "- Run the linter before the PR.\n- Never edit generated files.\n- Cite the issue.\n",
    ),
  );

  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  for (const agent of loaded.definition.agents.values())
    assert.ok(
      agent.skills.some((s) => s.name === "learnings"),
      agent.name,
    );
});

test("a lesson that is not 1-3 short plain lines is refused and writes no file", async () => {
  const root = await tree();
  for (const lines of [
    [],
    ["a", "b", "c", "d"],
    [" "],
    ["x".repeat(201)],
    ["two\nlines"],
    ["# Heading"],
    ["---"],
    ["<script>"],
  ]) {
    const result = await appendLearning(root, lines, HARNESS_FALLBACK);
    assert.equal(result.ok || result.code, "invalid", JSON.stringify(lines));
  }
  await assert.rejects(lstat(join(root, LEARNINGS_PATH)));
});

test("the learnings skill refuses lessons past its cap and keeps the file", async () => {
  const root = await tree();
  for (let i = 0; i < LEARNINGS_CAP; i++)
    assert.ok(
      (await appendLearning(root, [`Lesson ${i}.`], HARNESS_FALLBACK)).ok,
    );
  const before = await readFile(join(root, LEARNINGS_PATH), "utf8");
  const full = await appendLearning(root, ["One more."], HARNESS_FALLBACK);
  assert.equal(full.ok || full.code, "invalid");
  assert.equal(await readFile(join(root, LEARNINGS_PATH), "utf8"), before);
});

/** An automation.md with one telegram trigger, its path and its revision. */
async function automationTree(
  frontmatter = "triggers:\n  - provider: telegram\n    event: message\n",
) {
  const root = await tree();
  const path = join(root, "automations/intake/automation.md");
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `---\n${frontmatter}---\n\nDo the work.\n`);
  const current = async () => fileRevision(await readFile(path));
  const save = async (edit: Partial<AutomationEdit>) =>
    writeAutomation(
      root,
      "intake",
      { enabled: true, instructions: "Do the work.", ...edit },
      await current(),
      HARNESS_FALLBACK,
    );
  /** A factory running the definition as loaded from disk now. */
  const factory = async () => {
    const loaded = await loadDefinition(root, HARNESS_FALLBACK);
    assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.errors));
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    const factory = new Factory(
      store,
      loadConfig({ NAKARA_GITHUB_MIRROR: "false" }),
    );
    factory.pump = async () => {};
    factory.definition = loaded.definition;
    return {
      factory,
      store,
      trigger: loaded.definition.automations[0]?.frontmatter.triggers,
    };
  };
  return { root, path, save, factory };
}

const factoriesOf = (factory: Factory) =>
  ({
    factories: [factory],
    default: factory,
    byHandle: () => undefined,
    forItem: () => factory,
  }) as unknown as TelegramFactories;

test("a GitHub label trigger serializes to an issue_labeled trigger the poller polls", async () => {
  const { save, path, factory } = await automationTree();
  assert.equal(
    (await save({ trigger: { kind: "github_label", label: " bug " } })).ok,
    true,
  );
  assert.match(
    await readFile(path, "utf8"),
    /provider: github\n\s+event: issue_labeled\n\s+filter:\n\s+labels:\n\s+- bug\n/,
  );
  const { factory: f, store } = await factory();
  try {
    const poller = new GithubPoller(f);
    const polled: string[] = [];
    // biome-ignore lint/complexity/useLiteralKeys: Observe intake without GitHub.
    poller["intakeLabeled"] = async (_f, repo, label, automation) => {
      polled.push(`${repo} ${label} ${automation}`);
    };
    // biome-ignore lint/complexity/useLiteralKeys: Drive issue intake only.
    await poller["intake"](f, (error) => assert.fail(error));
    assert.deepEqual(polled, ["o/r bug intake"]);
  } finally {
    store.db.close();
  }
});

test("a schedule trigger serializes to a cron_fired trigger the scheduler fires", async () => {
  const { save, path, factory } = await automationTree();
  assert.equal(
    (await save({ trigger: { kind: "schedule", cron: "0 3 * * *" } })).ok,
    true,
  );
  assert.match(
    await readFile(path, "utf8"),
    /provider: schedule\n\s+event: cron_fired\n\s+schedule:\n\s+cron: 0 3 \* \* \*\n/,
  );
  const { factory: f, store } = await factory();
  try {
    new Scheduler(f).tick(new Date("2026-11-27T03:00:10Z"));
    assert.equal(store.automationHistory("intake").count, 1);
  } finally {
    store.db.close();
  }
});

test("a Slack trigger serializes to a slack/message trigger that trusts its members", async () => {
  const { save, path, factory } = await automationTree();
  assert.equal(
    (
      await save({
        trigger: {
          kind: "slack",
          members: ["U0123ABC", "W0456DEF", "U0123ABC"],
        },
      })
    ).ok,
    true,
  );
  assert.match(
    await readFile(path, "utf8"),
    /provider: slack\n\s+event: message\n\s+filter:\n\s+members:\n\s+- U0123ABC\n\s+- W0456DEF\n/,
  );
  const { factory: f, store } = await factory();
  try {
    const bridge = new SlackBridge(factoriesOf(f), async () => ({ ok: true }));
    // biome-ignore lint/complexity/useLiteralKeys: The member check of incoming messages.
    const allowed = (user: string) => bridge["allowed"](f, user);
    assert.equal(allowed("W0456DEF"), true);
    assert.equal(allowed("U0999XYZ"), false);
  } finally {
    store.db.close();
  }
});

test("a Telegram trigger serializes to a telegram/message trigger that takes chat requests", async () => {
  const { save, path, factory } = await automationTree(
    'triggers:\n  - provider: schedule\n    event: cron_fired\n    schedule: { cron: "@daily" }\n',
  );
  assert.equal((await save({ trigger: { kind: "telegram" } })).ok, true);
  assert.match(
    await readFile(path, "utf8"),
    /triggers:\n\s+- provider: telegram\n\s+event: message\n---/,
  );
  const { factory: f, store } = await factory();
  try {
    const routed = routeRequest(factoriesOf(f), "Fix the build", "telegram");
    assert.equal("automation" in routed && routed.automation, "intake");
  } finally {
    store.db.close();
  }
});

test("the display name, starting agent and a same-kind trigger change only their keys", async () => {
  const { save, path, factory } = await automationTree(`displayName: Old # shown
triggers:
  - provider: github
    event: issue_labeled
    filter: { repos: [o/r], labels: [old], bots: [renovate] }
`);
  const result = await save({
    displayName: "Triage bugs",
    agent: "helper",
    trigger: { kind: "github_label", label: "bug" },
  });
  assert.equal(result.ok, true);
  const { factory: f, store, trigger } = await factory();
  try {
    const automation = f.definition?.automations[0];
    assert.equal(automation?.frontmatter.displayName, "Triage bugs");
    assert.equal(automation?.agent, "helper");
    assert.deepEqual(trigger?.[0]?.filter, {
      repos: ["o/r"],
      labels: ["bug"],
      bots: ["renovate"],
    });
  } finally {
    store.db.close();
  }
  // An empty name removes the key, so the folder name shows.
  assert.equal((await save({ displayName: "  " })).ok, true);
  assert.doesNotMatch(await readFile(path, "utf8"), /displayName/);
});

test("an invalid cron, a missing agent or several triggers are refused and write nothing", async () => {
  const { save, path } = await automationTree();
  const before = await readFile(path, "utf8");
  const refused = async (edit: Partial<AutomationEdit>, message: RegExp) => {
    const result = await save(edit);
    assert.ok(!result.ok && result.code === "invalid", JSON.stringify(result));
    assert.match(result.errors.map((e) => e.message).join("\n"), message);
    assert.equal(await readFile(path, "utf8"), before);
  };
  await refused(
    { trigger: { kind: "schedule", cron: "61 * * * *" } },
    /out of range/,
  );
  await refused({ agent: "ghost" }, /agent "ghost" is not defined/);
  await refused(
    { trigger: { kind: "slack", members: ["someone"] } },
    /filter\.members/,
  );

  const several = await automationTree(`triggers:
  - provider: telegram
    event: message
  - provider: slack
    event: message
    filter: { members: [U0123ABC] }
`);
  const original = await readFile(several.path, "utf8");
  const result = await several.save({
    displayName: "Chat",
    trigger: { kind: "telegram" },
  });
  assert.ok(!result.ok && result.code === "invalid");
  assert.match(result.errors[0]?.message ?? "", /several triggers/);
  assert.equal(await readFile(several.path, "utf8"), original);
  // Without a trigger, the other fields still save.
  assert.equal((await several.save({ displayName: "Chat" })).ok, true);
  assert.match(await readFile(several.path, "utf8"), /provider: slack/);
});

const FACTORY = `# The factory, as the team wrote it.
schemaVersion: v1alpha1
name: t # display name
repositories:
  - owner: o
    name: r
agentDefaults: { model: auto, runner: std }
`;

test("factory.yaml: a description is added under the name, changed and removed, keeping comments", async () => {
  const root = await tree();
  const path = join(root, "factory.yaml");
  await writeFile(path, FACTORY);
  const current = async () => fileRevision(await readFile(path));

  const added = await writeFactoryFile(
    root,
    { description: "  Ships the web app.  " },
    await current(),
    HARNESS_FALLBACK,
  );
  assert.ok(added.ok && added.changed);
  assert.equal(
    await readFile(path, "utf8"),
    FACTORY.replace(
      "name: t # display name\n",
      "name: t # display name\ndescription: Ships the web app.\n",
    ),
  );
  assert.equal(added.revision, await current());
  const loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  assert.equal(loaded.definition.factory.description, "Ships the web app.");

  const changed = await writeFactoryFile(
    root,
    { description: "Ships: the API" },
    await current(),
    HARNESS_FALLBACK,
  );
  assert.ok(changed.ok && changed.changed);
  const text = await readFile(path, "utf8");
  assert.match(text, /^# The factory, as the team wrote it\.\n/);
  assert.match(text, /name: t # display name\ndescription: "Ships: the API"\n/);

  // The same value again writes nothing.
  const same = await writeFactoryFile(
    root,
    { description: "Ships: the API" },
    await current(),
    HARNESS_FALLBACK,
  );
  assert.ok(same.ok && !same.changed);

  // Blank and null both remove the key; the file is back to what it was.
  for (const description of ["  ", null]) {
    const removed = await writeFactoryFile(
      root,
      { description },
      await current(),
      HARNESS_FALLBACK,
    );
    assert.ok(removed.ok);
    assert.equal(await readFile(path, "utf8"), FACTORY);
  }
});

test("factory.yaml: a description edit leaves other values and long lines exactly as written", () => {
  const long = Array.from({ length: 30 }, () => "word").join(" ");
  const text = `${FACTORY}slackUserId: 12345678901234567890\nnote: ${long}\n`;
  const out = serializeFactory(text, { description: "Ships." });
  assert.match(out, /^slackUserId: 12345678901234567890$/m);
  assert.match(out, new RegExp(`^note: ${long}$`, "m"));
});

test("factory.yaml: a stale revision is a conflict and writes nothing", async () => {
  const root = await tree();
  const path = join(root, "factory.yaml");
  const stale = fileRevision(await readFile(path));
  await writeFile(path, FACTORY);
  const before = await snapshot(root);
  const result = await writeFactoryFile(
    root,
    { description: "Late." },
    stale,
    HARNESS_FALLBACK,
  );
  assert.ok(!result.ok && result.code === "conflict");
  assert.match(result.message, /factory\.yaml changed on disk/);
  assert.deepEqual(await snapshot(root), before);
});

test("factory.yaml: an edit the loader rejects writes nothing", async () => {
  const root = await tree();
  const path = join(root, "factory.yaml");
  // Broken by hand already: the edit cannot make it load, so it is refused.
  await writeFile(path, FACTORY.replace("schemaVersion: v1alpha1\n", ""));
  const before = await snapshot(root);
  const result = await writeFactoryFile(
    root,
    { description: "Anything." },
    fileRevision(await readFile(path)),
    HARNESS_FALLBACK,
  );
  assert.ok(!result.ok && result.code === "invalid");
  assert.ok(result.errors.some((e) => e.path === "factory.yaml"));
  assert.deepEqual(await snapshot(root), before);
});

/** factory.yaml with secrets, servers and an auth key under agentDefaults, as a team writes them. */
const DEFAULTS = `schemaVersion: v1alpha1
name: t
repositories: [{ owner: o, name: r }]
agentDefaults:
  harness:
    type: claude # the team harness
    model: haiku
    reasoningLevel: high
  runner: std
  secrets: [LINEAR_TOKEN] # read by the linear server
  mcpServers:
    linear: { url: "https://mcp.linear.app", headers: { Authorization: "Bearer {{LINEAR_TOKEN}}" }, tools: [get_issue] }
`;

test("factory.yaml agentDefaults: a model replaces the harness and back; secrets and mcpServers keep their text", async () => {
  const root = await tree();
  const path = join(root, "factory.yaml");
  await writeFile(path, DEFAULTS);
  const save = async (agentDefaults: AgentDefaultsEdit) =>
    writeFactoryFile(
      root,
      { agentDefaults },
      fileRevision(await readFile(path)),
      HARNESS_FALLBACK,
    );
  const kept = [
    "  secrets: [LINEAR_TOKEN] # read by the linear server\n",
    '    linear: { url: "https://mcp.linear.app", headers: { Authorization: "Bearer {{LINEAR_TOKEN}}" }, tools: [get_issue] }\n',
  ];

  // A model alone: harness goes, its comment with it; the rest is as written.
  const toModel = await save({ harness: null, model: "opus" });
  assert.ok(toModel.ok && toModel.changed);
  let text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /harness/);
  assert.match(text, /^agentDefaults:\n {2}runner: std\n/m);
  assert.match(text, /^ {2}model: opus$/m);
  for (const line of kept) assert.ok(text.includes(line), line);
  let loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  assert.deepEqual(loaded.definition.agents.get("boss")?.harness, {
    kind: "claude",
    model: "opus",
  });

  // A harness again: the model shorthand goes.
  const toHarness = await save({ harness: "claude", model: "haiku" });
  assert.ok(toHarness.ok && toHarness.changed);
  text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /^ {2}model:/m);
  assert.match(text, /^ {2}harness:\n {4}type: claude\n {4}model: haiku\n/m);
  for (const line of kept) assert.ok(text.includes(line), line);

  // Runner and idle timeout alone leave the harness as it is; null removes them.
  const runner = await save({ runner: "big", idleTimeoutMinutes: 15 });
  assert.ok(runner.ok && runner.changed);
  loaded = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(loaded.ok);
  const boss = loaded.definition.agents.get("boss");
  assert.equal(boss?.runner, "big");
  assert.equal(boss?.idleTimeoutMinutes, 15);
  assert.equal(boss?.harness.kind, "claude");
  assert.ok((await save({ idleTimeoutMinutes: 15 })).ok);
  const same = await save({ idleTimeoutMinutes: 15 });
  assert.ok(same.ok && !same.changed);
  assert.ok((await save({ runner: null, idleTimeoutMinutes: null })).ok);
  text = await readFile(path, "utf8");
  assert.doesNotMatch(text, /runner|idleTimeoutMinutes/);
  for (const line of kept) assert.ok(text.includes(line), line);
});

test("factory.yaml agentDefaults: an unknown harness, runner or timeout, or a lost key, writes nothing", async () => {
  const root = await tree();
  const path = join(root, "factory.yaml");
  await writeFile(path, DEFAULTS);
  const before = await snapshot(root);
  for (const [agentDefaults, message] of [
    [{ harness: "gemini", model: null }, /agentDefaults\.harness\.type/],
    [{ runner: "missing" }, /runner "missing" is not defined/],
    [{ idleTimeoutMinutes: 0 }, /idleTimeoutMinutes/],
    // Neither a harness nor a model breaks the schema's either/or.
    [{ harness: null, model: null }, /exactly one of `model` or `harness`/],
    [{ effort: "high" }, /saved with its harness and model/],
  ] as const) {
    const result = await writeFactoryFile(
      root,
      { agentDefaults },
      fileRevision(await readFile(path)),
      HARNESS_FALLBACK,
    );
    assert.ok(!result.ok && result.code === "invalid", String(message));
    assert.match(
      result.errors.map((e) => e.message).join("\n"),
      message,
      JSON.stringify(result.errors),
    );
  }
  assert.deepEqual(await snapshot(root), before);

  // The model shorthand cannot hold a key the form does not edit.
  await writeFile(
    path,
    DEFAULTS.replace("    reasoningLevel: high\n", "    auth: { kind: key }\n"),
  );
  const auth = await writeFactoryFile(
    root,
    { agentDefaults: { harness: null, model: "opus" } },
    fileRevision(await readFile(path)),
    HARNESS_FALLBACK,
  );
  assert.ok(!auth.ok && auth.code === "invalid");
  assert.match(auth.errors[0]?.message ?? "", /would drop auth/);
  assert.match(await readFile(path, "utf8"), /auth: \{ kind: key \}/);
});
