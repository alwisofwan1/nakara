import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { loadConfig } from "../config.ts";
import { Store, stubFactorySeed } from "../db.ts";
import type { Template } from "../definition/scaffold.ts";
import { readCreation } from "../web/wizard.ts";
import {
  type CreationDeps,
  type CreationRequest,
  FactoryCreation,
} from "./creation.ts";
import type { Factory } from "./factory.ts";
import { FactoryRegistry } from "./registry.ts";

const BUNDLED = join(import.meta.dirname, "../../factory");

/** A stand-in for warpdotdev/warp-factory-examples with one example. */
async function warpClone(dest: string) {
  const agent = (type: string) =>
    `---\nagentType: ${type}\nmodel: auto-genius\n---\nDo the ${type} work.\n`;
  const files: Record<string, string> = {
    LICENSE: "MIT License\n",
    "examples/00-warp-default-agents/factory.yaml":
      "schemaVersion: v1alpha1\nname: warp-default-agents\nrepositories: []\nagentDefaults: { model: auto-genius }\n",
    "examples/00-warp-default-agents/agents/foreman/agent.md": agent("FOREMAN"),
    "examples/00-warp-default-agents/agents/implement/agent.md":
      agent("IMPLEMENT"),
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(dest, path)), { recursive: true });
    await writeFile(join(dest, path), text);
  }
}

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const dataDir = await mkdtemp(join(tmpdir(), "nakara-creation-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NAKARA_DATA_DIR: dataDir,
    NAKARA_GITHUB_MIRROR: "false",
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, config);
  const added: Factory[] = [];
  registry.onAdded((factory) => added.push(factory));
  const calls: string[] = [];
  /** Repositories whose next clone fails. */
  const failClone = new Set<string>();
  /** Repositories that have the label already. */
  const labeled = new Set<string>();
  /** `git status --porcelain` of a checkout, by its path. */
  const dirty = new Map<string, string>();
  const deps: CreationDeps = {
    gh: async (args) => {
      calls.push(args.slice(0, 5).join(" "));
      const repo = args[4] ?? "";
      if (labeled.has(repo))
        return {
          ok: false,
          stdout: "",
          stderr: `label with name "${args[2]}" already exists; use \`--force\` to update its color and description`,
        };
      labeled.add(repo);
      return { ok: true, stdout: "", stderr: "" };
    },
    scaffold: { cloneWarpExamples: warpClone },
    clone: async (_cache, owner, name) => {
      const repo = `${owner}/${name}`;
      calls.push(`clone ${repo}`);
      if (failClone.delete(repo))
        throw Object.assign(new Error("Command failed: gh repo clone"), {
          stderr: `GraphQL: Could not resolve to a Repository with the name '${repo}'.`,
        });
    },
    checkout: async (repo, dest) => {
      calls.push(`checkout ${repo}`);
      await mkdir(join(dest, ".git"), { recursive: true });
    },
    git: async (args, cwd) => {
      calls.push(`git ${args[0]} ${cwd}`);
      return args[0] === "status" ? (dirty.get(cwd) ?? "") : "";
    },
  };
  const creation = new FactoryCreation(registry, config, deps);
  return {
    store,
    registry,
    creation,
    calls,
    failClone,
    labeled,
    dirty,
    added,
    dataDir,
  };
}

const request = (
  template: Template,
  more: Partial<CreationRequest> = {},
): CreationRequest => ({
  choices: {
    name: "Web Shop",
    repositories: [
      { owner: "acme", name: "shop" },
      { owner: "acme", name: "shop-api" },
    ],
    template,
    intake: { github: true, telegram: false, schedule: null },
  },
  avatarColor: "#0e7490",
  location: { mode: "managed" },
  ...more,
});

for (const template of [
  { kind: "nakara" },
  { kind: "warp" },
  { kind: "import", from: BUNDLED },
  { kind: "blank" },
] satisfies Template[])
  test(`Create from the ${template.kind} template: a running factory with its label in every repository`, async (t) => {
    const { store, registry, creation, calls, added, dataDir } = await setup(t);
    const started = await creation.start(request(template));
    assert.ok(started.ok);
    await creation.settled(started.job.id);

    const dto = readCreation(store, started.job.id);
    assert.equal(dto?.status, "done", JSON.stringify(dto?.steps));
    assert.deepEqual(
      dto?.steps.map((s) => [s.label, s.status]),
      [
        ["Write definition", "done"],
        ["Validate", "done"],
        ["Clone repositories", "done"],
        ["Create labels", "done"],
        ["Register and start intake", "done"],
      ],
    );
    assert.equal(dto?.steps[2]?.detail, "2 of 2");
    assert.equal(
      dto?.steps[3]?.detail,
      "factory:Web Shop: 2 created, 0 already existed",
    );
    assert.equal(dto?.steps[4]?.detail, "GitHub poll, Web");
    assert.deepEqual(calls, [
      "clone acme/shop",
      "clone acme/shop-api",
      "label create factory:Web Shop --repo acme/shop",
      "label create factory:Web Shop --repo acme/shop-api",
    ]);

    const record = store.repos.factories.factory("web-shop");
    assert.equal(record?.name, "Web Shop");
    assert.equal(record?.avatar_color, "#0e7490");
    assert.equal(record?.foreman_handle, "web-shop");
    assert.equal(record?.definition_mode, "managed");
    assert.equal(record?.definition_dir, join(dataDir, "factories/web-shop"));
    const factory = registry.get("web-shop");
    assert.equal(factory?.definition?.label, "factory:Web Shop");
    assert.deepEqual(added, [factory]);
    store.db.close();
  });

test("a failed step shows its error, and Retry resumes from it without redoing the steps before", async (t) => {
  const { store, creation, calls, failClone, labeled, registry } =
    await setup(t);
  failClone.add("acme/shop-api");
  // The label exists in one repository: it is kept, not an error.
  labeled.add("acme/shop");
  const started = await creation.start(request({ kind: "blank" }));
  assert.ok(started.ok);
  const { id } = started.job;
  await creation.settled(id);

  let dto = readCreation(store, id);
  assert.equal(dto?.status, "failed");
  assert.deepEqual(
    dto?.steps.map((s) => s.status),
    ["done", "done", "failed", "pending", "pending"],
  );
  assert.equal(
    dto?.steps[2]?.error,
    "Could not clone acme/shop-api: GraphQL: Could not resolve to a Repository with the name 'acme/shop-api'.",
  );
  assert.equal(registry.get("web-shop"), undefined);

  // Writing again would be refused: the folder has files now.
  assert.ok(creation.retry(id).ok);
  await creation.settled(id);
  dto = readCreation(store, id);
  assert.equal(dto?.status, "done", JSON.stringify(dto?.steps));
  assert.equal(
    dto?.steps[3]?.detail,
    "factory:Web Shop: 1 created, 1 already existed",
  );
  // acme/shop was cloned once: the retry went on with the repository that failed.
  assert.deepEqual(
    calls.filter((c) => c.startsWith("clone")),
    ["clone acme/shop", "clone acme/shop-api", "clone acme/shop-api"],
  );
  assert.ok(registry.get("web-shop")?.definition);

  const again = creation.retry(id);
  assert.deepEqual(again, {
    ok: false,
    code: "policy",
    message: "Web Shop has been created.",
  });
  assert.equal(creation.retry("missing").ok, false);
  store.db.close();
});

test("a definition kept in a repository is written into a checkout of it", async (t) => {
  const { store, creation, calls, dataDir } = await setup(t);
  const started = await creation.start(
    request(
      { kind: "blank" },
      { location: { mode: "repo", repo: "acme/shop", folder: "ops/factory" } },
    ),
  );
  assert.ok(started.ok);
  await creation.settled(started.job.id);
  assert.equal(readCreation(store, started.job.id)?.status, "done");
  const dir = join(dataDir, "checkouts/acme/shop/ops/factory");
  assert.ok((await readdir(dir)).includes("factory.yaml"));
  assert.equal(calls[0], "checkout acme/shop");
  const record = store.repos.factories.factory("web-shop");
  assert.equal(record?.definition_mode, "repo");
  assert.equal(record?.definition_dir, dir);
  store.db.close();
});

test("Create refuses a definition folder that has files, and a repository another factory owns", async (t) => {
  const { store, creation, registry, dataDir } = await setup(t);
  await mkdir(join(dataDir, "factories/web-shop"), { recursive: true });
  await writeFile(join(dataDir, "factories/web-shop/notes.txt"), "mine");
  const refused = await creation.start(request({ kind: "blank" }));
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.message : "", /already has files/);

  // The default factory claims the repositories of the bundled definition.
  await registry.default.start();
  const [owned] = registry.default.definition?.factory.repositories ?? [];
  assert.ok(owned);
  const started = await creation.start(
    request(
      { kind: "blank" },
      {
        choices: {
          ...request({ kind: "blank" }).choices,
          name: "Second Shop",
          repositories: [owned],
        },
      },
    ),
  );
  assert.ok(started.ok);
  await creation.settled(started.job.id);
  const dto = readCreation(store, started.job.id);
  assert.equal(dto?.steps[1]?.status, "failed");
  assert.match(
    dto?.steps[1]?.error ?? "",
    /factory\.yaml: repository .+ is already owned by the factory "Default"/,
  );
  store.db.close();
});

test("a job a restarted Nakara left running reads as failed at its step, and Retry resumes it", async (t) => {
  const { store, creation } = await setup(t);
  const started = await creation.start(request({ kind: "blank" }));
  assert.ok(started.ok);
  await creation.settled(started.job.id);
  // As saved by another instance that stopped during the clone.
  const job = {
    ...started.job,
    status: "running",
    instance: "gone",
    steps: started.job.steps.map((s, i) => ({
      ...s,
      status: i < 2 ? "done" : i === 2 ? "running" : "pending",
    })),
  };
  store.setKv(`creation:${job.id}`, JSON.stringify(job));
  const dto = readCreation(store, job.id);
  assert.equal(dto?.status, "failed");
  assert.deepEqual(
    dto?.steps.map((s) => s.status),
    ["done", "done", "failed", "pending", "pending"],
  );
  assert.equal(
    dto?.steps[2]?.error,
    "Nakara stopped during this step. Retry resumes it.",
  );
  assert.ok(creation.retry(job.id).ok);
  await creation.settled(job.id);
  assert.equal(readCreation(store, job.id)?.status, "done");
  assert.equal(readCreation(store, "unknown"), undefined);
  store.db.close();
});

test("a running job holds its slug; a failed one that never registered is replaced by a new Create, which reuses its folder", async (t) => {
  const { store, creation, failClone } = await setup(t);
  failClone.add("acme/shop-api");
  const first = await creation.start(request({ kind: "blank" }));
  assert.ok(first.ok);
  // The first job is still running.
  assert.deepEqual(await creation.start(request({ kind: "blank" })), {
    ok: false,
    code: "policy",
    message: `Web Shop is being created in ${first.job.dir}; wait for it to finish.`,
  });
  await creation.settled(first.job.id);
  assert.equal(readCreation(store, first.job.id)?.status, "failed");

  // Create again, with other choices: the failed job's folder is rewritten.
  const second = await creation.start(request({ kind: "nakara" }));
  assert.ok(second.ok, JSON.stringify(second));
  assert.equal(second.job.dir, first.job.dir);
  assert.equal(readCreation(store, first.job.id), undefined);
  await creation.settled(second.job.id);
  const dto = readCreation(store, second.job.id);
  assert.equal(dto?.status, "done", JSON.stringify(dto?.steps));
  assert.ok((await readdir(second.job.dir)).includes("agents"));
  store.db.close();
});

test("a failed job still refuses another slug in its folder, and a factory it registered", async (t) => {
  const { store, creation, failClone } = await setup(t);
  failClone.add("acme/shop");
  const location = {
    mode: "repo",
    repo: "acme/shop",
    folder: "factory",
  } as const;
  const first = await creation.start(request({ kind: "blank" }, { location }));
  assert.ok(first.ok);
  await creation.settled(first.job.id);
  assert.equal(readCreation(store, first.job.id)?.status, "failed");
  const failed = `Creating Web Shop in ${first.job.dir} failed; open its progress and Retry it.`;
  const other = request({ kind: "blank" }, { location });
  other.choices.name = "Other Shop";
  assert.deepEqual(await creation.start(other), {
    ok: false,
    code: "policy",
    message: failed,
  });
  // A factory of the slug is registered (its register step failed after that).
  store.repos.factories.createFactory({
    ...stubFactorySeed(),
    slug: "web-shop",
    name: "Web Shop",
    definition_dir: first.job.dir,
  });
  assert.deepEqual(
    await creation.start(request({ kind: "blank" }, { location })),
    { ok: false, code: "policy", message: failed },
  );
  store.db.close();
});

test("a checkout kept from earlier is fetched, and refused while it has uncommitted changes", async (t) => {
  const { store, creation, calls, dirty, dataDir } = await setup(t);
  const checkout = join(dataDir, "checkouts/acme/shop");
  await mkdir(join(checkout, ".git"), { recursive: true });
  dirty.set(checkout, " M README.md\n");
  const started = await creation.start(
    request(
      { kind: "blank" },
      { location: { mode: "repo", repo: "acme/shop", folder: "factory" } },
    ),
  );
  assert.ok(started.ok);
  await creation.settled(started.job.id);
  const failed = readCreation(store, started.job.id);
  assert.equal(failed?.steps[0]?.status, "failed");
  assert.equal(
    failed?.steps[0]?.error,
    `${checkout} has uncommitted changes; commit or discard them, then Retry:\nM README.md`,
  );
  assert.deepEqual(calls, [`git fetch ${checkout}`, `git status ${checkout}`]);

  dirty.delete(checkout);
  assert.ok(creation.retry(started.job.id).ok);
  await creation.settled(started.job.id);
  assert.equal(readCreation(store, started.job.id)?.status, "done");
  // The checkout was reused, never cloned again.
  assert.ok(!calls.some((c) => c.startsWith("checkout")));
  store.db.close();
});
