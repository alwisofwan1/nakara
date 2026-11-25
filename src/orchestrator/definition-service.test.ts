import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../config.ts";
import { Store, stubFactorySeed } from "../db.ts";
import { RUNNER_LINE } from "../definition/reach.ts";
import { Factory } from "./factory.ts";

// The smoke server replaces reloadDefinition to reapply its fixture overrides;
// a save must reload through it, as it did before DefinitionService.
test("a definition write reloads through Factory.reloadDefinition", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-definition-service-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "factory");
  await cp("factory", root, { recursive: true });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const factory = new Factory(
    store,
    loadConfig({ NAKARA_DEFINITION_DIR: root, NAKARA_DATA_DIR: dir }),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  const reload = factory.reloadDefinition.bind(factory);
  let reloads = 0;
  factory.reloadDefinition = async () => {
    reloads++;
    return reload();
  };
  const created = await factory.createAgent({
    name: "helper",
    type: "CUSTOM",
    description: null,
    prompt: "Help.",
  });
  assert.equal(created.ok, true);
  assert.equal(reloads, 1);
  assert.ok(factory.definition?.agents.has("helper"));
});

test("a reload that widens what agents reach waits for the operator; narrowing applies at once", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-reach-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = join(dir, "factory");
  await cp("factory", root, { recursive: true });
  // The foreman runs in the runner's container, so its MCP hosts must be reachable.
  const runnerFile = join(root, "runners/docker.yaml");
  await writeFile(
    runnerFile,
    (await readFile(runnerFile, "utf8")).replace(
      "    - api.anthropic.com",
      "    - api.anthropic.com\n    - linear.test\n    - sentry.test",
    ),
  );
  const foreman = join(root, "agents/foreman/agent.md");
  const original = await readFile(foreman, "utf8");
  /** The foreman with these MCP servers, each listing get_issue. */
  const servers = (...names: string[]) =>
    writeFile(
      foreman,
      names.length
        ? original.replace(
            "agentType: FOREMAN\n",
            `agentType: FOREMAN\nmcpServers:\n${names.map((n) => `  ${n}: { url: "https://${n}.test", tools: [get_issue] }\n`).join("")}`,
          )
        : original,
    );
  // On disk and registered, so it keeps a copy of what it applied.
  const store = new Store(join(dir, "nakara.db"), {
    defaultBudgetUsd: 15,
    factory: stubFactorySeed,
  });
  t.after(() => store.close());
  const config = loadConfig({
    NAKARA_DEFINITION_DIR: root,
    NAKARA_DATA_DIR: dir,
  });
  const record = store.repos.factories.createFactory({
    slug: "reach",
    name: "Reach",
    description: "",
    avatar_color: "#000000",
    foreman_handle: "reach",
    definition_dir: root,
    definition_mode: "repo",
  });
  const factory = new Factory(store, config, undefined, { record });
  const mcp = () => Object.keys(factory.definition?.foreman.mcpServers ?? {});

  // The first load is the approved reach.
  assert.ok((await factory.reloadDefinition()).ok);
  assert.equal(factory.pendingReach(), null);

  // A new server: the old definition keeps running and one approval waits.
  await servers("linear");
  assert.equal((await factory.reloadDefinition()).ok, false);
  assert.deepEqual(mcp(), []);
  assert.deepEqual(factory.pendingReach(), [
    "foreman · linear · tool get_issue",
    "foreman · linear · url https://linear.test",
  ]);
  assert.match(
    factory.definitionProblems.errors[0]?.message ?? "",
    /waits for your approval/,
  );

  // A restart keeps it waiting and runs the last applied copy meanwhile.
  const restarted = new Factory(store, config, undefined, { record });
  assert.equal((await restarted.reloadDefinition()).ok, false);
  assert.deepEqual(
    Object.keys(restarted.definition?.foreman.mcpServers ?? {}),
    [],
  );
  assert.ok(restarted.definition?.agents.has("implement"));
  assert.equal(restarted.pendingReach()?.length, 2);

  // Approve applies it.
  assert.ok((await factory.approveReach())?.ok);
  assert.deepEqual(mcp(), ["linear"]);
  assert.equal(factory.pendingReach(), null);
  assert.equal(factory.approveReach(), null);

  // Reject keeps the old one and closes the approval.
  await servers("linear", "sentry");
  await factory.reloadDefinition();
  assert.ok(factory.rejectReach());
  assert.deepEqual(mcp(), ["linear"]);
  assert.equal(factory.pendingReach(), null);
  assert.match(factory.definitionProblems.errors[0]?.message ?? "", /rejected/);

  // Removing a server narrows reach: applied at once, nothing to approve.
  await servers();
  assert.ok((await factory.reloadDefinition()).ok);
  assert.deepEqual(mcp(), []);
  assert.equal(factory.pendingReach(), null);

  // A host added to the containers' egress waits too, and so does leaving the container.
  const docker = join(root, "runners/docker.yaml");
  const runner = await readFile(docker, "utf8");
  await writeFile(
    docker,
    runner.replace(
      "    - registry.npmjs.org\n",
      "    - registry.npmjs.org\n    - pastebin.com\n",
    ),
  );
  assert.equal((await factory.reloadDefinition()).ok, false);
  assert.ok(
    factory.pendingReach()?.includes("runner docker · egress pastebin.com"),
  );
  await writeFile(
    docker,
    runner.replace("  linux:\n    dockerImage: nakara-agent\n", ""),
  );
  assert.equal((await factory.reloadDefinition()).ok, false);
  assert.ok(factory.pendingReach()?.includes("review · runner host"));
  await writeFile(docker, runner);
  assert.ok((await factory.reloadDefinition()).ok);

  // Reach approved before runners counted takes where agents run now as approved.
  const key = `reach:${record.id}`;
  const approved: string[] = JSON.parse(store.getKv(key) ?? "[]");
  store.setKv(
    key,
    JSON.stringify(approved.filter((l) => !RUNNER_LINE.test(l))),
  );
  assert.ok((await factory.reloadDefinition()).ok);
  assert.equal(factory.pendingReach(), null);
});
