import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Store, stubFactorySeed } from "../db.ts";
import { fileRevision, loadDefinition } from "../definition/load.ts";
import { type AgentDto, readAgent, readAgents } from "./agents.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { createApi } from "./api.ts";
import { loadConfig } from "../config.ts";

test("agents project definition order, effective settings and isolated relationships", async () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  try {
    const result = await loadDefinition("factory", {
      kind: "claude",
      model: undefined,
    });
    assert.ok(result.ok);
    const def = result.definition;
    assert.deepEqual(readAgents(store, undefined), []);
    assert.equal(readAgent(store, def, "missing"), undefined);
    const agents = readAgents(store, def);
    assert.equal(agents[0]?.name, def.foreman.name);
    assert.equal(agents.length, def.agents.size);
    const item = store.createItem({
      title: "test",
      request: "test",
      source: "manual",
    });
    for (const agent of ["foreman", "implement"])
      store.createRun({
        item_id: item.id,
        role: agent === "foreman" ? "foreman" : "agent",
        agent,
        agent_type: agent === "foreman" ? "FOREMAN" : "IMPLEMENT",
        harness: "claude",
        model: null,
        session_id: null,
        input: "private input",
        status: "succeeded",
      });
    const dto = readAgent(store, def, "foreman");
    assert.ok(dto);
    assert.deepEqual(
      dto.settings.find((s) => s.name === "Runner"),
      { name: "Runner", value: "docker", inherited: true },
    );
    assert.deepEqual(
      dto.settings.find((s) => s.name === "Model"),
      { name: "Model", value: "opus · high", inherited: false },
    );
    assert.deepEqual(
      dto.settings.find((s) => s.name === "Skills"),
      {
        name: "Skills",
        value: "code-review, ui-verification",
        inherited: true,
      },
    );
    assert.deepEqual(
      dto.settings.find((s) => s.name === "Agent skills"),
      { name: "Agent skills", value: "None", inherited: false },
    );
    assert.deepEqual(
      readAgent(store, def, "triage")?.settings.find((s) => s.name === "Model"),
      // The bundled triage agent sets its own model (factory/agents/triage/agent.md).
      { name: "Model", value: "haiku", inherited: false },
    );
    assert.equal(
      dto.settings.find((s) => s.name === "Idle timeout")?.value,
      "60 minutes",
    );
    assert.equal(dto.runs.length, 1);
    assert.equal(dto.runs[0]?.id, 1);
    assert.equal(
      dto.automations.length,
      def.automations.filter((a) => a.agent === "foreman").length,
    );
    assert.equal(readAgent(store, def, "implement")?.automations.length, 0);
    assert.ok(!JSON.stringify(dto).includes("private input"));
    const agent = def.foreman;
    agent.runner = "local";
    agent.explicitSettings?.push("runner");
    assert.deepEqual(
      readAgent(store, def, "foreman")?.settings.find(
        (s) => s.name === "Runner",
      ),
      { name: "Runner", value: "local", inherited: false },
    );
    const registry = new FactoryRegistry(store, loadConfig({}));
    registry.default.definition = def;
    const api = createApi(registry, loadConfig({}));
    assert.equal((await api.request("/f/default/agents")).status, 200);
    assert.equal((await api.request("/f/default/agents/foreman")).status, 200);
    assert.deepEqual(
      await (await api.request("/f/default/agents/missing")).json(),
      {
        error: { code: "not_found", message: "Agent not found" },
      },
    );
  } finally {
    store.db.close();
  }
});

test("saving an agent writes agent.md, reloads it and refuses invalid edits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-agents-"));
  const root = join(dir, "factory");
  await cp("factory", root, { recursive: true });
  const store = new Store(":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({ ...stubFactorySeed(), definition_dir: root }),
  });
  const registry = new FactoryRegistry(
    store,
    loadConfig({ NAKARA_DATA_DIR: dir }),
  );
  const factory = registry.default;
  try {
    await factory.reloadDefinition();
    const api = createApi(registry, factory.config);
    const dto = (await (
      await api.request("/f/default/agents/implement")
    ).json()) as AgentDto;
    assert.equal(dto.gitTracked, false);
    assert.deepEqual(dto.defaults, {
      harness: "claude",
      model: "sonnet",
      runner: "docker",
      idleTimeoutMinutes: 60,
    });
    assert.deepEqual(dto.options.runners, [
      "docker-browser",
      "docker",
      "local",
    ]);
    const form = { ...dto.form, revision: dto.revision };
    assert.equal(
      dto.revision,
      fileRevision(await readFile(join(root, "agents/implement/agent.md"))),
    );
    assert.deepEqual(
      { ...dto.form, prompt: dto.form.prompt.slice(0, 16) },
      {
        description: "Implements, validates, and updates code changes.",
        harness: "claude",
        model: "opus",
        effort: "medium",
        runner: "docker-browser",
        spawnableBy: null,
        idleTimeoutMinutes: null,
        prompt: "# Implementation",
      },
    );
    const put = (name: string, body: unknown) =>
      api.request(`/f/default/agents/${name}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    assert.equal((await put("implement", { prompt: "x" })).status, 400);
    assert.equal((await put("missing", form)).status, 404);
    const path = join(root, "agents/implement/agent.md");
    const before = await readFile(path, "utf8");
    const refused = await put("implement", { ...form, harness: "gemini" });
    assert.equal(refused.status, 422);
    const body = (await refused.json()) as {
      error: { code: string; problems: { path: string }[] };
    };
    assert.equal(body.error.code, "invalid_definition");
    assert.equal(body.error.problems[0]?.path, "agents/implement/agent.md");
    assert.equal(await readFile(path, "utf8"), before);

    // Saving an unchanged form neither writes nor reloads.
    const loadedAt = factory.definition?.loadedAt;
    const unchanged = await put("implement", form);
    assert.equal(unchanged.status, 200);
    assert.equal(((await unchanged.json()) as { ok: boolean }).ok, true);
    assert.equal(factory.definition?.loadedAt, loadedAt);

    const changes: string[] = [];
    store.changes.on("change", (e: { type: string }) => changes.push(e.type));
    const saved = await put("implement", {
      ...form,
      model: "sonnet",
      // Unchanged: "local" would move it to the host and wait for approval.
      runner: "docker-browser",
      prompt: "# Implementation\n\nShip it.",
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(await saved.json(), {
      ok: true,
      errors: [],
      warnings: [],
    });
    assert.ok(changes.includes("status"));
    // The next run reads the reloaded definition.
    const agent = factory.definition?.agents.get("implement");
    assert.deepEqual(agent?.harness, {
      kind: "claude",
      model: "sonnet",
      effort: "medium",
    });
    assert.equal(agent?.runner, "docker-browser");
    assert.equal(agent?.instructions, "# Implementation\n\nShip it.");
    // The form from before the save is now stale: 409, and the file stays.
    const after = await readFile(path, "utf8");
    const conflict = await put("implement", { ...form, model: "haiku" });
    assert.equal(conflict.status, 409);
    assert.equal(
      ((await conflict.json()) as { error: { code: string } }).error.code,
      "conflict",
    );
    assert.equal(await readFile(path, "utf8"), after);
    assert.equal(
      after,
      "---\ndescription: Implements, validates, and updates code changes.\nagentType: IMPLEMENT\nharness:\n  type: claude\n  model: sonnet\n  reasoningLevel: medium\nrunner: docker-browser\n---\n# Implementation\n\nShip it.\n",
    );
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("creating and deleting an agent writes the tree, reloads it and refuses invalid changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-agents-"));
  const root = join(dir, "factory");
  await cp("factory", root, { recursive: true });
  const store = new Store(":memory:", {
    defaultBudgetUsd: 15,
    factory: () => ({ ...stubFactorySeed(), definition_dir: root }),
  });
  const registry = new FactoryRegistry(
    store,
    loadConfig({ NAKARA_DATA_DIR: dir }),
  );
  const factory = registry.default;
  try {
    await factory.reloadDefinition();
    const api = createApi(registry, factory.config);
    const send = (method: string, path: string, body: unknown) =>
      api.request(`/f/default${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const error = async (response: Response) =>
      ((await response.json()) as { error: { code: string; message: string } })
        .error;
    const agent = {
      name: "docs",
      type: "CUSTOM",
      description: "Writes documentation.",
      prompt: "# Docs\n\nWrite them.",
    };

    assert.equal(
      (await send("POST", "/agents", { ...agent, name: "Docs Writer" })).status,
      400,
    );
    const foreman = await send("POST", "/agents", {
      ...agent,
      type: "FOREMAN",
    });
    assert.equal(foreman.status, 422);
    assert.equal((await error(foreman)).code, "invalid_definition");
    const created = await send("POST", "/agents", agent);
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      name: "docs",
      ok: true,
      errors: [],
      warnings: [],
    });
    assert.equal(
      await readFile(join(root, "agents/docs/agent.md"), "utf8"),
      "---\ndescription: Writes documentation.\nagentType: CUSTOM\n---\n\n# Docs\n\nWrite them.\n",
    );
    const list = readAgents(store, factory.definition);
    assert.equal(list[0]?.type, "FOREMAN");
    assert.ok(list.some((a) => a.name === "docs" && a.type === "CUSTOM"));
    const taken = await send("POST", "/agents", agent);
    assert.equal(taken.status, 409);
    assert.equal((await error(taken)).code, "conflict");

    const docs = readAgent(store, factory.definition, "docs");
    assert.ok(docs?.revision);
    const remove = (name: string, revision: string) =>
      send("DELETE", `/agents/${name}`, { revision });
    assert.equal((await remove("missing", docs.revision)).status, 404);

    // An automation that names the agent keeps it: the loader's message comes back.
    const automation = join(root, "automations/docs-weekly");
    await mkdir(automation);
    await writeFile(
      join(automation, "automation.md"),
      "---\nagent: docs\nenabled: false\ntriggers:\n  - provider: schedule\n    event: cron_fired\n    schedule: { cron: '0 2 * * 1' }\n---\nRefresh the docs.\n",
    );
    await factory.reloadDefinition();
    const referenced = await remove("docs", docs.revision);
    assert.equal(referenced.status, 409);
    assert.deepEqual(await error(referenced), {
      code: "policy",
      message: 'docs cannot be deleted: agent "docs" is not defined',
      problems: [
        {
          path: "automations/docs-weekly/automation.md",
          line: 2,
          message: 'agent "docs" is not defined',
        },
      ],
    });
    await rm(automation, { recursive: true });
    await factory.reloadDefinition();

    const boss = readAgent(store, factory.definition, "foreman");
    assert.ok(boss?.revision);
    const lastForeman = await remove("foreman", boss.revision);
    assert.equal(lastForeman.status, 409);
    assert.match(
      (await error(lastForeman)).message,
      /exactly one agent must declare agentType: FOREMAN \(found 0\)/,
    );

    const deleted = await remove("docs", docs.revision);
    assert.equal(deleted.status, 200);
    assert.equal(factory.definition?.agents.has("docs"), false);
    await assert.rejects(readFile(join(root, "agents/docs/agent.md")));
  } finally {
    store.db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
