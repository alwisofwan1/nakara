import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HARNESS_DEFAULT, loadDefinition } from "./load.ts";
import {
  type ScaffoldChoices,
  type ScaffoldDeps,
  scaffold,
  type Template,
  writeTree,
} from "./scaffold.ts";

const BUNDLED = join(import.meta.dirname, "../../factory");

async function files(root: string, entries: Record<string, string>) {
  for (const [path, content] of Object.entries(entries)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

const agent = (type: string, model: string) =>
  `---\ndescription: ${type}\nagentType: ${type}\nmodel: ${model}\n---\n# ${type}\n`;

// An example whose automations filter on its own repositories and labels, in
// the forms the Warp examples use.
const FILTERED = "examples/02-sdlc-issue-to-pr";
const filtered = {
  [`${FILTERED}/factory.yaml`]: `schemaVersion: v1alpha1
name: sdlc
alias: Acme
repositories: [{ owner: acme, name: api-service }, { owner: acme, name: webapp }]
agentDefaults: { harness: { type: claude } }
`,
  [`${FILTERED}/agents/foreman/agent.md`]: agent("FOREMAN", "auto"),
  [`${FILTERED}/agents/implementer/agent.md`]: agent("IMPLEMENT", "auto"),
  [`${FILTERED}/automations/issue-labeled/automation.md`]: `---
triggers:
  - provider: github
    event: issue_labeled
    filter:
      repos: [acme/api-service]
      labels: [factory-ready]
---
Labeled.
`,
  [`${FILTERED}/automations/github-pr-closed-or-merged/automation.md`]: `---
triggers:
  - provider: github
    event: pull_request_merged
    filter:
      repos: { in: [acme/api-service, acme/webapp] }
      labels: { in: ["factory:Acme"] }
  - provider: github
    event: pull_request_closed
    filter:
      repos: acme/webapp
      labels: "factory:Acme"
---
Closed.
`,
  [`${FILTERED}/automations/pr-opened/automation.md`]: `---
triggers:
  - provider: github
    event: pull_request_opened
    filter:
      repos: [acme/api-service]
      labels:
        not_in: [wip]
---
Opened.
`,
};

// Example 05 as published (warpdotdev/warp-factory-examples): one agent,
// routed by labels that are not the factory's own. The ownership labels
// (factory-ready, factory:*) are covered by the 02 fixture above.
const UI = "examples/05-ui-verification";
const ui = {
  [`${UI}/factory.yaml`]: `schemaVersion: v1alpha1
name: ui-verification
alias: Verifier
repositories:
  - owner: acme
    name: webapp
agentDefaults:
  model: auto
  runner: linux-app
`,
  [`${UI}/runners/linux-app.yaml`]:
    "platform: { os: linux, linux: { dockerImage: node:22-bookworm-slim } }\n",
  [`${UI}/agents/verifier/agent.md`]:
    "---\ndescription: Verifies UI.\nagentType: FOREMAN\n---\n# Verifier\n",
  [`${UI}/automations/pr-needs-ui-check/automation.md`]: `---
triggers:
  - provider: github
    event: pull_request_labeled
    filter:
      repos: [acme/webapp]
      labels: [needs-ui-check]
---
A pull request was labeled \`needs-ui-check\`.
`,
  [`${UI}/automations/issue-needs-repro/automation.md`]: `---
triggers:
  - provider: github
    event: issue_labeled
    filter:
      repos: [acme/webapp]
      labels: [needs-repro]
---
An issue was labeled \`needs-repro\`.
`,
};

// A stand-in for warpdotdev/warp-factory-examples, shaped like its default example.
const warp: ScaffoldDeps = {
  cloneWarpExamples: (dest) =>
    files(dest, {
      LICENSE: "MIT License\n\nCopyright (C) 2026 Denver Technologies, Inc.\n",
      "examples/00-warp-default-agents/factory.yaml": `schemaVersion: v1alpha1
name: warp-default-agents
alias: Warp Defaults
repositories: [{ owner: acme, name: api-service }]
integrations: [{ type: slack }]
agentDefaults: { model: auto-genius, runner: linux-standard }
`,
      "examples/00-warp-default-agents/runners/linux-standard.yaml":
        "platform: { os: linux, linux: { dockerImage: ubuntu:24.04 } }\n",
      "examples/00-warp-default-agents/agents/foreman/agent.md": agent(
        "FOREMAN",
        "claude-5-opus-high",
      ),
      "examples/00-warp-default-agents/agents/triage/agent.md": agent(
        "TRIAGE",
        "grok-4-5-high",
      ),
      "examples/00-warp-default-agents/agents/spec/agent.md": agent(
        "SPEC",
        "auto-genius",
      ),
      "examples/00-warp-default-agents/agents/implement/agent.md": agent(
        "IMPLEMENT",
        "claude-5-opus-high",
      ),
      "examples/00-warp-default-agents/agents/review/agent.md": agent(
        "REVIEW",
        "auto-genius",
      ),
      ...filtered,
      ...ui,
    }),
};

const TEMPLATES: Template[] = [
  { kind: "nakara" },
  { kind: "warp" },
  { kind: "import", from: BUNDLED },
  { kind: "blank" },
];

const choices = (
  template: Template,
  more: Partial<ScaffoldChoices> = {},
): ScaffoldChoices => ({
  name: "Web Shop",
  repositories: [{ owner: "acme", name: "shop" }],
  template,
  ...more,
});

/** A file of the tree that must be text. */
function textOf(files: Map<string, string | Uint8Array>, path: string): string {
  const content = files.get(path);
  assert.equal(typeof content, "string", path);
  return content as string;
}

/** Scaffold, write and load the result the way Nakara will. */
async function created(choice: ScaffoldChoices) {
  const result = await scaffold(choice, warp);
  assert.ok(result.ok, JSON.stringify(!result.ok && result.errors));
  const dir = join(await mkdtemp(join(tmpdir(), "nakara-scaffold-")), "f");
  await writeTree(dir, result.files);
  const loaded = await loadDefinition(dir, HARNESS_DEFAULT);
  assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.errors));
  return { result, dir, definition: loaded.definition };
}

for (const template of TEMPLATES)
  test(`the ${template.kind} template with default choices loads`, async () => {
    const { result, definition } = await created(choices(template));
    assert.equal(definition.label, "factory:Web Shop");
    assert.equal(definition.factory.name, "web-shop");
    assert.deepEqual(definition.factory.repositories, [
      { owner: "acme", name: "shop" },
    ]);
    assert.deepEqual(result.factory, {
      slug: "web-shop",
      name: "Web Shop",
      description: definition.factory.description?.trim() ?? "",
      foremanHandle: "web-shop",
    });
    const types = [...definition.agents.values()].map((a) => a.type).sort();
    assert.deepEqual(
      types,
      template.kind === "blank"
        ? ["FOREMAN"]
        : [
            "FOREMAN",
            "IMPLEMENT",
            // Only templates built from Nakara's own factory carry reflect.
            ...(template.kind === "warp" ? [] : ["REFLECT"]),
            "REVIEW",
            "SPEC",
            "TRIAGE",
          ],
    );
    // An import keeps its own automations; templates get the GitHub label intake.
    const automations = definition.automations.map((a) => a.name).sort();
    assert.deepEqual(
      automations,
      template.kind === "import"
        ? [
            "issue-labeled",
            "slack-request",
            "telegram-request",
            "weekly-health-check",
          ]
        : ["issue-labeled"],
    );
  });

test("the Nakara template copies the bundled prompts and the MIT notice", async () => {
  const result = await scaffold(choices({ kind: "nakara" }), warp);
  assert.ok(result.ok);
  for (const path of [
    "agents/implement/agent.md",
    "skills/code-review/SKILL.md",
    "LICENSE.warp-examples",
  ])
    assert.equal(
      result.files.get(path),
      await readFile(join(BUNDLED, path), "utf8"),
    );
});

test("the Warp template keeps the example's license notice", async () => {
  const result = await scaffold(choices({ kind: "warp" }), warp);
  assert.ok(result.ok);
  assert.match(
    textOf(result.files, "LICENSE.warp-examples"),
    /^MIT License\n\nCopyright \(C\) 2026 Denver Technologies/,
  );
  const missing = await scaffold(
    choices({ kind: "warp", example: "99-nope" }),
    warp,
  );
  assert.equal(missing.ok, false);
  const traversal = await scaffold(
    choices({ kind: "warp", example: ".." }),
    warp,
  );
  assert.equal(traversal.ok, false);
});

for (const template of TEMPLATES.filter((t) => t.kind !== "blank"))
  test(`the ${template.kind} template without triage, spec and review keeps implement`, async () => {
    const { definition } = await created(
      choices(template, {
        agents: {
          triage: { enabled: false },
          spec: { enabled: false },
          review: { enabled: false },
        },
      }),
    );
    assert.deepEqual(
      [...definition.agents.values()].map((a) => a.type).sort(),
      // Reflect is no role the wizard toggles, so it stays where the template has it.
      template.kind === "warp"
        ? ["FOREMAN", "IMPLEMENT"]
        : ["FOREMAN", "IMPLEMENT", "REFLECT"],
    );
  });

test("Warp example filters point at the chosen repositories and label", async () => {
  const { definition } = await created(
    choices(
      { kind: "warp", example: "02-sdlc-issue-to-pr" },
      {
        repositories: [
          { owner: "shop", name: "api" },
          { owner: "shop", name: "web" },
        ],
      },
    ),
  );
  const filters = (name: string) =>
    definition.automations
      .find((a) => a.name === name)
      ?.frontmatter.triggers.map((t) => t.filter);
  const repos = ["shop/api", "shop/web"];
  // The example's own issue-labeled automation is the GitHub intake; no second one.
  assert.deepEqual(definition.automations.map((a) => a.name).sort(), [
    "github-pr-closed-or-merged",
    "issue-labeled",
    "pr-opened",
  ]);
  assert.deepEqual(filters("issue-labeled"), [
    { repos, labels: ["factory:Web Shop"] },
  ]);
  assert.deepEqual(filters("github-pr-closed-or-merged"), [
    { repos: { in: repos }, labels: { in: ["factory:Web Shop"] } },
    { repos, labels: "factory:Web Shop" },
  ]);
  // An exclusion is not a label to poll; it stays.
  assert.deepEqual(filters("pr-opened"), [
    { repos, labels: { not_in: ["wip"] } },
  ]);
});

test("Warp example 05 keeps its routing labels", async () => {
  const { definition } = await created(
    choices({ kind: "warp", example: "05-ui-verification" }),
  );
  const filters = (name: string) =>
    definition.automations
      .find((a) => a.name === name)
      ?.frontmatter.triggers.map((t) => t.filter);
  const repos = ["acme/shop"];
  assert.deepEqual(filters("pr-needs-ui-check"), [
    { repos, labels: ["needs-ui-check"] },
  ]);
  // Routing labels are not ownership labels; they stay.
  assert.deepEqual(filters("issue-needs-repro"), [
    { repos, labels: ["needs-repro"] },
  ]);
  // A routed issue_labeled automation is not the GitHub intake, so the
  // factory still gets one that polls its own label.
  assert.deepEqual(filters("issue-labeled"), [undefined]);
  const disabled = await created(
    choices(
      { kind: "warp", example: "05-ui-verification" },
      { intake: { github: false } },
    ),
  );
  assert.deepEqual(disabled.definition.automations.map((a) => a.name).sort(), [
    "issue-needs-repro",
    "pr-needs-ui-check",
  ]);
});

test("the foreman is told which agents are disabled", async () => {
  const note = /Disabled agents: triage, spec; skip their steps\.$/;
  for (const template of TEMPLATES.filter((t) => t.kind !== "blank")) {
    const { definition } = await created(
      choices(template, {
        agents: { triage: { enabled: false }, spec: { enabled: false } },
      }),
    );
    assert.match(definition.foreman.instructions, note, template.kind);
    const { definition: full } = await created(
      choices(template, { agents: { review: { harness: "claude" } } }),
    );
    assert.doesNotMatch(full.foreman.instructions, /Disabled agents/);
  }
});

test("implement and the foreman cannot be turned off", async () => {
  for (const role of ["implement", "foreman"] as const) {
    const result = await scaffold(
      choices({ kind: "nakara" }, { agents: { [role]: { enabled: false } } }),
      warp,
    );
    assert.equal(result.ok, false);
    assert.match(
      !result.ok ? (result.errors[0]?.message ?? "") : "",
      /always on/,
    );
  }
});

test("harness, handle and intake choices land in the tree", async () => {
  const { definition, result } = await created(
    choices(
      { kind: "nakara" },
      {
        handle: "shop",
        description: "The shop.",
        agents: {
          implement: { harness: "codex" },
          review: { harness: "codex" },
          triage: { harness: "claude" },
        },
        intake: {
          github: false,
          telegram: true,
          schedule: { cron: "0 3 * * *" },
        },
      },
    ),
  );
  assert.equal(result.factory.foremanHandle, "shop");
  assert.equal(result.factory.description, "The shop.");
  const harness = (name: string) => definition.agents.get(name)?.harness;
  assert.deepEqual(harness("implement"), { kind: "codex", model: undefined });
  // Already codex: the template's model and effort stay.
  assert.deepEqual(harness("review"), {
    kind: "codex",
    model: "gpt-5.6-terra",
    effort: "low",
  });
  // qwen → claude: the agent inherits no qwen model.
  assert.equal(harness("triage")?.kind, "claude");
  assert.deepEqual(definition.automations.map((a) => a.name).sort(), [
    "scheduled",
    "telegram-request",
  ]);
  const scheduled = definition.automations.find((a) => a.name === "scheduled");
  assert.equal(scheduled?.frontmatter.triggers[0]?.schedule?.cron, "0 3 * * *");
});

test("an import changes only what was chosen", async () => {
  const { result, definition } = await created(
    choices({ kind: "import", from: BUNDLED }),
  );
  const source = new Map<string, string>();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else source.set(path, await readFile(join(dir, entry.name), "utf8"));
    }
  };
  await walk(BUNDLED, "");
  assert.deepEqual([...result.files.keys()].sort(), [...source.keys()].sort());
  for (const [path, text] of source)
    if (path !== "factory.yaml") assert.equal(result.files.get(path), text);
  // The renamed factory polls its own label, not the imported factory's: the
  // bundled issue-labeled automation has no labels filter.
  assert.equal(definition.label, "factory:Web Shop");
  const labeled = definition.automations.find(
    (a) => a.name === "issue-labeled",
  );
  assert.equal(labeled?.frontmatter.triggers[0]?.filter?.labels, undefined);
  for (const text of result.files.values())
    if (typeof text === "string") assert.doesNotMatch(text, /factory:Nakara/);
  // Comments and untouched keys of factory.yaml survive.
  const factory = textOf(result.files, "factory.yaml");
  assert.match(factory, /^# Nakara factory definition/);
  assert.match(factory, /runner: docker/);
});

test("an import keeps other labels and copies binary files byte for byte", async () => {
  const from = await mkdtemp(join(tmpdir(), "nakara-scaffold-"));
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xfe,
  ]);
  await files(from, {
    "factory.yaml": `schemaVersion: v1alpha1
name: old
alias: Old
repositories: []
agentDefaults: { harness: { type: claude } }
`,
    "agents/foreman/agent.md": "---\nagentType: FOREMAN\n---\nLead.\n",
    "automations/labeled/automation.md": `---
triggers:
  - provider: github
    event: issue_labeled
    filter:
      labels: { in: ["factory:Old", "bug"] }
---
Labeled.
`,
  });
  await mkdir(join(from, "docs"));
  await writeFile(join(from, "docs/logo.png"), png);
  const { result, dir, definition } = await created(
    choices({ kind: "import", from }),
  );
  assert.deepEqual(
    definition.automations[0]?.frontmatter.triggers[0]?.filter?.labels,
    { in: ["factory:Web Shop", "bug"] },
  );
  assert.ok(result.files.get("docs/logo.png") instanceof Uint8Array);
  assert.deepEqual(await readFile(join(dir, "docs/logo.png")), png);
});

test("an invalid tree is reported and never written", async () => {
  const bad = await scaffold(
    choices(
      { kind: "nakara" },
      {
        agents: { foreman: { harness: "codex" } },
        intake: { schedule: { cron: "not a cron" } },
      },
    ),
    warp,
  );
  assert.equal(bad.ok, false);
  const paths = !bad.ok ? bad.errors.map((e) => e.path).sort() : [];
  assert.deepEqual(paths, [
    "agents/foreman/agent.md",
    "automations/scheduled/automation.md",
  ]);
  const handle = await scaffold(
    choices({ kind: "blank" }, { handle: "Not A Handle" }),
  );
  assert.equal(handle.ok, false);
  const empty = await mkdtemp(join(tmpdir(), "nakara-scaffold-"));
  const imported = await scaffold(choices({ kind: "import", from: empty }));
  assert.equal(imported.ok, false);
});

test("writeTree refuses a directory that is not empty", async () => {
  const result = await scaffold(choices({ kind: "blank" }));
  assert.ok(result.ok);
  const dir = await mkdtemp(join(tmpdir(), "nakara-scaffold-"));
  await writeFile(join(dir, "keep.txt"), "mine");
  await assert.rejects(writeTree(dir, result.files), /not empty/);
  assert.deepEqual(await readdir(dir), ["keep.txt"]);
  // An empty directory is fine.
  const empty = await mkdtemp(join(tmpdir(), "nakara-scaffold-"));
  await writeTree(empty, result.files);
  assert.deepEqual((await readdir(empty)).sort(), [
    "agents",
    "automations",
    "factory.yaml",
  ]);
});

test("a scaffolded agent whose harness its runner's egress cannot reach gets a warning naming the hosts", async () => {
  // The Warp default example runs on a docker runner with the default egress:
  // Anthropic, GitHub and npm, so a codex reviewer cannot reach its model (#21).
  const { result } = await created(
    choices({ kind: "warp" }, { agents: { review: { harness: "codex" } } }),
  );
  assert.deepEqual(
    result.warnings
      .filter((w) => /cannot reach the model/.test(w.message))
      .map((w) => [w.path, w.message]),
    [
      [
        "agents/review/agent.md",
        'agent "review" uses codex but runner "linux-standard" egress does not allow chatgpt.com, auth.openai.com, so its runs cannot reach the model; add them under egress.allow, or give the agent a harness the runner reaches',
      ],
    ],
  );
  // With claude everywhere, the same template has nothing to warn about.
  const claude = await created(choices({ kind: "warp" }));
  assert.deepEqual(
    claude.result.warnings.filter((w) => /cannot reach/.test(w.message)),
    [],
  );
});
