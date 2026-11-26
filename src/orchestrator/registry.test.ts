import assert from "node:assert/strict";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import type { HttpBindings } from "@hono/node-server";

import { loadConfig } from "../config.ts";
import { type ScheduledRun, Store, stubFactorySeed } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { Logger } from "../telemetry/log.ts";
import { Metrics } from "../telemetry/metrics.ts";
import { createApi } from "../web/api.ts";
import { createApp } from "../web/test-support.ts";
import type { StatusDto } from "../web/status.ts";
import type { Factory } from "./factory.ts";
import { FactoryRegistry } from "./registry.ts";

/** Two registered factories: "default" runs the shipped definition, "second" the one in `dir`. */
function twoFactories(
  dir: string,
  backups: string,
  env: Record<string, string> = {},
) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "second",
    name: "Second",
    definition_dir: dir,
  });
  const config = loadConfig({
    NAKARA_GITHUB_MIRROR: "false",
    // Never read the snapshots of a real installation.
    NAKARA_BACKUP_DIR: backups,
    ...env,
  });
  const registry = new FactoryRegistry(store, config);
  const [first, second] = registry.factories as [Factory, Factory];
  return { store, config, registry, first, second };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check(), "timed out");
};

const queueRun = (store: Store, itemId: number) =>
  store.createRun({
    item_id: itemId,
    role: "agent",
    agent: "implement",
    agent_type: "IMPLEMENT",
    harness: "claude",
    model: null,
    session_id: null,
    input: "Build it",
    status: "queued",
  });

test("each factory loads its own definition; a broken one shows its errors while the other keeps running", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const broken = join(dir, "factory");
  await mkdir(broken);
  await writeFile(join(broken, "factory.yaml"), "kind: [unclosed\n");
  const { store, config, registry, first, second } = twoFactories(
    broken,
    join(dir, "backups"),
  );
  t.after(async () => {
    await registry.drain(0);
    store.close();
  });
  // Foreman turns are recorded and finish at once; no harness runs.
  const turns: [string, number][] = [];
  for (const factory of registry.factories)
    factory.foremanTurn = async (itemId) => {
      turns.push([factory.record?.slug ?? "", itemId]);
      store.markEventsProcessed(store.pendingEvents(itemId).map((e) => e.id));
    };
  await registry.start();

  assert.equal(first.config.definitionDir, join(process.cwd(), "factory"));
  assert.equal(second.config.definitionDir, broken);
  assert.ok(first.definition);
  assert.deepEqual(first.definitionProblems.errors, []);
  assert.equal(second.definition, undefined);
  assert.ok(second.definitionProblems.errors.length > 0);

  // Work lands in its own factory; only the factory with a valid definition runs it.
  const working = first.createWorkItem({
    title: "Runs",
    request: "r",
    source: "manual",
  });
  const waiting = second.createWorkItem({
    title: "Waits",
    request: "r",
    source: "manual",
  });
  assert.equal(working.factory_id, first.record?.id);
  assert.equal(waiting.factory_id, second.record?.id);
  assert.equal(registry.forItem(waiting.id), second);
  await until(() => turns.length === 1);
  assert.deepEqual(turns, [["default", working.id]]);
  assert.equal(store.pendingEvents(waiting.id).length, 1);

  // A queued run of the broken factory holds no slot from the other factory.
  const stalled = queueRun(store, waiting.id);
  const started: number[] = [];
  first.agentRun = async (run: ScheduledRun) => {
    started.push(run.id);
    store.cancelQueuedRuns(run.item_id);
  };
  const runnable = queueRun(store, working.id);
  await registry.pump();
  assert.deepEqual(started, [runnable.id]);
  assert.equal(store.runById(stalled.id)?.status, "queued");

  // The status and the factory's own definition page show its errors.
  const api = createApi(registry, config);
  const status = (await (await api.request("/status")).json()) as StatusDto;
  assert.deepEqual(
    status.factories.map(({ slug, loaded }) => ({ slug, loaded })),
    [
      { slug: "default", loaded: true },
      { slug: "second", loaded: false },
    ],
  );
  assert.equal(
    status.factories[1]?.errors,
    second.definitionProblems.errors.length,
  );
  const page = (await (await api.request("/f/second/definition")).json()) as {
    dir: string;
    running: unknown;
    errors: unknown[];
  };
  assert.equal(page.dir, broken);
  assert.equal(page.running, null);
  assert.ok(page.errors.length > 0);
  const healthy = (await (
    await api.request("/f/default/definition")
  ).json()) as { errors: unknown[] };
  assert.deepEqual(healthy.errors, []);
  assert.equal((await api.request("/f/missing/agents")).status, 404);

  // Fixing the broken definition and reloading that factory starts its work.
  await rm(broken, { recursive: true });
  await copyDefinition(broken, "Second", ["acme/second"]);
  assert.ok((await second.reloadDefinition()).ok);
  assert.ok(first.definition);
  await registry.pump();
  await until(() => turns.length === 2);
  assert.deepEqual(turns[1], ["second", waiting.id]);
});

test("the concurrency limit is shared across factories", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  const secondDir = join(dir, "second");
  await copyDefinition(secondDir, "Second", ["acme/second"]);
  const { store, registry, first, second } = twoFactories(
    secondDir,
    join(dir, "backups"),
    { NAKARA_CONCURRENCY: "2" },
  );
  t.after(async () => {
    await registry.drain(0);
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  // Agent runs hold their slot until released, as a harness would.
  const running = new Set<number>();
  const release = new Map<number, () => void>();
  let peak = 0;
  for (const factory of registry.factories)
    factory.agentRun = (run: ScheduledRun) => {
      store.markRunStarted(run.id, "");
      running.add(run.id);
      peak = Math.max(peak, running.size);
      return new Promise<void>((resolve) =>
        release.set(run.id, () => {
          running.delete(run.id);
          store.finishRun(run.id, {
            status: "succeeded",
            result: "done",
            error: null,
            cost_usd: 0,
            num_turns: 1,
            duration_ms: 1,
            session_id: null,
            log_path: null,
          });
          resolve();
        }),
      );
    };
  await registry.start();

  const item = (factory: Factory) =>
    store.createItem({
      title: "Work",
      request: "r",
      source: "manual",
      factoryId: factory.record?.id,
    });
  const a1 = queueRun(store, item(first).id);
  const a2 = queueRun(store, item(first).id);
  const b1 = queueRun(store, item(second).id);
  await registry.pump();
  assert.deepEqual([...running], [a1.id, a2.id]);
  assert.equal(store.runById(b1.id)?.status, "queued");

  // A slot freed in one factory goes to the other factory's queued run.
  release.get(a1.id)?.();
  await until(() => running.has(b1.id));
  assert.deepEqual([...running].sort(), [a2.id, b1.id]);
  release.get(a2.id)?.();
  release.get(b1.id)?.();
  await until(() => running.size === 0);
  assert.equal(peak, 2);
});

test("an unreadable definition is an error of its own factory, not a crash", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  const unreadable = join(dir, "factory");
  await cp("factory", unreadable, { recursive: true });
  await chmod(join(unreadable, "factory.yaml"), 0o000);
  t.after(async () => {
    await chmod(join(unreadable, "factory.yaml"), 0o644);
    await rm(dir, { recursive: true, force: true });
  });
  const { store, config, registry, first, second } = twoFactories(
    unreadable,
    join(dir, "backups"),
  );
  t.after(async () => {
    await registry.drain(0);
    store.close();
  });
  await registry.start();

  assert.ok(first.definition);
  assert.equal(second.definition, undefined);
  const [error] = second.definitionProblems.errors;
  assert.equal(error?.path, unreadable);
  assert.match(error?.message ?? "", /could not be read: .*EACCES/);
  // Reloading it from the page reports the error instead of failing.
  const api = createApi(registry, config);
  const reload = await api.request("/f/second/definition/reload", {
    method: "POST",
  });
  assert.equal(reload.status, 200);
  assert.equal(((await reload.json()) as { ok: boolean }).ok, false);
});

/** A copy of the shipped definition with its own alias and repositories. */
async function copyDefinition(dir: string, alias: string, repos: string[]) {
  await cp("factory", dir, { recursive: true });
  const yaml = join(dir, "factory.yaml");
  const repositories = repos
    .map((r) => r.split("/"))
    .map(([owner, name]) => `  - owner: ${owner}\n    name: ${name}\n`)
    .join("");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8"))
      .replace(/^alias: .*$/m, `alias: ${alias}`)
      .replace(
        /^repositories:\n(?: {2}.*\n)+/m,
        `repositories:\n${repositories}`,
      ),
  );
}

test("an issue labeled for a factory lands in that factory", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  const oldPath = process.env.PATH;
  t.after(async () => {
    process.env.PATH = oldPath;
    await rm(dir, { recursive: true, force: true });
  });
  const harbor = join(dir, "harbor");
  await copyDefinition(harbor, "Harbor", ["acme/harbor"]);
  // A fake gh: `issue list --repo R --label L` lists the issues of issues.json[`R L`].
  const issues: Record<string, unknown[]> = {
    "acme/harbor factory:Harbor": [
      {
        number: 7,
        title: "Dock the ship",
        body: "Berth 4",
        url: "https://github.com/acme/harbor/issues/7",
        author: { login: "skipper" },
      },
    ],
    "alwisofwan1/nakara factory:Nakara": [
      {
        number: 3,
        title: "Fix the forge",
        body: "Hot",
        url: "https://github.com/alwisofwan1/nakara/issues/3",
        author: null,
      },
    ],
  };
  await writeFile(
    join(dir, "gh"),
    `#!${process.execPath}
const args = process.argv.slice(2);
const at = (flag) => args[args.indexOf(flag) + 1];
const issues = ${JSON.stringify(issues)};
// \`api --paginate repos/R/issues/N/events …\` prints the jq lines "label<TAB>login<TAB>time".
if (args[0] === "api" && args[1] === "graphql") console.log("[]");
else if (args[0] === "api" && args[1].includes("/collaborators/")) console.log(args[1].includes("/harbormaster/") ? "write" : "read");
else if (args[0] === "api") {
  if (!args[2].startsWith("repos/acme/harbor/issues/7/")) process.exit(1);
  console.log(${JSON.stringify("bug\tskipper\t2026-01-01T00:00:00Z\nFACTORY:harbor\tquartermaster\t2026-01-01T00:00:01Z\nfactory:Harbor\tharbormaster\t2026-01-01T00:00:02Z")});
} else console.log(JSON.stringify(issues[at("--repo") + " " + at("--label")] ?? []));
`,
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}:${oldPath}`;
  const { store, registry, second } = twoFactories(
    harbor,
    join(dir, "backups"),
  );
  t.after(async () => {
    await registry.drain(0);
    store.close();
  });
  for (const factory of registry.factories) factory.pump = async () => {};
  await registry.start();
  assert.equal(second.definition?.label, "factory:Harbor");

  const poller = new GithubPoller(registry.factories);
  await poller.poll();
  assert.equal(poller.lastPoll?.error, null);
  const docked = store.itemBySourceRef("github:acme/harbor#7");
  assert.equal(docked?.factory_id, second.record?.id);
  // The Requester is whoever last applied the label, not the author.
  assert.equal(docked?.requester, "harbormaster");
  assert.equal(registry.forItem(docked?.id ?? 0), second);
  // Unreadable events: nobody is known to have labelled it, so no work starts.
  assert.equal(store.itemBySourceRef("github:alwisofwan1/nakara#3"), undefined);

  // A second poll imports nothing again.
  await poller.poll();
  assert.equal(store.items().length, 1);
});

test("a definition claiming a repository another factory owns is refused, naming the owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harbor = join(dir, "harbor");
  // The shipped definition, which the default factory runs, owns alwisofwan1/nakara.
  await copyDefinition(harbor, "Harbor", ["acme/harbor", "AlwiSofwan1/Nakara"]);
  const { store, registry, first, second } = twoFactories(
    harbor,
    join(dir, "backups"),
  );
  t.after(async () => {
    await registry.drain(0);
    store.close();
  });
  await registry.start();

  assert.ok(first.definition);
  assert.equal(second.definition, undefined);
  assert.deepEqual(second.definitionProblems.errors, [
    {
      path: "factory.yaml",
      message:
        'repository AlwiSofwan1/Nakara is already owned by the factory "Default"',
    },
  ]);
  // Validation without applying reports it too; dropping the repository loads.
  assert.equal((await second.validateDefinition()).ok, false);
  await rm(harbor, { recursive: true });
  await copyDefinition(harbor, "Harbor", ["acme/harbor"]);
  assert.ok((await second.reloadDefinition()).ok);
  assert.deepEqual(second.definitionProblems.errors, []);
  // The owner reloading keeps its repositories.
  assert.ok((await first.reloadDefinition()).ok);
});

test("an automation's repos filter claiming another factory's repository is refused, naming the owner", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const harbor = join(dir, "harbor");
  await copyDefinition(harbor, "Harbor", ["acme/harbor"]);
  const watch = join(harbor, "automations", "harbor-watch");
  await mkdir(watch);
  const watchRepos = (repos: string[]) =>
    writeFile(
      join(watch, "automation.md"),
      `---
triggers:
  - provider: github
    event: issue_labeled
    filter:
      repos: ${JSON.stringify(repos)}
---
Watch the harbor.
`,
    );
  // The default factory's shipped definition owns alwisofwan1/nakara.
  await watchRepos(["acme/harbor", "ALWISOFWAN1/nakara"]);
  const { store, registry, first, second } = twoFactories(
    harbor,
    join(dir, "backups"),
  );
  t.after(async () => {
    await registry.drain(0);
    store.close();
  });
  await registry.start();

  assert.ok(first.definition);
  assert.equal(second.definition, undefined);
  assert.deepEqual(second.definitionProblems.errors, [
    {
      path: "automations/harbor-watch/automation.md",
      message:
        'repository ALWISOFWAN1/nakara is already owned by the factory "Default"',
    },
  ]);
  // The factory's own repositories in a repos filter are its own claim.
  await watchRepos(["acme/harbor", "ACME/Harbor"]);
  assert.ok((await second.reloadDefinition()).ok);
  assert.deepEqual(second.definitionProblems.errors, []);
});

test("NAKARA_DEFINITION_DIR set to another directory than the first factory's warns at startup and in /healthz; the registry's directory loads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  // The in-memory store registers the first factory at "factory".
  const registered = resolve("factory");
  const start = async (env: Record<string, string>) => {
    const store = new Store(":memory:", { defaultBudgetUsd: 15 });
    const config = loadConfig({
      NAKARA_GITHUB_MIRROR: "false",
      NAKARA_BACKUP_DIR: join(dir, "backups"),
      ...env,
    });
    const lines: string[] = [];
    const registry = new FactoryRegistry(store, config, {
      log: new Logger({ write: (l) => lines.push(l), secrets: [] }),
      metrics: new Metrics(),
    });
    t.after(async () => {
      await registry.drain(0);
      store.close();
    });
    await registry.start();
    const app = createApp(
      registry,
      new GithubPoller(registry.default),
      config,
      "test",
    );
    const health = (await (
      await app.request("/healthz", {}, {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      } as HttpBindings)
    ).json()) as { warnings: string[] };
    const logged = lines
      .map((l) => JSON.parse(l))
      .filter((l) => l.event === "startup.definition_dir_ignored");
    return { registry, logged, warnings: health.warnings };
  };
  const mentions = (warnings: string[]) =>
    warnings.filter((w) => w.includes("NAKARA_DEFINITION_DIR"));

  const other = join(dir, "elsewhere");
  const differing = await start({ NAKARA_DEFINITION_DIR: other });
  const message = `NAKARA_DEFINITION_DIR (${other}) differs from the first factory's registered definition directory (${registered}); the registry value is used.`;
  assert.equal(differing.logged.length, 1);
  assert.equal(differing.logged[0].level, "warn");
  assert.equal(differing.logged[0].configured, other);
  assert.equal(differing.logged[0].registered, registered);
  assert.equal(differing.logged[0].message, message);
  assert.deepEqual(mentions(differing.warnings), [message]);
  // No override: the first factory loads from its registered directory.
  assert.equal(differing.registry.default.config.definitionDir, registered);
  assert.ok(differing.registry.default.definition);

  // Paths compare resolved: a relative value naming the same directory matches.
  for (const env of [{ NAKARA_DEFINITION_DIR: "./factory/" }, {}] as Record<
    string,
    string
  >[]) {
    const quiet = await start(env);
    assert.deepEqual(quiet.logged, []);
    assert.deepEqual(mentions(quiet.warnings), []);
  }
});

test("each factory names its agent token source in /healthz and its definition page, warns where it cannot push, and never shows the value", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-registry-"));
  const secondDir = join(dir, "second");
  await copyDefinition(secondDir, "Second", ["client/app"]);
  const vars = {
    NAKARA_AGENT_GH_TOKEN: "github_pat_shared_value",
    NAKARA_AGENT_GH_TOKEN__SECOND: "github_pat_second_value",
  };
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, vars);
  const lines: string[] = [];
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "second",
    name: "Second",
    definition_dir: secondDir,
  });
  const config = loadConfig({
    NAKARA_GITHUB_MIRROR: "false",
    NAKARA_BACKUP_DIR: join(dir, "backups"),
  });
  const registry = new FactoryRegistry(store, config, {
    log: new Logger({ write: (l) => lines.push(l) }),
    metrics: new Metrics(),
  });
  t.after(async () => {
    for (const [k, v] of Object.entries(saved))
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    await registry.drain(0);
    store.close();
    await rm(dir, { recursive: true, force: true });
  });
  await registry.start();
  // Offline: the clones succeed, and GitHub answers per token.
  const asked: [string, string | undefined, string | undefined][] = [];
  for (const factory of registry.factories) {
    factory.probeRepository = async () => ({ defaultBranch: "main" });
    factory.agentTokenGh = async (args, env) => {
      asked.push([factory.record?.slug ?? "", args[1], env?.GH_TOKEN]);
      return { ok: true, stdout: "false\n", stderr: "" };
    };
  }
  await registry.checkRepositories();
  // Each factory is checked with its own token.
  assert.ok(asked.length > 0);
  for (const [slug, , token] of asked)
    assert.equal(
      token,
      slug === "second" ? "github_pat_second_value" : "github_pat_shared_value",
    );

  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "test",
  );
  const health = await (
    await app.request("/healthz", {}, {
      incoming: { socket: { remoteAddress: "127.0.0.1" } },
    } as HttpBindings)
  ).text();
  const parsed = JSON.parse(health) as {
    factories: Record<string, { agentToken: string }>;
    warnings: string[];
  };
  assert.equal(parsed.factories.default?.agentToken, "shared");
  assert.equal(parsed.factories.second?.agentToken, "own");
  assert.ok(
    parsed.warnings.includes(
      "The agent token can't push to client/app. Agents of second could not push branches or open pull requests there.",
    ),
    health,
  );

  const api = createApi(registry, config);
  const page = await (await api.request("/f/second/definition")).text();
  assert.deepEqual((JSON.parse(page) as { agentToken: unknown }).agentToken, {
    source: "own",
    variable: "NAKARA_AGENT_GH_TOKEN__SECOND",
    label: "own token (NAKARA_AGENT_GH_TOKEN__SECOND)",
  });
  const setup = await (await api.request("/setup")).text();
  assert.match(
    setup,
    /Agents use the own token \(NAKARA_AGENT_GH_TOKEN__SECOND\)/,
  );
  for (const out of [health, page, setup, lines.join("\n")])
    for (const value of Object.values(vars))
      assert.ok(!out.includes(value), out);
  // The definition files hold no token either.
  assert.ok(
    !(await readFile(join(secondDir, "factory.yaml"), "utf8")).includes(
      "github_pat_",
    ),
  );
});
