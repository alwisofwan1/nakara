import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HARNESS_FALLBACK,
  loadDefinition,
  resolveHarness,
  splitFrontmatter,
} from "./load.ts";
import { harnessReachWarnings } from "./reach.ts";

const defaults = { kind: "claude" as const, model: undefined };

async function tree(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "nakara-def-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const FACTORY = `schemaVersion: v1alpha1
name: t
alias: T
repositories: [{ owner: o, name: r }]
agentDefaults: { model: auto, runner: std }
`;

test("the bundled factory definition loads", async () => {
  const result = await loadDefinition(
    join(import.meta.dirname, "../../factory"),
    defaults,
  );
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  assert.equal(result.definition.foreman.name, "foreman");
  assert.equal(result.definition.agents.get("triage")?.harness.kind, "claude");
  assert.equal(result.definition.label, "factory:Nakara");
});

test("frontmatter is optional and MAIN is an alias of FOREMAN", async () => {
  assert.deepEqual(splitFrontmatter("just a body").data, {});
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml":
      "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\n",
    "agents/boss/agent.md": "---\nagentType: MAIN\n---\nLead.",
    "agents/helper/agent.md": "Help.",
  });
  const result = await loadDefinition(root, defaults);
  assert.ok(result.ok);
  assert.equal(result.definition.foreman.name, "boss");
  assert.equal(result.definition.agents.get("helper")?.type, "CUSTOM");
});

test("exactly one foreman and defined runners are required", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "agents/a/agent.md": "A.",
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  const messages = !result.ok
    ? result.errors.map((e) => e.message).join("\n")
    : "";
  assert.match(messages, /exactly one agent must declare agentType: FOREMAN/);
  assert.match(messages, /runner "std" is not defined/);
});

test("a repository owner or name outside GitHub's characters is refused", async () => {
  for (const [ref, field] of [
    ["{ owner: o, name: .. }", "name"],
    ["{ owner: o, name: . }", "name"],
    ["{ owner: o, name: a/b }", "name"],
    ['{ owner: "../x", name: r }', "owner"],
    ['{ owner: o, name: "r --web" }', "name"],
  ]) {
    const root = await tree({
      "factory.yaml": FACTORY.replace("{ owner: o, name: r }", ref ?? ""),
      "runners/std.yaml":
        "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\n",
      "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\nLead.",
    });
    const result = await loadDefinition(root, defaults);
    assert.equal(result.ok, false, ref);
    assert.match(
      !result.ok ? result.errors.map((e) => e.message).join("\n") : "",
      new RegExp(`${field} must be a GitHub`),
      ref,
    );
  }
});

test("egress allowlist entries must be host names or subdomain wildcards", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml":
      "egress: { allow: [github.com, '*.github.com', '*', '*.com', 'https://x.io/a'] }\n",
    "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\nLead.",
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  const bad = !result.ok
    ? result.errors.filter((e) => /bare-TLD wildcard/.test(e.message))
    : [];
  assert.equal(bad.length, 3, JSON.stringify(!result.ok && result.errors));
});

test("model and harness are mutually exclusive in agentDefaults", async () => {
  const root = await tree({
    "factory.yaml": FACTORY.replace(
      "{ model: auto, runner: std }",
      "{ model: auto, harness: { type: claude, model: opus } }",
    ),
    "agents/f/agent.md": "---\nagentType: FOREMAN\n---\nF.",
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
});

test("Warp model names map to local harnesses", () => {
  assert.deepEqual(
    resolveHarness({ model: "claude-5-opus-high" }, defaults).harness,
    { kind: "claude", model: "opus" },
  );
  assert.deepEqual(resolveHarness({ model: "auto-genius" }, defaults).harness, {
    kind: "claude",
    model: undefined,
  });
  assert.equal(
    resolveHarness({ model: "Qwen/Qwen3.6-27B-FP8" }, defaults).harness.kind,
    "qwen",
  );
  const unknown = resolveHarness({ model: "grok-4-5-high" }, defaults);
  assert.equal(unknown.harness.kind, "claude");
  assert.ok(unknown.warning);
});

test("problems carry the line they point at", async () => {
  const root = await tree({
    "factory.yaml": `${FACTORY.replace("runner: std", "runner: local")}`,
    "runners/local.yaml": "description: host\n",
    "agents/f/agent.md": "---\nagentType: FOREMAN\n---\nF.",
    "agents/docs/agent.md":
      "---\ndescription: Docs\nharness:\n  type: gemini\n---\nDocs.",
    "automations/weekly/automation.md": `---
triggers:
  - provider: schedule
    event: cron_fired
    schedule:
      cron: "0 2 * * 8"
---
Check.`,
    "runners/broken.yaml": "platform:\n  os: linux\n bad: : yes\n",
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  const errors = !result.ok ? result.errors : [];
  const at = (path: string) => errors.find((e) => e.path === path);
  assert.equal(at("agents/docs/agent.md")?.line, 4);
  assert.match(at("agents/docs/agent.md")?.message ?? "", /^harness\.type:/);
  assert.equal(at("automations/weekly/automation.md")?.line, 6);
  assert.equal(at("runners/broken.yaml")?.line, 3);
});

test("a YAML syntax error in factory.yaml is a problem, not a crash", async () => {
  const root = await tree({ "factory.yaml": "name: t\nrepositories: [\n" });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  const [error] = !result.ok ? result.errors : [];
  assert.equal(error?.path, "factory.yaml");
  assert.equal(typeof error?.line, "number");
});

test("an undefined agentDefaults runner is reported once, at factory.yaml", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "agents/f/agent.md": "---\nagentType: FOREMAN\n---\nF.",
    "agents/a/agent.md": "A.",
    "agents/b/agent.md": "B.",
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  const runnerErrors = !result.ok
    ? result.errors.filter((e) => /runner "std"/.test(e.message))
    : [];
  assert.deepEqual(runnerErrors, [
    { path: "factory.yaml", message: 'runner "std" is not defined', line: 5 },
  ]);
});

test("setting provenance distinguishes inherited values from explicit overrides", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml": "description: Standard\n",
    "skills/shared/SKILL.md": "Shared skill",
    "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\nLead.",
    "agents/helper/agent.md":
      "---\nharness: {type: claude, model: opus}\nrunner: std\nspawnableBy: []\nidleTimeoutMinutes: 15\nmcpServers: {}\n---\nHelp.",
    "agents/helper/skills/local/SKILL.md": "Local skill",
    "agents/qwen/agent.md":
      "---\nharness: {type: qwen, model: Qwen/Qwen3}\n---\nTriage.",
  });
  const result = await loadDefinition(root, defaults);
  assert.ok(result.ok);
  const boss = result.definition.foreman;
  assert.equal(boss.runner, "std");
  assert.equal(boss.explicitSettings?.includes("runner"), false);
  assert.deepEqual(boss.localSkills, []);
  const helper = result.definition.agents.get("helper");
  for (const key of [
    "harness",
    "model",
    "runner",
    "spawnableBy",
    "idleTimeoutMinutes",
    "mcpServers",
  ])
    assert.ok(helper?.explicitSettings?.includes(key), key);
  assert.deepEqual(helper?.localSkills, ["local"]);
  assert.deepEqual(
    helper?.skills.map((s) => s.name),
    ["shared", "local"],
  );
  const qwen = result.definition.agents.get("qwen");
  assert.equal(qwen?.harness.model, undefined);
  assert.ok(qwen?.explicitSettings?.includes("harness"));
  assert.equal(qwen?.explicitSettings?.includes("model"), false);
});

test("secrets: an MCP server uses only declared ones, and Nakara's own are refused", async () => {
  const root = await tree({
    "factory.yaml": `${FACTORY.replace("runner: std }", "runner: std, secrets: [LINEAR_KEY, GH_TOKEN] }")}secrets: [SENTRY_TOKEN]
mcpServers:
  sentry: { url: "https://sentry.test/{{SENTRY_TOKEN}}", tools: [list_issues] }
`,
    "runners/std.yaml":
      "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\negress: { allow: [sentry.test] }\n",
    "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\nLead.",
    "agents/own/agent.md": `---
secrets: [SLACK_TOKEN, NAKARA_TELEGRAM_BOT_TOKEN]
mcpServers:
  linear:
    command: linear-mcp
    env: { KEY: "{{LINEAR_KEY}}", SLACK: "{{SLACK_TOKEN}}" }
---
Own.`,
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.errors, [
    {
      path: "factory.yaml",
      message:
        "secret GH_TOKEN is Nakara's own configuration and cannot be given to agents",
      line: 5,
    },
    {
      path: "agents/own/agent.md",
      message:
        "secret NAKARA_TELEGRAM_BOT_TOKEN is Nakara's own configuration and cannot be given to agents",
      line: 2,
    },
    {
      path: "agents/own/agent.md",
      message:
        'mcpServers.linear: {{LINEAR_KEY}} is not in the secrets of agent "own"; declare it under secrets',
      line: 6,
    },
  ]);
});

test("an agent's secrets replace agentDefaults' and add to the factory's", async () => {
  const root = await tree({
    "factory.yaml": `${FACTORY.replace("runner: std }", "runner: std, secrets: [LINEAR_KEY] }")}secrets: [SENTRY_TOKEN]
`,
    "runners/std.yaml":
      "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\n",
    "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\nLead.",
    "agents/own/agent.md": "---\nsecrets: [SLACK_TOKEN]\n---\nOwn.",
  });
  const result = await loadDefinition(root, defaults);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  assert.deepEqual(result.definition.agents.get("boss")?.secrets, [
    "SENTRY_TOKEN",
    "LINEAR_KEY",
  ]);
  assert.deepEqual(result.definition.agents.get("own")?.secrets, [
    "SENTRY_TOKEN",
    "SLACK_TOKEN",
  ]);
});

test("each foreman MCP server lists its tools; write-looking ones and agent lists warn", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml":
      "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\negress: { allow: [api.anthropic.com, mcp.linear.test, sentry.test] }\n",
    "agents/boss/agent.md": `---
agentType: FOREMAN
mcpServers:
  linear:
    url: https://mcp.linear.test
    tools: [get_issue, createComment]
  sentry: { url: "https://sentry.test" }
---
Lead.`,
    "agents/own/agent.md": `---
mcpServers:
  linear: { url: "https://mcp.linear.test", tools: [get_issue] }
---
Own.`,
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, false);
  assert.deepEqual(!result.ok && result.errors, [
    {
      path: "agents/boss/agent.md",
      message:
        "mcpServers.sentry: the foreman needs a tools list naming what it may call",
      line: 7,
    },
  ]);
  assert.deepEqual(
    result.warnings.map((w) => [w.path, w.message, w.line]),
    [
      [
        "agents/boss/agent.md",
        "mcpServers.linear: the foreman may call createComment, which looks like it changes something outside Nakara",
        6,
      ],
      [
        "agents/own/agent.md",
        'mcpServers.linear: tools limits the foreman only; agent "own" can call every tool of the server',
        3,
      ],
    ],
  );
});

test("an MCP url server must be in its agent's egress allow list; a foreman command server needs a sandbox or the host opt-in", async (t) => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml":
      'platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\negress: { allow: ["*.sentry.io"] }\n',
    "runners/local.yaml": "description: Host\n",
    "agents/boss/agent.md": `---
agentType: FOREMAN
runner: local
mcpServers:
  notes: { command: notes-mcp, tools: [read_note] }
---
Lead.`,
    "agents/own/agent.md": `---
mcpServers:
  sentry: { url: "https://eu.sentry.io/mcp" }
  linear: { url: "https://mcp.linear.app/mcp" }
---
Own.`,
    "agents/free/agent.md": `---
runner: local
mcpServers:
  linear: { url: "https://mcp.linear.app/mcp" }
---
Free.`,
  });
  const result = await loadDefinition(root, defaults);
  assert.deepEqual(!result.ok && result.errors.map((e) => e.message), [
    'mcpServers.notes: the foreman\'s runner "local" has no dockerImage, so a command server would run on the host unsandboxed; give the runner a dockerImage, use a url server, or set NAKARA_ALLOW_HOST_FOREMAN=1 to accept that',
    'mcpServers.linear: mcp.linear.app is not in the egress allow list of runner "std", so agent "own" cannot reach it; add it under egress.allow',
  ]);
  assert.ok(
    result.warnings.some(
      (w) =>
        w.message ===
        'mcpServers.linear: agent "free" runs on the host, so no egress allow list limits what it reaches',
    ),
  );
  process.env.NAKARA_ALLOW_HOST_FOREMAN = "1";
  t.after(() => delete process.env.NAKARA_ALLOW_HOST_FOREMAN);
  const optedIn = await loadDefinition(root, defaults);
  assert.equal(
    !optedIn.ok && optedIn.errors.some((e) => e.message.includes("notes")),
    false,
  );
});

test("a foreman command server is allowed when the foreman's runner is a sandbox", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml":
      "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\n",
    "agents/boss/agent.md": `---
agentType: FOREMAN
mcpServers:
  notes: { command: notes-mcp, tools: [read_note] }
---
Lead.`,
  });
  const result = await loadDefinition(root, defaults);
  assert.equal(result.ok, true);
});

test("a slack trigger must list the Slack member IDs it trusts", async () => {
  const automation = (filter: string) => `---
triggers:
  - provider: slack
    event: message
${filter}---
Do it.`;
  const root = await tree({
    "factory.yaml": `${FACTORY.replace("runner: std", "runner: local")}`,
    "runners/local.yaml": "description: host\n",
    "agents/f/agent.md": "---\nagentType: FOREMAN\n---\nF.",
    "automations/none/automation.md": automation(""),
    "automations/empty/automation.md": automation(
      "    filter:\n      members: []\n",
    ),
    "automations/name/automation.md": automation(
      "    filter:\n      members: [alwi]\n",
    ),
    "automations/ok/automation.md": automation(
      "    filter:\n      members: [U0123ABCD, W0456EFGH]\n",
    ),
  });
  const result = await loadDefinition(root, defaults);
  const errors = !result.ok ? result.errors : [];
  assert.deepEqual(
    errors.map((e) => [e.path, /filter\.members/.test(e.message)]).sort(),
    [
      ["automations/empty/automation.md", true],
      ["automations/name/automation.md", true],
      ["automations/none/automation.md", true],
    ],
  );
});

test("an agent whose harness cannot reach its model through its runner's egress is a warning, also in /healthz", async () => {
  const root = await tree({
    "factory.yaml": FACTORY,
    "runners/std.yaml":
      "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\negress: { allow: [api.anthropic.com, github.com] }\n",
    "runners/local.yaml": "platform: { os: linux }\n",
    "agents/boss/agent.md": "---\nagentType: FOREMAN\n---\n# Boss\n",
    "agents/review/agent.md":
      "---\nagentType: REVIEW\nharness: { type: codex }\n---\n# Review\n",
    // On the host nothing limits what it reaches.
    "agents/local/agent.md":
      "---\nagentType: CUSTOM\nrunner: local\nharness: { type: codex }\n---\n# Local\n",
  });
  const result = await loadDefinition(root, HARNESS_FALLBACK);
  assert.ok(result.ok);
  const message =
    'agent "review" uses codex but runner "std" egress does not allow chatgpt.com, auth.openai.com, so its runs cannot reach the model; add them under egress.allow, or give the agent a harness the runner reaches';
  assert.deepEqual(
    result.warnings
      .filter((w) => /cannot reach the model/.test(w.message))
      .map((w) => [w.path, w.message, w.line]),
    [["agents/review/agent.md", message, 3]],
  );
  assert.deepEqual(harnessReachWarnings(result.definition), [`T: ${message}`]);
});
