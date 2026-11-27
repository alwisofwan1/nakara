import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { promisify } from "node:util";
import type { HttpBindings } from "@hono/node-server";

import { loadConfig } from "../config.ts";
import { Store, stubFactorySeed } from "../db.ts";
import { definitionHistory } from "../definition/history.ts";
import { fileRevision } from "../definition/load.ts";
import { GithubPoller } from "../intake/github.ts";
import type { Factory } from "../orchestrator/factory.ts";
import { ITEM_KV_PREFIXES } from "../orchestrator/item-keys.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import {
  limitsInput,
  readFactorySettings,
  type SlackChannels,
} from "./factories.ts";
import { createApp } from "./test-support.ts";

const exec = promisify(execFile);
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

test("factory settings: the record, its definition and its active items", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factories = store.repos.factories;
  const harbor = factories.createFactory({
    ...stubFactorySeed(),
    slug: "harbor",
    name: "Harbor",
    avatar_color: "#0e7490",
    foreman_handle: "harbor",
    definition_dir: "/data/factories/harbor",
    definition_mode: "managed",
  });
  for (const stage of [
    "building",
    "planning",
    "complete",
    "cancelled",
  ] as const) {
    const item = store.createItem({
      title: stage,
      request: stage,
      source: "manual",
      factoryId: harbor.id,
    });
    store.updateItem(item.id, { stage });
  }
  const history = [
    { sha: "a".repeat(40), at: "2026-10-24T10:00:00Z", message: "Edit" },
  ];
  assert.deepEqual(
    readFactorySettings(store.repos, "harbor", {
      repositories: ["acme/widgets"],
      label: "factory:Harbor",
      history,
      archiveDir: "/data/archive/factories/harbor",
      backupDir: "/data/backups",
      specAgent: true,
      factoryFile: {
        description: "Ships.",
        agentDefaults: {
          harness: "claude",
          model: "sonnet",
          effort: null,
          runner: "docker",
          idleTimeoutMinutes: null,
        },
        repositories: ["acme/widgets"],
        revision: "r",
      },
      runners: [{ name: "docker", sandbox: true }],
      pendingReach: null,
      intake: [],
      slackConnected: true,
    }),
    {
      slug: "harbor",
      name: "Harbor",
      avatarColor: "#0e7490",
      foremanHandle: "harbor",
      label: "factory:Harbor",
      isDefault: false,
      activeItems: 2,
      backupDir: "/data/backups",
      factoryFile: {
        description: "Ships.",
        agentDefaults: {
          harness: "claude",
          model: "sonnet",
          effort: null,
          runner: "docker",
          idleTimeoutMinutes: null,
        },
        repositories: ["acme/widgets"],
        revision: "r",
      },
      runners: [{ name: "docker", sandbox: true }],
      pendingReach: null,
      intake: [],
      limits: {
        budgetUsd: 15,
        maxReviews: 1,
        maxRevisions: 2,
        maxRuns: 50,
        specRule: "when_asked",
        gateChecks: [],
        defaults: {
          budgetUsd: 15,
          maxReviews: 1,
          maxRevisions: 2,
          maxRuns: 50,
        },
      },
      paused: false,
      pausedAt: null,
      notifications: {
        slackChannel: null,
        notify: { approvals: true, handoff: true, paused: true },
        slackConnected: true,
      },
      definition: {
        mode: "managed",
        dir: "/data/factories/harbor",
        repositories: ["acme/widgets"],
        history,
        archiveDir: "/data/archive/factories/harbor",
        specAgent: true,
      },
    },
  );
  assert.equal(
    readFactorySettings(store.repos, factories.defaultFactory().slug, {
      repositories: [],
      label: null,
      history: [],
      archiveDir: null,
      backupDir: "/data/backups",
      specAgent: false,
      factoryFile: null,
      runners: [],
      pendingReach: null,
      intake: [],
      slackConnected: false,
    })?.isDefault,
    true,
  );
  assert.equal(
    readFactorySettings(store.repos, "nope", {
      repositories: [],
      label: null,
      history: [],
      archiveDir: null,
      backupDir: "/data/backups",
      specAgent: false,
      factoryFile: null,
      runners: [],
      pendingReach: null,
      intake: [],
      slackConnected: false,
    }),
    undefined,
  );
});

/**
 * A registry of two factories: the default one, kept in a folder, and Harbor,
 * Nakara-managed under the data directory. Both start from the bundled
 * definition; Harbor claims other repositories so both load.
 */
async function setup(
  t: { after: (fn: () => Promise<void>) => void },
  slack: SlackChannels | null = null,
  /** A database file in the data dir, beside which factories keep their applied copy. */
  onDisk = false,
) {
  const dataDir = await mkdtemp(join(tmpdir(), "nakara-settings-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const defaultDir = join(dataDir, "default");
  const harborDir = join(dataDir, "factories", "harbor");
  await cp("factory", defaultDir, { recursive: true });
  await cp("factory", harborDir, { recursive: true });
  // Harbor claims a repository of its own, so both factories load.
  const yaml = join(harborDir, "factory.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      /repositories:\n(?: {2}- owner: .*\n {4}name: .*\n)+/,
      "repositories:\n  - owner: acme\n    name: harbor\n",
    ),
  );
  // A claude that only answers the model lookup; codex cannot list its models.
  const fakeClaude = join(dataDir, "fake-claude");
  await writeFile(
    fakeClaude,
    `#!/bin/sh\nread -r _\necho '${JSON.stringify({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: "models",
        response: {
          models: [
            { value: "opus", displayName: "Opus" },
            { value: "sonnet", displayName: "Sonnet" },
          ],
        },
      },
    })}'\n`,
    { mode: 0o755 },
  );
  const config = loadConfig({
    NAKARA_DATA_DIR: dataDir,
    NAKARA_DEFINITION_DIR: defaultDir,
    NAKARA_GITHUB_MIRROR: "false",
    NAKARA_CLAUDE_BIN: fakeClaude,
    NAKARA_CODEX_BIN: "/bin/false",
  });
  const store = new Store(onDisk ? join(dataDir, "nakara.db") : ":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({ ...stubFactorySeed(), definition_dir: defaultDir }),
  });
  if (onDisk) t.after(async () => store.close());
  store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "harbor",
    name: "Harbor",
    avatar_color: "#0e7490",
    foreman_handle: "harbor",
    definition_dir: harborDir,
    definition_mode: "managed",
  });
  const registry = new FactoryRegistry(store, config);
  for (const factory of registry.factories) {
    factory.pump = async () => {};
    assert.ok((await factory.reloadDefinition()).ok);
  }
  const cloned: string[] = [];
  /** Set to make the next gh repo clone fail. */
  const clone = { fail: false };
  /** Repositories the agent token cannot push to, as gh api answers. */
  const denied = new Set<string>();
  const app = createApp(
    registry,
    new GithubPoller(registry.factories),
    config,
    "token",
    undefined,
    {
      env: {},
      clone: async () => {},
      // gh repo clone, offline: an empty repository with a working tree.
      gh: async (args) => {
        if (args[0] === "repo" && args[1] === "clone") {
          if (clone.fail)
            return {
              ok: false,
              stdout: "",
              stderr: "Could not resolve host: github.com",
            };
          const dest = args[3] ?? "";
          cloned.push(args[2] ?? "");
          await mkdir(dest, { recursive: true });
          await exec("git", ["init", "--quiet"], { cwd: dest });
          return { ok: true, stdout: "", stderr: "" };
        }
        // gh api repos/<owner/name> --jq .permissions.push, as /wizard/access asks.
        if (args[0] === "api" && args[1]?.startsWith("repos/"))
          return denied.has(args[1].slice("repos/".length))
            ? { ok: false, stdout: "", stderr: "HTTP 404: Not Found" }
            : { ok: true, stdout: "true\n", stderr: "" };
        return { ok: false, stdout: "", stderr: "unexpected gh call" };
      },
    },
    slack,
  );
  const call = async (method: string, path: string, json?: unknown) => {
    const response = await app.request(
      `http://localhost/api/${path}`,
      {
        method,
        ...(json !== undefined && {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(json),
        }),
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } } as HttpBindings,
    );
    // biome-ignore lint/suspicious/noExplicitAny: Asserted field by field below.
    return { status: response.status, body: (await response.json()) as any };
  };
  // biome-ignore lint/style/noNonNullAssertion: Registered above.
  const harbor: Factory = registry.get("harbor")!;
  return {
    dataDir,
    harborDir,
    store,
    registry,
    harbor,
    call,
    cloned,
    clone,
    denied,
  };
}

test("rename keeps the slug and URLs; another factory's name is refused", async (t) => {
  const { store, harbor, call } = await setup(t);
  const renamed = await call("PUT", "f/harbor/settings", {
    name: "  Harbor Ops ",
    avatarColor: "#B45309",
  });
  assert.deepEqual(renamed, { status: 200, body: { slug: "harbor" } });
  const settings = await call("GET", "f/harbor/settings");
  assert.equal(settings.body.name, "Harbor Ops");
  assert.equal(settings.body.avatarColor, "#b45309");
  assert.equal(settings.body.slug, "harbor");
  assert.equal(harbor.record?.name, "Harbor Ops");
  assert.deepEqual(
    (await call("GET", "factories")).body.map((f: { slug: string }) => f.slug),
    [store.repos.factories.defaultFactory().slug, "harbor"],
  );
  // The pages and API stay at /f/harbor.
  assert.equal((await call("GET", "f/harbor/items")).status, 200);

  const taken = await call("PUT", "f/harbor/settings", {
    name: store.repos.factories.defaultFactory().name.toUpperCase(),
    avatarColor: "#b45309",
  });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, "policy");
  assert.equal(
    (
      await call("PUT", "f/harbor/settings", {
        name: " ",
        avatarColor: "#b45309",
      })
    ).status,
    400,
  );
});

test("limits: a factory without settings uses the env defaults, a saved one its own, and items keep their snapshot", async (t) => {
  const { store, harbor, call } = await setup(t);
  const harborId = harbor.record?.id;
  const other = store.repos.factories.defaultFactory();
  const create = (factoryId: number | undefined) =>
    store.createItem({ title: "T", request: "R", source: "manual", factoryId });
  const limitsOf = (item: { id: number }) => {
    // biome-ignore lint/style/noNonNullAssertion: Created above.
    const row = store.item(item.id)!;
    return [row.budget_usd, row.max_reviews, row.max_revisions, row.max_runs];
  };
  const defaults = {
    budgetUsd: 15,
    maxReviews: 1,
    maxRevisions: 2,
    maxRuns: 50,
  };

  // No saved settings: exactly the env limits.
  const before = create(harborId);
  assert.deepEqual(limitsOf(before), [15, 1, 2, 50]);
  assert.deepEqual((await call("GET", "f/harbor/settings")).body.limits, {
    ...defaults,
    specRule: "when_asked",
    gateChecks: [],
    defaults,
  });

  const saved = await call("PUT", "f/harbor/settings/limits", {
    budgetUsd: 5,
    maxReviews: 3,
    maxRevisions: 0,
    maxRuns: 120,
  });
  assert.deepEqual(saved, {
    status: 200,
    body: {
      budgetUsd: 5,
      maxReviews: 3,
      maxRevisions: 0,
      maxRuns: 120,
      specRule: "when_asked",
      gateChecks: [],
      defaults,
    },
  });
  assert.deepEqual(limitsOf(create(harborId)), [5, 3, 0, 120]);
  // Another factory keeps the env defaults.
  assert.deepEqual(limitsOf(create(other.id)), [15, 1, 2, 50]);
  // An explicit budget from New work still wins.
  assert.equal(
    store.createItem({
      title: "T",
      request: "R",
      source: "manual",
      factoryId: harborId,
      budgetUsd: 8,
    }).budget_usd,
    8,
  );
  // Items created before the change keep the limits they copied (ADR-0006 rule 1).
  assert.deepEqual(limitsOf(before), [15, 1, 2, 50]);

  // An omitted key stays; null resets one to its default.
  const reset = await call("PUT", "f/harbor/settings/limits", {
    budgetUsd: null,
    maxRevisions: 4,
  });
  assert.deepEqual(reset.body, {
    budgetUsd: 15,
    maxReviews: 3,
    maxRevisions: 4,
    maxRuns: 120,
    specRule: "when_asked",
    gateChecks: [],
    defaults,
  });
  assert.deepEqual(limitsOf(create(harborId)), [15, 3, 4, 120]);
});

test("spec rule: saved with the limits, copied by new items, and items created before a change keep their rule", async (t) => {
  const { store, harbor, call } = await setup(t);
  const harborId = harbor.record?.id;
  const create = (specRequested?: boolean) =>
    store.createItem({
      title: "T",
      request: "R",
      source: "manual",
      factoryId: harborId,
      specRequested,
    });
  const ruleOf = (item: { id: number }) => {
    // biome-ignore lint/style/noNonNullAssertion: Created above.
    const row = store.item(item.id)!;
    return [row.spec_rule, row.spec_requested];
  };

  // No saved rule: the Foreman decides, and an item may ask for a Spec.
  const plain = create();
  const asked = create(true);
  assert.deepEqual(ruleOf(plain), ["when_asked", 0]);
  assert.deepEqual(ruleOf(asked), ["when_asked", 1]);

  const always = await call("PUT", "f/harbor/settings/limits", {
    specRule: "always",
  });
  assert.equal(always.status, 200);
  assert.equal(always.body.specRule, "always");
  // Only the rule changed; the limits keep their defaults.
  assert.equal(always.body.budgetUsd, 15);
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.limits.specRule,
    "always",
  );
  const strict = create();
  assert.deepEqual(ruleOf(strict), ["always", 0]);
  // An item cannot opt out of always, nor into never.
  assert.throws(() => create(true), /always writes a Spec first/);

  assert.equal(
    (await call("PUT", "f/harbor/settings/limits", { specRule: "never" })).body
      .specRule,
    "never",
  );
  assert.deepEqual(ruleOf(create()), ["never", 0]);
  assert.throws(() => create(true), /does not write Specs/);
  // Items created before each change keep the rule they copied (ADR-0006 rule 1).
  assert.deepEqual(ruleOf(plain), ["when_asked", 0]);
  assert.deepEqual(ruleOf(asked), ["when_asked", 1]);
  assert.deepEqual(ruleOf(strict), ["always", 0]);

  // null resets to when_asked; an unknown rule is refused.
  assert.equal(
    (await call("PUT", "f/harbor/settings/limits", { specRule: null })).body
      .specRule,
    "when_asked",
  );
  assert.equal(
    (await call("PUT", "f/harbor/settings/limits", { specRule: "sometimes" }))
      .status,
    400,
  );
});

test("handoff gate: review and verification switch on per factory, new items copy them, and no input can turn CI off", async (t) => {
  const { store, harbor, call } = await setup(t);
  const harborId = harbor.record?.id;
  const create = () =>
    store.createItem({
      title: "T",
      request: "R",
      source: "manual",
      factoryId: harborId,
    });
  const checksOf = (item: { id: number }) => store.item(item.id)?.gate_checks;

  const before = create();
  assert.equal(checksOf(before), "[]");

  const both = await call("PUT", "f/harbor/settings/limits", {
    gateReview: true,
    gateVerification: true,
  });
  assert.equal(both.status, 200);
  assert.deepEqual(both.body.gateChecks, ["review", "verification"]);
  // Only the gate changed; the limits keep their defaults.
  assert.equal(both.body.budgetUsd, 15);
  assert.deepEqual(
    (await call("GET", "f/harbor/settings")).body.limits.gateChecks,
    ["review", "verification"],
  );
  const strict = create();
  assert.equal(checksOf(strict), '["review","verification"]');

  // false and null both turn a check off; an omitted one stays.
  assert.deepEqual(
    (await call("PUT", "f/harbor/settings/limits", { gateReview: false })).body
      .gateChecks,
    ["verification"],
  );
  assert.equal(checksOf(create()), '["verification"]');
  assert.deepEqual(
    (await call("PUT", "f/harbor/settings/limits", { gateVerification: null }))
      .body.gateChecks,
    [],
  );
  // Items created before each change keep the checks they copied.
  assert.equal(checksOf(before), "[]");
  assert.equal(checksOf(strict), '["review","verification"]');

  // The fixed part has no field: an input that tries to turn it off is refused.
  for (const body of [
    { gateCi: false },
    { gateChecks: [] },
    { gatePushed: false },
    { gateReview: "yes" },
  ])
    assert.equal(
      (await call("PUT", "f/harbor/settings/limits", body)).status,
      400,
      JSON.stringify(body),
    );
  assert.deepEqual(
    Object.keys(limitsInput.shape).filter((key) => key.startsWith("gate")),
    ["gateReview", "gateVerification"],
  );
});

test("spec rule: always on a definition without a spec agent is saved, and Settings reports the missing agent for the row's warning", async (t) => {
  const { harborDir, harbor, call } = await setup(t);
  const specAgent = async () =>
    (await call("GET", "f/harbor/settings")).body.definition.specAgent;
  assert.equal(await specAgent(), true);

  await rm(join(harborDir, "agents", "spec"), { recursive: true });
  assert.ok((await harbor.reloadDefinition()).ok);
  assert.equal(await specAgent(), false);
  // Allowed with the warning: the definition can change after the rule is
  // saved, so the Foreman's refusal, not this save, guards the stall.
  const always = await call("PUT", "f/harbor/settings/limits", {
    specRule: "always",
  });
  assert.equal(always.status, 200);
  assert.equal(always.body.specRule, "always");
  assert.equal(await specAgent(), false);
});

test("pause and resume are idempotent, return the new state, and show in the settings and the factory list", async (t) => {
  const { call } = await setup(t);
  const listed = async () =>
    (await call("GET", "factories")).body.map(
      (f: { slug: string; paused: boolean }) => [f.slug, f.paused],
    );
  const state = async () => {
    const { paused, pausedAt } = (await call("GET", "f/harbor/settings")).body;
    return { paused, pausedAt };
  };
  assert.deepEqual(await state(), { paused: false, pausedAt: null });

  const paused = await call("POST", "f/harbor/pause");
  assert.equal(paused.status, 200);
  assert.equal(paused.body.paused, true);
  assert.match(paused.body.pausedAt, /^\d{4}-\d\d-\d\dT/);
  // Pausing again keeps the first pause time.
  assert.deepEqual(await call("POST", "f/harbor/pause"), paused);
  assert.deepEqual(await state(), paused.body);
  // Only the paused factory shows the chip.
  assert.deepEqual(await listed(), [
    ["default", false],
    ["harbor", true],
  ]);

  const resumed = { status: 200, body: { paused: false, pausedAt: null } };
  assert.deepEqual(await call("POST", "f/harbor/resume"), resumed);
  assert.deepEqual(await call("POST", "f/harbor/resume"), resumed);
  assert.deepEqual(await state(), resumed.body);
  assert.deepEqual(await listed(), [
    ["default", false],
    ["harbor", false],
  ]);
  assert.equal((await call("POST", "f/missing/pause")).status, 404);
});

test("limits: out-of-range values are refused with 400 and change nothing", async (t) => {
  const { call } = await setup(t);
  for (const json of [
    { budgetUsd: 0.5 },
    { budgetUsd: 100.5 },
    { budgetUsd: 5.25 },
    { maxReviews: 0 },
    { maxReviews: 6 },
    { maxRevisions: -1 },
    { maxRevisions: 6 },
    { maxRevisions: 1.5 },
    { maxRuns: 4 },
    { maxRuns: 201 },
    { maxRuns: "50" },
    { budget: 5 },
  ]) {
    const refused = await call("PUT", "f/harbor/settings/limits", json);
    assert.equal(refused.status, 400, JSON.stringify(json));
    assert.equal(
      refused.body.error.code,
      "invalid_input",
      JSON.stringify(json),
    );
  }
  assert.equal(
    (await call("PUT", "f/nope/settings/limits", { maxRuns: 60 })).status,
    404,
  );
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.limits.budgetUsd,
    15,
  );
});

test("delete is refused while items are active and for the default factory", async (t) => {
  const { dataDir, store, registry, harbor, harborDir, call } = await setup(t);
  const id = harbor.record?.id;
  const active = store.createItem({
    title: "Active",
    request: "Active",
    source: "manual",
    factoryId: id,
  });
  const closed = store.createItem({
    title: "Closed",
    request: "Closed",
    source: "manual",
    factoryId: id,
  });
  store.updateItem(closed.id, { stage: "complete", status: "done" });
  store.addMessage(closed.id, "factory", "Done.");
  const removed: string[] = [];
  registry.onRemoved((f) => removed.push(f.record?.slug ?? ""));
  const backups = join(dataDir, "backups");
  const snapshots = () => readdir(backups).catch(() => [] as string[]);

  const refused = await call("DELETE", "f/harbor");
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, "policy");
  assert.match(refused.body.error.message, /1 active work item/);
  assert.ok(registry.get("harbor"));

  const slug = store.repos.factories.defaultFactory().slug;
  const fallback = await call("DELETE", `f/${slug}`);
  assert.equal(fallback.status, 409);
  assert.match(fallback.body.error.message, /default factory/);
  // A refused delete takes no snapshot.
  assert.deepEqual(await snapshots(), []);

  store.updateItem(active.id, { stage: "cancelled", status: "done" });
  const deleted = await call("DELETE", "f/harbor");
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.deleted, "harbor");
  // The database is snapshotted first: the copy still has Harbor and its work.
  const taken = await snapshots();
  assert.equal(taken.length, 1);
  assert.match(taken[0] ?? "", /^nakara-.+-pre-delete-harbor\.db$/);
  assert.equal(deleted.body.snapshot, join(backups, taken[0] ?? ""));
  const copy = new DatabaseSync(deleted.body.snapshot, { readOnly: true });
  t.after(() => copy.close());
  assert.equal(
    copy.prepare("SELECT id FROM work_items WHERE id = ?").get(closed.id)?.id,
    closed.id,
  );
  assert.ok(
    copy.prepare("SELECT 1 FROM factories WHERE slug = ?").get("harbor"),
  );
  assert.deepEqual(removed, ["harbor"]);
  assert.equal(registry.get("harbor"), undefined);
  assert.equal(store.repos.factories.factory("harbor"), undefined);
  assert.equal(store.item(closed.id), undefined);
  assert.equal(await exists(harborDir), false);
  assert.equal((await call("GET", "f/harbor/settings")).status, 404);
});

test("each web edit of a managed definition is a commit", async (t) => {
  const { harborDir, call } = await setup(t);
  const created = await call("POST", "f/harbor/agents", {
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });
  assert.equal(created.status, 201);
  const agent = await call("GET", "f/harbor/agents/helper");
  // Saves are committed, so the page does not ask to commit them.
  assert.equal(agent.body.gitTracked, false);
  const deleted = await call("DELETE", "f/harbor/agents/helper", {
    revision: agent.body.revision,
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    (await definitionHistory(harborDir)).map((c) => c.message),
    ["Delete agent helper", "Create agent helper", "Initial definition"],
  );
  const { stdout } = await promisify(execFile)(
    "git",
    ["status", "--porcelain"],
    { cwd: harborDir },
  );
  assert.equal(stdout, "");
  const settings = await call("GET", "f/harbor/settings");
  assert.deepEqual(
    settings.body.definition.history.map((c: { message: string }) => c.message),
    ["Delete agent helper", "Create agent helper", "Initial definition"],
  );
  // A refused edit commits nothing.
  const again = await call("POST", "f/harbor/agents", {
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });
  assert.equal(again.status, 201);
  assert.equal(
    (
      await call("POST", "f/harbor/agents", {
        name: "helper",
        type: "CUSTOM",
        description: null,
        prompt: "Again.",
      })
    ).status,
    409,
  );
  assert.equal((await definitionHistory(harborDir)).length, 4);
});

test("creating and deleting an automation in a managed definition is one commit each", async (t) => {
  const { harborDir, call } = await setup(t);
  const nightly = {
    name: "nightly",
    displayName: "Nightly",
    trigger: { kind: "schedule", cron: "0 3 * * *" },
    agent: "foreman",
    instructions: "Report.",
    enabled: true,
  };
  const created = await call("POST", "f/harbor/automations", nightly);
  assert.equal(created.status, 201);
  // A taken name commits nothing.
  assert.equal(
    (await call("POST", "f/harbor/automations", nightly)).status,
    409,
  );
  const listed = await call("GET", "f/harbor/automations");
  const revision = listed.body.find(
    (a: { name: string }) => a.name === "nightly",
  )?.revision;
  // A stale delete commits nothing.
  assert.equal(
    (
      await call("DELETE", "f/harbor/automations/nightly", {
        revision: "0".repeat(64),
      })
    ).status,
    409,
  );
  const deleted = await call("DELETE", "f/harbor/automations/nightly", {
    revision,
  });
  assert.equal(deleted.status, 200);
  assert.deepEqual(
    (await definitionHistory(harborDir)).map((c) => c.message),
    [
      "Delete automation nightly",
      "Create automation nightly",
      "Initial definition",
    ],
  );
  const { stdout } = await promisify(execFile)(
    "git",
    ["status", "--porcelain"],
    { cwd: harborDir },
  );
  assert.equal(stdout, "");
});

test("move writes the tree into the repository folder and switches the mode", async (t) => {
  const { dataDir, harborDir, harbor, call, cloned } = await setup(t);
  const target = join(dataDir, "checkouts", "acme", "harbor", "ops", "factory");
  // Only one of the factory's repositories.
  const outside = await call("POST", "f/harbor/definition/move", {
    repo: "acme/other",
    folder: "factory",
  });
  assert.equal(outside.status, 409);
  assert.equal(
    (
      await call("POST", "f/harbor/definition/move", {
        repo: "acme/harbor",
        folder: "../escape",
      })
    ).status,
    400,
  );
  // An edit first, so the managed history exists.
  await call("POST", "f/harbor/agents", {
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });

  // An earlier harbor left an archive: this one goes next to it, and the
  // page names that folder before the move.
  const archives = join(dataDir, "archive", "factories");
  await mkdir(join(archives, "harbor"), { recursive: true });
  const archive = join(archives, "harbor-2");
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.definition.archiveDir,
    archive,
  );

  const moved = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "ops/factory",
  });
  assert.deepEqual(moved, { status: 200, body: { dir: target, archive } });
  assert.deepEqual(cloned, ["acme/harbor"]);
  assert.ok(await exists(join(target, "factory.yaml")));
  assert.ok(await exists(join(target, "agents", "helper", "agent.md")));
  // The managed history stays out of the repository.
  assert.equal(await exists(join(target, ".git")), false);
  // The managed folder is archived with its history, not deleted.
  assert.equal(await exists(harborDir), false);
  assert.ok(await exists(join(archive, "agents", "helper", "agent.md")));
  assert.deepEqual(
    (await definitionHistory(archive)).map((c) => c.message),
    ["Create agent helper", "Initial definition"],
  );
  assert.deepEqual(await readdir(join(archives, "harbor")), []);
  assert.equal(harbor.config.definitionDir, target);
  assert.ok(harbor.definition?.agents.has("helper"));
  const settings = await call("GET", "f/harbor/settings");
  assert.equal(settings.body.definition.mode, "repo");
  assert.equal(settings.body.definition.dir, target);
  assert.deepEqual(settings.body.definition.history, []);
  assert.equal(settings.body.definition.archiveDir, null);

  // Edits now land in the repository folder, uncommitted.
  await call("POST", "f/harbor/agents", {
    name: "second",
    type: "CUSTOM",
    description: null,
    prompt: "Second.",
  });
  assert.ok(await exists(join(target, "agents", "second", "agent.md")));
  assert.equal(
    (await call("GET", "f/harbor/agents/second")).body.gitTracked,
    true,
  );
  // A repository definition is not moved again.
  const again = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "other",
  });
  assert.equal(again.status, 409);
  assert.deepEqual(
    await readdir(join(dataDir, "checkouts", "acme", "harbor")),
    [".git", "ops"],
  );
});

test("move refuses a folder that has files", async (t) => {
  const { dataDir, harborDir, call } = await setup(t);
  const checkout = join(dataDir, "checkouts", "acme", "harbor");
  await mkdir(join(checkout, "factory"), { recursive: true });
  await exec("git", ["init", "--quiet"], { cwd: checkout });
  await cp("README.md", join(checkout, "factory", "README.md"));
  for (const args of [
    ["add", "--all"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Docs"],
    ["remote", "add", "origin", checkout],
  ])
    await exec("git", args, { cwd: checkout });
  const refused = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "factory",
  });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /already has files/);
  assert.ok(await exists(join(harborDir, "factory.yaml")));
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.definition.mode,
    "managed",
  );
  // A refused move archives nothing.
  assert.equal(await exists(join(dataDir, "archive")), false);
});

/** A closed item of `factoryId` with a run of `status`. */
function closedItemWithRun(
  store: Store,
  factoryId: number | undefined,
  status: "queued" | "succeeded",
) {
  const item = store.createItem({
    title: "Closed",
    request: "Closed",
    source: "manual",
    factoryId,
  });
  store.updateItem(item.id, { stage: "complete", status: "done" });
  const run = store.createRun({
    item_id: item.id,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    session_id: null,
    input: "Build it",
    status,
  });
  return { item, run };
}

test("delete and move are refused while the factory has a run in progress", async (t) => {
  const { store, registry, harbor, harborDir, call } = await setup(t);
  closedItemWithRun(store, harbor.record?.id, "queued");
  const deleted = await call("DELETE", "f/harbor");
  assert.equal(deleted.status, 409);
  assert.equal(deleted.body.error.code, "policy");
  assert.match(deleted.body.error.message, /1 run in progress/);
  assert.ok(registry.get("harbor"));
  const moved = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "factory",
  });
  assert.equal(moved.status, 409);
  assert.match(moved.body.error.message, /1 run in progress/);
  assert.ok(await exists(join(harborDir, "factory.yaml")));
});

test("delete removes the closed items' runs, approvals, events, messages and keys", async (t) => {
  const { store, harbor, call } = await setup(t);
  const { item, run } = closedItemWithRun(
    store,
    harbor.record?.id,
    "succeeded",
  );
  store.addMessage(item.id, "factory", "Done.");
  store.addEvent(item.id, "human_message", { text: "Thanks" });
  const approvalId = store.addApproval(item.id, "question", "Ship it?", null);
  const keys = [
    `ci-wait:${item.id}`,
    `ci-failed:${item.id}`,
    `push-only:${item.id}`,
    `pr-closed:${item.id}:https://github.com/acme/harbor/pull/1`,
    `merge-submitted:${item.id}`,
    `run-limit-told:${item.id}`,
    `reflect:${item.id}:event`,
    `slack:item:${item.id}`,
    `tg:approval:${approvalId}`,
    `slack:approval:${approvalId}`,
    `slack:reject:${approvalId}`,
    `reflect:factory:${harbor.record?.id}:unchecked`,
    "repo:harbor",
  ];
  for (const key of keys) store.setKv(key, "1");
  // Another factory's keep their state.
  const other = store.repos.factories.defaultFactory().slug;
  store.setKv(`repo:${other}`, "1");
  const otherUnchecked = `reflect:factory:${store.repos.factories.defaultFactory().id}:unchecked`;
  store.setKv(otherUnchecked, "2");
  // A key of another item whose id starts with this one's stays.
  const lookalike = `ci-wait:${item.id}0`;
  store.setKv(lookalike, "1");

  assert.equal((await call("DELETE", "f/harbor")).status, 200);
  const count = (table: string) =>
    (
      store.db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE item_id = ?`)
        .get(item.id) as { n: number }
    ).n;
  for (const table of ["runs", "approvals", "events", "messages"])
    assert.equal(count(table), 0, table);
  assert.equal(store.runById(run.id), undefined);
  for (const key of keys) assert.equal(store.getKv(key), undefined, key);
  assert.equal(store.getKv(`repo:${other}`), "1");
  assert.equal(store.getKv(otherUnchecked), "2");
  assert.equal(store.getKv(lookalike), "1");
});

test("a factory created after a delete gets a new id, and none of the deleted one's applied copy, reach or keys", async (t) => {
  const { dataDir, store, registry, harbor, call } = await setup(t, null, true);
  const id = harbor.record?.id;
  assert.ok(id);
  const applied = join(dataDir, "applied", String(id));
  assert.ok(await exists(join(applied, "factory.yaml")));
  assert.ok(store.getKv(`reach:${id}`));
  const { item } = closedItemWithRun(store, id, "succeeded");
  store.setKv(`run-limit-told:${item.id}`, "50");
  store.setKv(`reflect:factory:${id}:unchecked`, "1");
  assert.equal((await call("DELETE", "f/harbor")).status, 200);
  for (const key of [`reach:${id}`, `reach:${id}:pending`, `reach:${id}:repos`])
    assert.equal(store.getKv(key) ?? "", "", key);
  assert.equal(store.getKv(`run-limit-told:${item.id}`), undefined);
  assert.equal(store.getKv(`reflect:factory:${id}:unchecked`), undefined);
  assert.equal(await exists(applied), false);
  // The default factory keeps its approved reach and applied copy.
  const defaultId = registry.default.record?.id;
  assert.ok(store.getKv(`reach:${defaultId}`));
  assert.ok(await exists(join(dataDir, "applied", String(defaultId))));

  // The next factory gets a new id; its other repositories are its first reach, not a widening.
  const dir = join(dataDir, "factories", "reborn");
  await cp("factory", dir, { recursive: true });
  const yaml = join(dir, "factory.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace(
      /repositories:\n(?: {2}- owner: .*\n {4}name: .*\n)+/,
      "repositories:\n  - owner: acme\n    name: reborn\n",
    ),
  );
  const record = store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "reborn",
    name: "Reborn",
    avatar_color: "#0e7490",
    foreman_handle: "reborn",
    definition_dir: dir,
    definition_mode: "managed",
  });
  assert.equal(record.id, id + 1);
  const newItem = store.createItem({
    title: "New",
    request: "New",
    source: "manual",
    factoryId: record.id,
  });
  assert.equal(newItem.id, item.id + 1);
  const reborn = await registry.register(record);
  assert.ok(
    reborn.definition,
    JSON.stringify(reborn.definitionProblems.errors),
  );
  assert.equal(reborn.pendingReach(), null);
  // It keeps its own applied copy, of its own definition, and nothing of harbor's.
  assert.equal(await exists(applied), false);
  assert.match(
    await readFile(
      join(dataDir, "applied", String(record.id), "factory.yaml"),
      "utf8",
    ),
    /name: reborn/,
  );
  // No kv key of harbor's id or its item's is left for the new ones to inherit.
  const keyed = (key: string, prefix: string, of: number) =>
    key === `${prefix}${of}` || key.startsWith(`${prefix}${of}:`);
  const inherited = store.repos.kv
    .kvKeys("")
    .filter(
      (key) =>
        ["reach:", "reflect:factory:"].some((p) => keyed(key, p, id)) ||
        ITEM_KV_PREFIXES.some((p) => keyed(key, p, item.id)),
    );
  assert.deepEqual(inherited, []);
});

test("move refuses a tree that does not load and a failed clone, and moves nothing", async (t) => {
  const { dataDir, harborDir, call, clone } = await setup(t);
  const checkout = join(dataDir, "checkouts", "acme", "harbor");

  clone.fail = true;
  const failed = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "factory",
  });
  assert.equal(failed.status, 502);
  assert.equal(failed.body.error.code, "github");
  assert.match(failed.body.error.message, /Could not resolve host/);
  clone.fail = false;

  // The running definition is valid; the files on disk no longer load.
  await writeFile(join(harborDir, "factory.yaml"), "kind: [unclosed\n");
  const broken = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "factory",
  });
  assert.equal(broken.status, 409);
  assert.equal(broken.body.error.code, "policy");
  assert.match(broken.body.error.message, /does not load/);
  assert.equal(broken.body.error.problems[0].path, "factory.yaml");
  assert.equal(await exists(join(checkout, "factory")), false);
  assert.ok(await exists(join(harborDir, "factory.yaml")));
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.definition.mode,
    "managed",
  );
});

test("move then adopt round-trips the files and continues the history from the archive", async (t) => {
  const { dataDir, store, harborDir, harbor, call } = await setup(t);
  const recorded = () => store.repos.factories.factory("harbor")?.archive_dir;
  const target = join(dataDir, "checkouts", "acme", "harbor", "ops", "factory");
  await call("POST", "f/harbor/agents", {
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });
  const moved = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "ops/factory",
  });
  assert.equal(moved.status, 200);
  const archive = moved.body.archive;
  // The move records its archive on the factory.
  assert.equal(recorded(), archive);
  assert.equal(harbor.record?.archive_dir, archive);
  // Edited in the repository while it ran from there, next to other files.
  await call("POST", "f/harbor/agents", {
    name: "second",
    type: "CUSTOM",
    description: null,
    prompt: "Second.",
  });
  await writeFile(join(target, "README.md"), "Not the definition.\n");
  assert.equal((await call("GET", "f/harbor/definition")).body.mode, "repo");

  const adopted = await call("POST", "f/harbor/definition/adopt");
  assert.deepEqual(adopted, {
    status: 200,
    body: {
      dir: harborDir,
      history: archive,
      note: `The history continues from ${archive}.`,
    },
  });
  // Restored, the archive is no longer recorded; it stays on disk.
  assert.equal(recorded(), null);
  assert.ok(await exists(join(archive, ".git")));
  // The files the loader reads round-trip; the rest of the folder stays out.
  const files = async (dir: string) =>
    (await readdir(dir, { recursive: true, withFileTypes: true }))
      .filter((e) => e.isFile() && !e.parentPath.includes(".git"))
      .map((e) => join(e.parentPath, e.name).slice(dir.length))
      .sort();
  assert.deepEqual(
    await files(harborDir),
    (await files(target)).filter(
      (f) => !["/README.md", "/LICENSE.warp-examples"].includes(f),
    ),
  );
  assert.equal(
    await readFile(join(harborDir, "agents", "second", "agent.md"), "utf8"),
    await readFile(join(target, "agents", "second", "agent.md"), "utf8"),
  );
  // The history continues from the archive.
  assert.deepEqual(
    (await definitionHistory(harborDir)).map((c) => c.message),
    [
      "Adopt definition from acme/harbor:ops/factory",
      "Create agent helper",
      "Initial definition",
    ],
  );
  const { stdout } = await exec("git", ["status", "--porcelain"], {
    cwd: harborDir,
  });
  assert.equal(stdout, "");
  // The repository folder is left as it is.
  assert.ok(await exists(join(target, "README.md")));
  assert.ok(await exists(join(target, "factory.yaml")));
  assert.equal(harbor.config.definitionDir, harborDir);
  assert.ok(harbor.definition?.agents.has("second"));
  const settings = await call("GET", "f/harbor/settings");
  assert.equal(settings.body.definition.mode, "managed");
  assert.equal(settings.body.definition.dir, harborDir);
  assert.equal((await call("GET", "f/harbor/definition")).body.mode, "managed");
  // Web edits commit again, and a managed definition is not adopted twice.
  await call("POST", "f/harbor/agents", {
    name: "third",
    type: "CUSTOM",
    description: null,
    prompt: "Third.",
  });
  assert.equal(
    (await definitionHistory(harborDir))[0]?.message,
    "Create agent third",
  );
  assert.equal(await exists(join(target, "agents", "third")), false);
  const again = await call("POST", "f/harbor/definition/adopt");
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already Nakara-managed/);
});

test("adopt without an archive starts a history", async (t) => {
  const { dataDir, registry, call } = await setup(t);
  const managed = join(dataDir, "factories", "default");
  const adopted = await call("POST", "f/default/definition/adopt");
  assert.deepEqual(adopted, {
    status: 200,
    body: {
      dir: managed,
      history: null,
      note: "No archive is recorded for this factory, so a new history starts. An archive left by a move made before Nakara recorded archives is not attached.",
    },
  });
  assert.deepEqual(
    (await definitionHistory(managed)).map((c) => c.message),
    ["Initial definition"],
  );
  assert.equal(registry.default.config.definitionDir, managed);
  assert.ok(await exists(join(dataDir, "default", "factory.yaml")));
});

test("a new factory that reuses a deleted factory's slug does not continue its history", async (t) => {
  const { dataDir, store, registry, harborDir, call } = await setup(t);
  const target = join(dataDir, "checkouts", "acme", "harbor", "factory");
  await call("POST", "f/harbor/agents", {
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });
  const moved = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "factory",
  });
  assert.equal(moved.status, 200);
  const archive = moved.body.archive;
  // Deleting a repository-kept factory leaves its archive behind.
  assert.equal((await call("DELETE", "f/harbor")).status, 200);
  assert.deepEqual(
    (await definitionHistory(archive)).map((c) => c.message),
    ["Create agent helper", "Initial definition"],
  );

  // A new Harbor, kept in the same repository folder.
  const record = store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "harbor",
    name: "Harbor",
    avatar_color: "#0e7490",
    foreman_handle: "harbor",
    definition_dir: target,
    definition_mode: "repo",
  });
  const again = await registry.register(record);
  again.pump = async () => {};
  assert.ok((await again.reloadDefinition()).ok);

  const adopted = await call("POST", "f/harbor/definition/adopt");
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.dir, harborDir);
  assert.equal(adopted.body.history, null);
  assert.match(adopted.body.note, /No archive is recorded/);
  // A fresh history: the deleted factory's commits are not attached.
  assert.deepEqual(
    (await definitionHistory(harborDir)).map((c) => c.message),
    ["Initial definition"],
  );
  // The old archive is left as it is.
  assert.deepEqual(
    (await definitionHistory(archive)).map((c) => c.message),
    ["Create agent helper", "Initial definition"],
  );
});

test("a move whose archive failed leaves the history in place, and adopt continues it", async (t) => {
  const { dataDir, store, harborDir, call } = await setup(t);
  await call("POST", "f/harbor/agents", {
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });
  // The archive folder cannot be created.
  await writeFile(join(dataDir, "archive"), "");
  const moved = await call("POST", "f/harbor/definition/move", {
    repo: "acme/harbor",
    folder: "factory",
  });
  assert.equal(moved.status, 200);
  assert.equal(moved.body.archive, null);
  // The factory's own managed folder, with its history, is what is recorded.
  assert.equal(store.repos.factories.factory("harbor")?.archive_dir, harborDir);

  const adopted = await call("POST", "f/harbor/definition/adopt");
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.history, harborDir);
  assert.deepEqual(
    (await definitionHistory(harborDir)).map((c) => c.message),
    [
      "Adopt definition from acme/harbor:factory",
      "Create agent helper",
      "Initial definition",
    ],
  );
  assert.deepEqual((await readdir(join(dataDir, "factories"))).sort(), [
    "harbor",
  ]);
});

test("adopt is refused while a run is in progress and for a definition that does not load", async (t) => {
  const { dataDir, store, registry, call } = await setup(t);
  const defaultDir = join(dataDir, "default");
  const managed = join(dataDir, "factories", "default");
  const unchanged = async () => {
    assert.equal(
      (await call("GET", "f/default/settings")).body.definition.mode,
      "repo",
    );
    assert.equal(registry.default.config.definitionDir, defaultDir);
    assert.deepEqual(await readdir(join(dataDir, "factories")), ["harbor"]);
    assert.ok(await exists(join(defaultDir, "factory.yaml")));
  };

  const { run } = closedItemWithRun(
    store,
    registry.default.record?.id,
    "queued",
  );
  const busy = await call("POST", "f/default/definition/adopt");
  assert.equal(busy.status, 409);
  assert.equal(busy.body.error.code, "policy");
  assert.match(busy.body.error.message, /1 run in progress/);
  await unchanged();
  store.db
    .prepare("UPDATE runs SET status = 'succeeded' WHERE id = ?")
    .run(run.id);

  // The running definition is valid; the files in the folder no longer load.
  await writeFile(join(defaultDir, "factory.yaml"), "kind: [unclosed\n");
  const broken = await call("POST", "f/default/definition/adopt");
  assert.equal(broken.status, 409);
  assert.equal(broken.body.error.code, "policy");
  assert.match(broken.body.error.message, /does not load/);
  assert.equal(broken.body.error.problems[0].path, "factory.yaml");
  await unchanged();
  assert.equal(await exists(managed), false);
});

test("the factory description: saved through the API, committed once in a managed definition, refused when stale or too long", async (t) => {
  const { harborDir, harbor, call } = await setup(t);
  const yaml = join(harborDir, "factory.yaml");
  const before = (await call("GET", "f/harbor/settings")).body.factoryFile;
  assert.equal(before.revision, fileRevision(await readFile(yaml)));

  const saved = await call("PUT", "f/harbor/settings/definition", {
    revision: before.revision,
    description: "  Ships the harbor.  ",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  assert.equal(saved.body.revision, fileRevision(await readFile(yaml)));
  assert.equal(harbor.definition?.factory.description, "Ships the harbor.");
  assert.deepEqual((await call("GET", "f/harbor/settings")).body.factoryFile, {
    ...before,
    description: "Ships the harbor.",
    revision: saved.body.revision,
  });
  assert.equal(
    (await call("GET", "factories")).body.find(
      (f: { slug: string }) => f.slug === "harbor",
    ).description,
    "Ships the harbor.",
  );
  // One commit, and nothing left uncommitted.
  assert.deepEqual(
    (await definitionHistory(harborDir)).map((c) => c.message),
    ["Edit factory settings", "Initial definition"],
  );
  const { stdout } = await exec("git", ["status", "--porcelain"], {
    cwd: harborDir,
  });
  assert.equal(stdout, "");

  // The revision the page loaded before the save is stale now.
  const stale = await call("PUT", "f/harbor/settings/definition", {
    revision: before.revision,
    description: "Late.",
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "conflict");

  for (const json of [
    { revision: saved.body.revision, description: "x".repeat(501) },
    { revision: "nope", description: "Fine." },
    { revision: saved.body.revision },
  ]) {
    const refused = await call("PUT", "f/harbor/settings/definition", json);
    assert.equal(refused.status, 400, JSON.stringify(json).slice(0, 80));
    assert.equal(refused.body.error.code, "invalid_input");
  }

  // A factory.yaml broken on disk cannot be saved into a loadable tree.
  const text = await readFile(yaml, "utf8");
  await writeFile(yaml, text.replace(/^schemaVersion: .*\n/m, ""));
  const invalid = await call("PUT", "f/harbor/settings/definition", {
    revision: fileRevision(await readFile(yaml)),
    description: "Anything.",
  });
  assert.equal(invalid.status, 422);
  assert.equal(invalid.body.error.code, "invalid_definition");
  assert.ok(invalid.body.error.problems.length > 0);
  await writeFile(yaml, text);

  // Empty removes the key.
  const cleared = await call("PUT", "f/harbor/settings/definition", {
    revision: fileRevision(await readFile(yaml)),
    description: "",
  });
  assert.equal(cleared.status, 200);
  assert.doesNotMatch(await readFile(yaml, "utf8"), /^description:/m);
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.factoryFile.description,
    null,
  );
  assert.equal((await definitionHistory(harborDir)).length, 3);
});

test("the factory description in a repository definition is an uncommitted change", async (t) => {
  const { dataDir, store, call } = await setup(t);
  const repo = join(dataDir, "default");
  for (const args of [
    ["init", "--quiet"],
    ["add", "--all"],
    ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "Initial"],
  ])
    await exec("git", args, { cwd: repo });
  const slug = store.repos.factories.defaultFactory().slug;
  const { factoryFile } = (await call("GET", `f/${slug}/settings`)).body;
  const saved = await call("PUT", `f/${slug}/settings/definition`, {
    revision: factoryFile.revision,
    description: "The default factory.",
  });
  assert.equal(saved.status, 200);
  const status = await exec("git", ["status", "--porcelain"], { cwd: repo });
  assert.equal(status.stdout, " M factory.yaml\n");
  const log = await exec("git", ["rev-list", "--count", "HEAD"], {
    cwd: repo,
  });
  assert.equal(log.stdout.trim(), "1");
});

test("agent defaults: saved through Settings, shown for agents without their own, refused when unknown, and a move to the host waits for approval", async (t) => {
  const { harborDir, harbor, call } = await setup(t);
  const yaml = join(harborDir, "factory.yaml");
  const settings = async () => (await call("GET", "f/harbor/settings")).body;
  const before = await settings();
  assert.deepEqual(before.factoryFile.agentDefaults, {
    harness: "claude",
    model: "sonnet",
    effort: null,
    runner: "docker",
    idleTimeoutMinutes: null,
  });
  assert.deepEqual(
    before.runners.map((r: { name: string; sandbox: boolean }) => [
      r.name,
      r.sandbox,
    ]),
    [
      ["docker-browser", true],
      ["docker", true],
      ["local", false],
    ],
  );
  // An agent of its own settings only: it takes whatever agentDefaults says.
  assert.equal(
    (
      await call("POST", "f/harbor/agents", {
        name: "helper",
        type: "CUSTOM",
        description: null,
        prompt: "Help.",
      })
    ).status,
    201,
  );
  const helper = async () =>
    (await call("GET", "f/harbor/agents")).body.find(
      (a: { name: string }) => a.name === "helper",
    );
  assert.deepEqual(
    [(await helper()).harness, (await helper()).model],
    ["claude", "sonnet"],
  );

  const saved = await call("PUT", "f/harbor/settings/definition", {
    revision: before.factoryFile.revision,
    agentDefaults: {
      harness: "claude",
      model: "opus",
      effort: null,
      idleTimeoutMinutes: 20,
    },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ok, true);
  // The description stays; the Agents page shows the new default after the reload.
  const after = await settings();
  assert.equal(after.factoryFile.description, before.factoryFile.description);
  assert.equal(after.factoryFile.revision, saved.body.revision);
  assert.equal(after.factoryFile.agentDefaults.model, "opus");
  assert.deepEqual(
    [(await helper()).harness, (await helper()).model],
    ["claude", "opus"],
  );
  assert.equal(harbor.definition?.agents.get("helper")?.idleTimeoutMinutes, 20);
  const agent = (await call("GET", "f/harbor/agents/helper")).body;
  assert.equal(agent.defaults.model, "opus");
  assert.equal(agent.defaults.idleTimeoutMinutes, 20);

  // An unknown harness, runner or model, or a timeout out of range: problems, nothing written.
  const text = await readFile(yaml, "utf8");
  for (const [agentDefaults, message] of [
    [{ harness: "gemini", model: null }, /harness\.type/],
    [
      { harness: "claude", model: "opus-9" },
      /"opus-9" is not a model claude offers \(opus, sonnet\)/,
    ],
    [{ harness: null, model: "gpt-5.5" }, /not a model claude offers/],
    [{ runner: "missing" }, /runner "missing" is not defined/],
    [{ idleTimeoutMinutes: 90 }, /idleTimeoutMinutes/],
  ] as const) {
    const refused = await call("PUT", "f/harbor/settings/definition", {
      revision: saved.body.revision,
      agentDefaults,
    });
    assert.equal(refused.status, 422, JSON.stringify(agentDefaults));
    assert.equal(refused.body.error.code, "invalid_definition");
    assert.match(
      refused.body.error.problems
        .map((p: { message: string }) => p.message)
        .join("\n"),
      message,
    );
  }
  // Codex cannot list its models here: the model is not saved unchecked.
  const offline = await call("PUT", "f/harbor/settings/definition", {
    revision: saved.body.revision,
    agentDefaults: { harness: "codex", model: "gpt-5.5" },
  });
  assert.equal(offline.status, 503);
  assert.equal(offline.body.error.code, "unavailable");
  assert.match(
    offline.body.error.message,
    /codex model list could not be loaded/,
  );
  assert.equal(await readFile(yaml, "utf8"), text);

  // To the host: written, but the running definition keeps the container until approved.
  const host = await call("PUT", "f/harbor/settings/definition", {
    revision: saved.body.revision,
    agentDefaults: { runner: "local" },
  });
  assert.equal(host.status, 200);
  assert.equal(host.body.ok, false);
  assert.match(host.body.errors[0].message, /waits for your approval/);
  assert.match(await readFile(yaml, "utf8"), /^ {2}runner: local$/m);
  assert.equal(harbor.definition?.agents.get("helper")?.runner, "docker");
  const pending = (await call("GET", "f/harbor/definition")).body.pendingReach;
  assert.ok(pending.includes("helper · runner host"), pending.join("\n"));
  // Settings shows what waits, until the Operator decides.
  assert.deepEqual((await settings()).pendingReach, pending);
  const approved = await call("POST", "f/harbor/definition/reach/approve");
  assert.equal(approved.body.ok, true);
  assert.equal(harbor.definition?.agents.get("helper")?.runner, "local");
  assert.equal((await settings()).pendingReach, null);
});

test("where work comes from: manual intake, then only the GitHub, Telegram and Slack automations", async (t) => {
  const { harborDir, harbor, call } = await setup(t);
  for (const name of ["slack-request", "telegram-request"])
    await rm(join(harborDir, "automations", name), { recursive: true });
  assert.ok((await harbor.reloadDefinition()).ok);
  const revision = fileRevision(
    await readFile(
      join(harborDir, "automations", "issue-labeled", "automation.md"),
    ),
  );
  // weekly-health-check, a schedule automation, is not intake.
  assert.deepEqual((await call("GET", "f/harbor/settings")).body.intake, [
    {
      automation: null,
      displayName: "Manual",
      provider: "nakara",
      event: "manual",
      enabled: true,
      detail: null,
      revision: null,
    },
    {
      automation: "issue-labeled",
      displayName: "issue-labeled",
      provider: "github",
      event: "issue_labeled",
      enabled: true,
      detail: harbor.definition?.label,
      revision,
    },
  ]);
});

test("where work comes from: the bundled Telegram and Slack automations, and a switch saved on either page shows on both", async (t) => {
  const { harbor, call } = await setup(t);
  const intake = async () =>
    (await call("GET", "f/harbor/settings")).body.intake as {
      automation: string | null;
      detail: string | null;
      enabled: boolean;
      revision: string | null;
    }[];
  const entry = async (name: string) =>
    (await intake()).find((e) => e.automation === name);
  const automation = async (name: string) =>
    (await call("GET", "f/harbor/automations")).body.find(
      (a: { name: string }) => a.name === name,
    );
  assert.deepEqual(
    (await intake()).map((e) => [e.automation, e.detail]),
    [
      [null, null],
      ["issue-labeled", harbor.definition?.label],
      ["slack-request", "1 trusted member"],
      ["telegram-request", "messages"],
    ],
  );

  // Off from Settings: the same endpoint and revision as the Automations page.
  const before = await entry("telegram-request");
  assert.equal(before?.enabled, false);
  assert.equal(
    before?.revision,
    (await automation("telegram-request")).revision,
  );
  const on = await call("PUT", "f/harbor/automations/telegram-request", {
    enabled: true,
    revision: before?.revision,
  });
  assert.equal(on.status, 200);
  assert.equal((await entry("telegram-request"))?.enabled, true);
  assert.equal((await automation("telegram-request")).enabled, true);

  // From the Automations page with its own revision: Settings follows.
  const off = await call("PUT", "f/harbor/automations/issue-labeled", {
    enabled: false,
    revision: (await automation("issue-labeled")).revision,
  });
  assert.equal(off.status, 200);
  const after = await entry("issue-labeled");
  assert.equal(after?.enabled, false);
  assert.equal(after?.revision, off.body.revision);
  assert.equal((await automation("issue-labeled")).enabled, false);

  // A stale revision is refused, as on the Automations page.
  const stale = await call("PUT", "f/harbor/automations/telegram-request", {
    enabled: false,
    revision: before?.revision,
  });
  assert.equal(stale.status, 409);
  assert.equal((await entry("telegram-request"))?.enabled, true);
});

test("where work comes from: a GitHub pull request trigger is not intake, so there is still no GitHub intake", async (t) => {
  const { harborDir, harbor, call } = await setup(t);
  for (const name of ["issue-labeled", "slack-request", "telegram-request"])
    await rm(join(harborDir, "automations", name), { recursive: true });
  // Lifecycle notifications for factory PRs, not a way work comes in.
  await mkdir(join(harborDir, "automations", "pr-merged"));
  await writeFile(
    join(harborDir, "automations", "pr-merged", "automation.md"),
    "---\ntriggers:\n  - provider: github\n    event: pull_request_merged\n  - provider: github\n    event: pull_request_closed\n---\nA factory PR closed.\n",
  );
  assert.ok((await harbor.reloadDefinition()).ok);
  assert.ok(harbor.definition?.automations.some((a) => a.name === "pr-merged"));
  const { intake } = (await call("GET", "f/harbor/settings")).body;
  assert.deepEqual(
    intake.map((e: { provider: string; event: string }) => [
      e.provider,
      e.event,
    ]),
    [["nakara", "manual"]],
  );
  assert.equal(
    intake.some((e: { provider: string }) => e.provider === "github"),
    false,
  );
});

test("repositories: added after the ownership and access checks, waiting for approval, and removed unless active items target it or it is the last", async (t) => {
  const { harborDir, store, registry, harbor, call, denied } = await setup(t);
  const probed: string[] = [];
  harbor.probeRepository = async (_dir, owner, name) => {
    probed.push(`${owner}/${name}`);
    return { defaultBranch: "main" };
  };
  const yaml = join(harborDir, "factory.yaml");
  const settings = async () => (await call("GET", "f/harbor/settings")).body;
  const revision = async () => (await settings()).factoryFile.revision;
  const put = async (repositories: unknown) =>
    call("PUT", "f/harbor/settings/definition", {
      revision: await revision(),
      repositories,
    });
  const problems = (refused: {
    body: { error: { problems: { message: string }[] } };
  }) => refused.body.error.problems.map((p) => p.message).join("\n");
  assert.deepEqual((await settings()).factoryFile.repositories, [
    "acme/harbor",
  ]);
  const text = await readFile(yaml, "utf8");

  // Owned by the default factory: a 422 naming it, nothing written.
  const owner = registry.default.record?.name;
  const owned = await put({
    add: [{ owner: "alwisofwan1", name: "Nakara" }],
  });
  assert.equal(owned.status, 422);
  assert.equal(owned.body.error.code, "invalid_definition");
  assert.match(
    problems(owned),
    new RegExp(`alwisofwan1/Nakara is already owned by the factory "${owner}"`),
  );
  // The agent token cannot reach it: refused before anything is written.
  denied.add("acme/secret");
  const unreachable = await put({ add: [{ owner: "acme", name: "secret" }] });
  assert.equal(unreachable.status, 422);
  assert.match(problems(unreachable), /Nakara cannot reach acme\/secret/);
  // A malformed repository is a 400.
  assert.equal(
    (await put({ add: [{ owner: "acme corp", name: "docs" }] })).status,
    400,
  );
  assert.equal(await readFile(yaml, "utf8"), text);

  // Added: written, but it widens reach, so the running definition waits for approval.
  const added = await put({ add: [{ owner: "acme", name: "docs" }] });
  assert.equal(added.status, 200);
  assert.equal(added.body.ok, false);
  assert.match(added.body.errors[0].message, /waits for your approval/);
  assert.deepEqual((await settings()).factoryFile.repositories, [
    "acme/harbor",
    "acme/docs",
  ]);
  assert.deepEqual((await settings()).pendingReach, ["repository acme/docs"]);
  assert.deepEqual(
    harbor.definition?.factory.repositories.map((r) => r.name),
    ["harbor"],
  );
  assert.equal(
    (await call("POST", "f/harbor/definition/reach/approve")).body.ok,
    true,
  );
  assert.deepEqual(
    harbor.definition?.factory.repositories.map((r) => r.name),
    ["harbor", "docs"],
  );
  assert.equal((await settings()).pendingReach, null);
  // Approved, it is cloned with the others.
  await harbor.checkRepositories();
  assert.ok(probed.includes("acme/docs"), probed.join());

  // An active item targeting acme/harbor (in GitHub's other spelling) blocks its removal.
  const harborId = harbor.record?.id ?? 0;
  const item = store.createItem({
    title: "Fix",
    request: "Fix",
    source: "manual",
    repo: "ACME/harbor",
    factoryId: harborId,
  });
  // Another factory's item and a closed one do not count.
  store.createItem({
    title: "Other",
    request: "Other",
    source: "manual",
    repo: "acme/harbor",
    factoryId: registry.default.record?.id ?? 0,
  });
  const done = store.createItem({
    title: "Done",
    request: "Done",
    source: "manual",
    repo: "acme/harbor",
    factoryId: harborId,
  });
  store.updateItem(done.id, { stage: "complete" });
  const busy = await put({ remove: ["acme/harbor"] });
  assert.equal(busy.status, 422);
  assert.match(
    problems(busy),
    /1 active Work Item targets acme\/harbor\. Complete or cancel it first\./,
  );
  store.updateItem(item.id, { stage: "cancelled" });

  // Removing narrows reach: applied at once.
  const removed = await put({ remove: ["acme/harbor"] });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.ok, true);
  assert.deepEqual(
    harbor.definition?.factory.repositories.map((r) => r.name),
    ["docs"],
  );
  // The last repository stays.
  const last = await put({ remove: ["acme/docs"] });
  assert.equal(last.status, 422);
  assert.match(problems(last), /at least one repository/);
  assert.deepEqual((await settings()).factoryFile.repositories, ["acme/docs"]);
});

test("notifications: the Slack channel and switches, on when unsaved; a #name is saved as its channel ID", async (t) => {
  const resolved: string[] = [];
  const { store, harbor, call } = await setup(t, {
    resolveChannel: async (channel) => {
      resolved.push(channel);
      return channel === "#releases" ? "C0RELEASES" : channel;
    },
  });
  const harborId = harbor.record?.id ?? 0;
  const before = await call("GET", "f/harbor/settings");
  assert.deepEqual(before.body.notifications, {
    slackChannel: null,
    notify: { approvals: true, handoff: true, paused: true },
    slackConnected: true,
  });

  const saved = await call("PUT", "f/harbor/settings/notifications", {
    slackChannel: " #releases ",
    handoff: false,
  });
  assert.deepEqual(saved, {
    status: 200,
    body: {
      slackChannel: "C0RELEASES",
      notify: { approvals: true, handoff: false, paused: true },
    },
  });
  assert.deepEqual(resolved, ["#releases"]);
  // An unknown name is stored as given.
  const unknown = await call("PUT", "f/harbor/settings/notifications", {
    slackChannel: "#nowhere",
  });
  assert.equal(unknown.body.slackChannel, "#nowhere");
  // An omitted key stays; null turns a switch back on, "" clears the channel.
  const reset = await call("PUT", "f/harbor/settings/notifications", {
    slackChannel: "",
    handoff: null,
    paused: false,
  });
  assert.deepEqual(reset.body, {
    slackChannel: null,
    notify: { approvals: true, handoff: true, paused: false },
  });
  assert.deepEqual(
    store.repos.factorySettings.notifications(harborId),
    reset.body,
  );
  // Another factory keeps its own.
  assert.equal(
    store.repos.factorySettings.notifications(
      store.repos.factories.defaultFactory().id,
    ).notify.paused,
    true,
  );
  const invalid = await call("PUT", "f/harbor/settings/notifications", {
    slackChannel: "#no spaces",
  });
  assert.equal(invalid.status, 400);
});

test("notifications: without the Slack bridge the channel is saved as given and Settings says Slack is not connected", async (t) => {
  const { call } = await setup(t);
  assert.equal(
    (await call("GET", "f/harbor/settings")).body.notifications.slackConnected,
    false,
  );
  const saved = await call("PUT", "f/harbor/settings/notifications", {
    slackChannel: "#releases",
  });
  assert.equal(saved.body.slackChannel, "#releases");
});
