import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { HttpBindings } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { Store, stubFactorySeed } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { Factory } from "../orchestrator/factory.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { checkRepositories } from "../runner/repos.ts";
import type { CheckResultDto, DefinitionDto } from "./definition.ts";
import { definitionFiles, readDefinition } from "./definition.ts";
import { createApp } from "./test-support.ts";

const BUNDLED = join(import.meta.dirname, "../../factory");
const bindings = { incoming: { socket: { remoteAddress: "127.0.0.1" } } };

async function fixture(t: { after: (fn: () => unknown) => void }) {
  const dir = await mkdtemp(join(tmpdir(), "nakara-definition-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(BUNDLED, join(dir, "factory"), { recursive: true });
  const config = loadConfig({
    NAKARA_DEFINITION_DIR: join(dir, "factory"),
    NAKARA_DATA_DIR: join(dir, "data"),
  });
  const store = new Store(":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({
      ...stubFactorySeed(),
      definition_dir: join(dir, "factory"),
    }),
  });
  t.after(() => store.db.close());
  const registry = new FactoryRegistry(store, config);
  const factory = registry.default;
  const probes: string[] = [];
  factory.probeRepository = async (_cache, owner, name) => {
    probes.push(`${owner}/${name}`);
    return { defaultBranch: "main" };
  };
  assert.ok((await factory.reloadDefinition()).ok);
  const app = createApp(registry, new GithubPoller(factory), config, "token");
  const call = async <T>(path: string, method = "GET") =>
    (await (
      await app.request(
        `http://localhost/api/f/default${path}`,
        { method },
        bindings as HttpBindings,
      )
    ).json()) as T;
  return { dir: config.definitionDir, store, factory, call, probes };
}

test("read model projects repositories, defaults, MCP servers and a file tree with errors", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const config = loadConfig({ NAKARA_DEFINITION_DIR: BUNDLED });
  const factory = new Factory(store, config);
  await factory.reloadDefinition();
  const def = factory.definition;
  assert.ok(def);
  def.factory.mcpServers = {
    github: {
      command: "npx",
      args: ["server-github", "--token=secret"],
      env: { TOKEN: "secret" },
    },
    docs: {
      url: "https://user:secret@mcp.example/v1?key=secret#secret",
      headers: { auth: "secret" },
    },
    broken: { url: "not a url secret" },
  };
  def.factory.repositories.push({ owner: "o", name: "later", deferred: true });
  await checkRepositories(store, def, "/unused", async (_c, _o, name) => {
    if (name === "nakara")
      throw Object.assign(new Error("Command failed"), {
        cmd: "gh repo clone alwisofwan1/nakara",
        stderr:
          "GraphQL: Could not resolve to a Repository with the name 'alwisofwan1/nakara'. (repository)\n",
      });
    return { defaultBranch: "trunk" };
  });
  const dto = readDefinition(store, {
    dir: BUNDLED,
    definition: def,
    problems: {
      errors: [
        { path: "agents/implement/agent.md", line: 3, message: "bad" },
        { path: "agents/", message: "exactly one foreman" },
      ],
      warnings: [],
    },
    files: await definitionFiles(BUNDLED),
  });
  assert.deepEqual(dto.running, {
    name: "nakara-default",
    label: "factory:Nakara",
    schemaVersion: "v1alpha1",
    loadedAt: def.loadedAt,
  });
  assert.deepEqual(dto.errors, [
    { path: "agents/implement/agent.md", line: 3, message: "bad" },
    { path: "agents/", line: null, message: "exactly one foreman" },
  ]);
  const [sandbox, nakara, later] = dto.repositories;
  assert.equal(sandbox?.state, "cloned");
  assert.equal(sandbox?.defaultBranch, "trunk");
  assert.ok(sandbox?.fetchedAt);
  assert.deepEqual(nakara && { ...nakara }, {
    slug: "alwisofwan1/nakara",
    state: "error",
    defaultBranch: null,
    fetchedAt: null,
    error:
      "gh: GraphQL: Could not resolve to a Repository with the name 'alwisofwan1/nakara'. (repository)",
  });
  assert.equal(later?.state, "deferred");
  assert.deepEqual(dto.agentDefaults, [
    { key: "harness", value: "claude" },
    { key: "model", value: "sonnet" },
    {
      key: "runner",
      value: `docker (${def.runners.get("docker")?.platform?.linux?.dockerImage})`,
    },
  ]);
  assert.deepEqual(dto.mcpServers, [
    { name: "github", kind: "command", target: "npx …" },
    { name: "docs", kind: "url", target: "https://mcp.example/v1" },
    { name: "broken", kind: "url", target: "(invalid URL)" },
  ]);
  assert.ok(!JSON.stringify(dto).includes("secret"));
  assert.deepEqual(dto.files[0], {
    path: "LICENSE.warp-examples",
    label: "LICENSE.warp-examples",
    kind: "file",
    depth: 0,
    error: false,
  });
  assert.deepEqual(
    dto.files.filter((f) => f.error).map((f) => [f.path, f.label, f.depth]),
    [
      ["agents/", "agents/", 0],
      ["agents/implement/agent.md", "implement/agent.md", 1],
    ],
  );
  assert.ok(dto.files.some((f) => f.path === "factory.yaml"));
  store.db.close();
});

test("an access failure after a fetch keeps the last fetch time", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_DEFINITION_DIR: BUNDLED }),
  );
  await factory.reloadDefinition();
  const def = factory.definition;
  assert.ok(def);
  def.factory.repositories = [{ owner: "o", name: "r" }];
  await checkRepositories(store, def, "/unused", async () => ({
    defaultBranch: "main",
  }));
  const fetched = readDefinition(store, {
    dir: BUNDLED,
    definition: def,
    problems: { errors: [], warnings: [] },
    files: [],
  }).repositories[0];
  await checkRepositories(store, def, "/unused", async () => {
    throw new Error("network down");
  });
  const repo = readDefinition(store, {
    dir: BUNDLED,
    definition: def,
    problems: { errors: [], warnings: [] },
    files: [],
  }).repositories[0];
  assert.equal(repo?.state, "error");
  assert.equal(repo?.error, "network down");
  assert.equal(repo?.fetchedAt, fetched?.fetchedAt);
  assert.equal(repo?.defaultBranch, "main");
  store.db.close();
});

test("an invalid edit on disk: validate reports it without applying, reload keeps the last valid definition", async (t) => {
  const { dir, factory, call, probes } = await fixture(t);
  const running = factory.definition;
  const path = join(dir, "automations/weekly-health-check/automation.md");
  const original = await readFile(path, "utf8");
  await writeFile(path, original.replace('"0 2 * * 1"', '"0 2 * * 8"'));

  const validated = await call<CheckResultDto>("/definition/validate", "POST");
  assert.equal(validated.ok, false);
  assert.deepEqual(
    validated.errors.map((e) => [e.path, e.line]),
    [["automations/weekly-health-check/automation.md", 8]],
  );
  assert.equal(factory.definition, running);
  assert.deepEqual(factory.definitionProblems.errors, []);
  assert.deepEqual((await call<DefinitionDto>("/definition")).errors, []);

  const reloaded = await call<CheckResultDto>("/definition/reload", "POST");
  assert.equal(reloaded.ok, false);
  assert.equal(factory.definition, running);
  const page = await call<DefinitionDto>("/definition");
  assert.equal(page.running?.loadedAt, running?.loadedAt);
  assert.deepEqual(page.errors, validated.errors);
  assert.ok(
    page.files.find(
      (f) => f.path === "automations/weekly-health-check/automation.md",
    )?.error,
  );
  assert.deepEqual(probes, []);

  await writeFile(path, original);
  assert.equal(
    (await call<CheckResultDto>("/definition/reload", "POST")).ok,
    true,
  );
  assert.notEqual(factory.definition, running);
  assert.deepEqual((await call<DefinitionDto>("/definition")).errors, []);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(probes, [
    "alwisofwan1/nakara-sandbox",
    "alwisofwan1/nakara",
  ]);
});

test("validate never changes the running definition, even when the files on disk are valid", async (t) => {
  const { dir, factory, call, store } = await fixture(t);
  const running = factory.definition;
  const events: unknown[] = [];
  await new Promise((resolve) => setImmediate(resolve));
  store.changes.on("change", (event) => events.push(event));
  const path = join(dir, "factory.yaml");
  await writeFile(
    path,
    (await readFile(path, "utf8")).replace(
      "name: nakara-default",
      "name: renamed",
    ),
  );
  assert.deepEqual(await call<CheckResultDto>("/definition/validate", "POST"), {
    ok: true,
    errors: [],
    warnings: factory.definitionProblems.warnings.map((w) => ({
      path: w.path,
      line: w.line ?? null,
      message: w.message,
    })),
  });
  assert.equal(factory.definition, running);
  assert.equal(
    (await call<DefinitionDto>("/definition")).running?.name,
    "nakara-default",
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, []);
  await call("/definition/reload", "POST");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await call<DefinitionDto>("/definition")).running?.name,
    "renamed",
  );
  assert.ok(events.some((e) => (e as { type: string }).type === "definition"));
});

test("a repository the agent token cannot access records the gh error", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-gh-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
console.error("GraphQL: Could not resolve to a Repository with the name '" + process.argv[4] + "'. (repository)");
process.exit(1);
`,
    { mode: 0o755 },
  );
  const oldPath = process.env.PATH;
  process.env.PATH = `${dir}:${oldPath}`;
  t.after(() => {
    process.env.PATH = oldPath;
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({
      NAKARA_DEFINITION_DIR: BUNDLED,
      NAKARA_DATA_DIR: join(dir, "data"),
    }),
  );
  await factory.reloadDefinition();
  assert.ok(factory.definition);
  factory.definition.factory.repositories = [{ owner: "o", name: "private" }];
  await factory.checkRepositories();
  const [repo] = readDefinition(store, {
    dir: BUNDLED,
    definition: factory.definition,
    problems: factory.definitionProblems,
    files: [],
  }).repositories;
  assert.equal(repo?.state, "error");
  assert.equal(
    repo?.error,
    "gh: GraphQL: Could not resolve to a Repository with the name 'o/private'. (repository)",
  );
  store.db.close();
});

test("a repository check requested during a running one runs again afterwards", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_DEFINITION_DIR: BUNDLED }),
  );
  await factory.reloadDefinition();
  assert.ok(factory.definition);
  factory.definition.factory.repositories = [{ owner: "o", name: "old" }];
  const probed: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  factory.probeRepository = async (_cache, owner, name) => {
    probed.push(`${owner}/${name}`);
    if (name === "old") await gate;
    return { defaultBranch: "main" };
  };
  const first = factory.checkRepositories();
  await new Promise((resolve) => setImmediate(resolve));
  // A reload swaps in a new repository list while the first check is still fetching.
  factory.definition.factory.repositories = [{ owner: "o", name: "new" }];
  const second = factory.checkRepositories();
  release();
  await Promise.all([first, second]);
  assert.deepEqual(probed, ["o/old", "o/new"]);
  await factory.checkRepositories();
  assert.deepEqual(probed, ["o/old", "o/new", "o/new"]);
  store.db.close();
});
