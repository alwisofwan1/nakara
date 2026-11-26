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
import { GithubPoller } from "../intake/github.ts";
import type { Factory } from "../orchestrator/factory.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { readFactorySettings } from "./factories.ts";
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
      limits: {
        budgetUsd: 15,
        maxReviews: 1,
        maxRevisions: 2,
        maxRuns: 50,
        defaults: {
          budgetUsd: 15,
          maxReviews: 1,
          maxRevisions: 2,
          maxRuns: 50,
        },
      },
      paused: false,
      pausedAt: null,
      definition: {
        mode: "managed",
        dir: "/data/factories/harbor",
        repositories: ["acme/widgets"],
        history,
        archiveDir: "/data/archive/factories/harbor",
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
    }),
    undefined,
  );
});

/**
 * A registry of two factories: the default one, kept in a folder, and Harbor,
 * Nakara-managed under the data directory. Both start from the bundled
 * definition; Harbor claims other repositories so both load.
 */
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
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
  const config = loadConfig({
    NAKARA_DATA_DIR: dataDir,
    NAKARA_DEFINITION_DIR: defaultDir,
    NAKARA_GITHUB_MIRROR: "false",
  });
  const store = new Store(":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({ ...stubFactorySeed(), definition_dir: defaultDir }),
  });
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
        return { ok: false, stdout: "", stderr: "unexpected gh call" };
      },
    },
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
  return { dataDir, harborDir, store, registry, harbor, call, cloned, clone };
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
    defaults,
  });
  assert.deepEqual(limitsOf(create(harborId)), [15, 3, 4, 120]);
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
    `tg:approval:${approvalId}`,
    "repo:harbor",
  ];
  for (const key of keys) store.setKv(key, "1");
  // Another factory's keep their state.
  const other = store.repos.factories.defaultFactory().slug;
  store.setKv(`repo:${other}`, "1");
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
  assert.equal(store.getKv(lookalike), "1");
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
