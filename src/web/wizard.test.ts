import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HttpBindings } from "@hono/node-server";
import { loadConfig } from "../config.ts";
import { Store, stubFactorySeed } from "../db.ts";
import { GithubPoller } from "../intake/github.ts";
import { FactoryRegistry } from "../orchestrator/registry.ts";
import { createApp } from "./test-support.ts";
import {
  agentToken,
  type Gh,
  ghLogin,
  owners,
  readFactoryName,
  repoAccess,
  repoList,
} from "./wizard.ts";

const ok = (stdout: string) => ({ ok: true, stdout, stderr: "" });
const failed = (stderr: string) => ({ ok: false, stdout: "", stderr });

test("gh login: logged in with old and new gh output, or the reason it is not", () => {
  // gh 2.23 writes to stderr.
  assert.deepEqual(
    ghLogin({
      ok: true,
      stdout: "",
      stderr:
        "github.com\n  ✓ Logged in to github.com as alwisofwan1 (keyring)\n  ✓ Token scopes: 'repo', 'read:org'\n",
    }),
    {
      loggedIn: true,
      account: "alwisofwan1",
      detail: "keyring, scopes repo, read:org",
    },
  );
  // gh 2.40+ writes to stdout.
  assert.deepEqual(
    ghLogin(
      ok(
        "github.com\n  ✓ Logged in to github.com account octo-cat (GH_TOKEN)\n  - Active account: true\n",
      ),
    ),
    { loggedIn: true, account: "octo-cat", detail: "GH_TOKEN" },
  );
  assert.deepEqual(
    ghLogin(
      failed(
        "You are not logged into any GitHub hosts. Run gh auth login to authenticate.\n",
      ),
    ),
    {
      loggedIn: false,
      account: null,
      detail:
        "You are not logged into any GitHub hosts. Run gh auth login to authenticate.",
    },
  );
  assert.equal(
    ghLogin(failed("spawn gh ENOENT")).detail,
    "spawn gh ENOENT",
    "a missing gh binary is not logged in",
  );
});

test("owners: the account first, then its organizations once each", () => {
  assert.deepEqual(owners("alice", ok("acme\nwidgets-inc\nacme\n")), [
    { login: "alice", kind: "user" },
    { login: "acme", kind: "org" },
    { login: "widgets-inc", kind: "org" },
  ]);
  // A fine-grained login may not read organizations.
  assert.deepEqual(owners("alice", failed("HTTP 403")), [
    { login: "alice", kind: "user" },
  ]);
});

test("agent token: set and fine-grained, the personal fallback, or unset", () => {
  assert.deepEqual(agentToken({ NAKARA_AGENT_GH_TOKEN: "github_pat_x" }), {
    state: "set",
    fineGrained: true,
  });
  assert.deepEqual(agentToken({ NAKARA_AGENT_GH_TOKEN: "ghp_classic" }), {
    state: "set",
    fineGrained: false,
  });
  assert.deepEqual(agentToken({ NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1" }), {
    state: "personal",
    fineGrained: false,
  });
  assert.deepEqual(agentToken({}), { state: "unset", fineGrained: false });
});

test("repo list: gh repo list rows, most recently updated first", () => {
  assert.deepEqual(
    repoList(
      JSON.stringify([
        {
          nameWithOwner: "acme/old",
          isPrivate: false,
          primaryLanguage: null,
          updatedAt: "2026-01-01T00:00:00Z",
        },
        {
          nameWithOwner: "acme/new",
          isPrivate: true,
          primaryLanguage: { name: "TypeScript" },
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ]),
    ),
    [
      {
        repo: "acme/new",
        private: true,
        language: "TypeScript",
        updatedAt: "2026-10-01T00:00:00Z",
      },
      {
        repo: "acme/old",
        private: false,
        language: null,
        updatedAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
});

test("repo access asks GitHub with the agent token and flags what it can't see", async () => {
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const gh: Gh = async (args, env) => {
    calls.push({ args, ...(env && { env }) });
    return args[1] === "repos/acme/secret"
      ? failed("gh: Not Found (HTTP 404)")
      : args[1] === "repos/acme/flaky"
        ? failed("dial tcp: i/o timeout")
        : args[1] === "repos/other/public"
          ? ok("false\n")
          : ok("true\n");
  };
  const env = { NAKARA_AGENT_GH_TOKEN: "github_pat_agent" };
  assert.deepEqual(
    (
      await repoAccess({ gh, env }, [
        "acme/widgets",
        "other/public",
        "acme/secret",
        "acme/flaky",
      ])
    ).repos,
    [
      { repo: "acme/widgets", visible: true, message: null },
      // Public: any token reads it with 200, but the agents can't push.
      {
        repo: "other/public",
        visible: false,
        message: "The agent token can't push to other/public.",
      },
      {
        repo: "acme/secret",
        visible: false,
        message: "The agent token can't see acme/secret.",
      },
      {
        repo: "acme/flaky",
        visible: false,
        message: "Could not check acme/flaky: dial tcp: i/o timeout",
      },
    ],
  );
  // The agent's token, not the operator's gh login.
  for (const call of calls)
    assert.deepEqual(call.env, {
      GH_TOKEN: "github_pat_agent",
      GITHUB_TOKEN: "",
    });

  // Agents get the operator's gh login: that is what is checked.
  calls.length = 0;
  assert.deepEqual(
    (
      await repoAccess({ gh, env: { NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1" } }, [
        "acme/secret",
      ])
    ).repos,
    [
      {
        repo: "acme/secret",
        visible: false,
        message: "The gh login can't see acme/secret.",
      },
    ],
  );
  assert.equal(calls[0]?.env, undefined);

  // No agent token: agents outside Docker push with the gh login, so it is checked.
  calls.length = 0;
  assert.deepEqual(
    (await repoAccess({ gh, env: {} }, ["acme/widgets", "other/public"])).repos,
    [
      { repo: "acme/widgets", visible: true, message: null },
      {
        repo: "other/public",
        visible: false,
        message: "The gh login can't push to other/public.",
      },
    ],
  );
  assert.deepEqual(
    calls.map((call) => [call.args, call.env]),
    [
      [["api", "repos/acme/widgets", "--jq", ".permissions.push"], undefined],
      [["api", "repos/other/public", "--jq", ".permissions.push"], undefined],
    ],
  );
});

test("repo access checks the new factory's own token when it has one, and says which", async () => {
  const seen: (string | undefined)[] = [];
  const gh: Gh = async (_args, env) => {
    seen.push(env?.GH_TOKEN);
    return ok("true\n");
  };
  const env = {
    NAKARA_AGENT_GH_TOKEN: "github_pat_shared",
    NAKARA_AGENT_GH_TOKEN__CLIENT_APP: "github_pat_client",
  };
  const own = await repoAccess({ gh, env }, ["client/app"], "client-app");
  assert.deepEqual(own.token, {
    source: "own",
    variable: "NAKARA_AGENT_GH_TOKEN__CLIENT_APP",
  });
  // A slug without its own token is checked with the shared one.
  const shared = await repoAccess({ gh, env }, ["acme/app"], "acme");
  assert.deepEqual(shared.token, {
    source: "shared",
    variable: "NAKARA_AGENT_GH_TOKEN",
  });
  assert.deepEqual(seen, ["github_pat_client", "github_pat_shared"]);
  // The source and the name, never the value.
  assert.ok(!JSON.stringify([own, shared]).includes("github_pat_"));
});

test("factory name suggests the slug and handle, and refuses ones in use", () => {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const factories = store.repos.factories;
  factories.createFactory({
    ...stubFactorySeed(),
    slug: "harbor",
    name: "Harbor",
    foreman_handle: "tides",
  });
  assert.deepEqual(readFactoryName(factories, "  Web Shop "), {
    name: "Web Shop",
    slug: "web-shop",
    handle: "web-shop",
    available: true,
    message: null,
  });
  assert.deepEqual(readFactoryName(factories, "HARBOR"), {
    name: "HARBOR",
    slug: "harbor",
    handle: "harbor",
    available: false,
    message:
      'The slug "harbor" is taken by the factory Harbor. Choose another name.',
  });
  // The seeded default factory.
  assert.equal(readFactoryName(factories, "Default").available, false);
  assert.deepEqual(readFactoryName(factories, "Tides"), {
    name: "Tides",
    slug: "tides",
    handle: "tides",
    available: false,
    message:
      "The handle @tides is taken by the foreman of Harbor. Choose another name.",
  });
  assert.equal(
    readFactoryName(factories, " ").message,
    "Enter a factory name.",
  );
  assert.equal(readFactoryName(factories, "a".repeat(41)).available, false);
  store.db.close();
});

test("wizard API: gh status, repositories, token access and the name check", async () => {
  const config = loadConfig({});
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, config);
  const repos = [
    {
      nameWithOwner: "acme/widgets",
      isPrivate: true,
      primaryLanguage: { name: "Go" },
      updatedAt: "2026-10-01T00:00:00Z",
    },
  ];
  const gh: Gh = async (args) => {
    const command = args.slice(0, 2).join(" ");
    if (command === "auth status")
      return ok("  ✓ Logged in to github.com account alice (keyring)");
    // Without --paginate, gh lists only the first 30 organizations.
    if (command === "api user/orgs")
      return args.includes("--paginate") ? ok("acme") : ok("");
    if (command === "repo list")
      return args[2] === "acme"
        ? ok(JSON.stringify(repos))
        : args[2] === "garbled"
          ? ok("Welcome to GitHub CLI!")
          : failed("Could not resolve to a RepositoryOwner");
    return args[1] === "repos/acme/widgets" ? ok("true") : failed("HTTP 404");
  };
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "token",
    undefined,
    { gh, env: { NAKARA_AGENT_GH_TOKEN: "github_pat_x" } },
  );
  const get = async (path: string) => {
    const response = await app.request(
      `http://localhost/api/wizard/${path}`,
      {},
      {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      } as HttpBindings,
    );
    // biome-ignore lint/suspicious/noExplicitAny: Asserted field by field below.
    return { status: response.status, body: (await response.json()) as any };
  };

  assert.deepEqual(await get("github"), {
    status: 200,
    body: {
      login: { loggedIn: true, account: "alice", detail: "keyring" },
      owners: [
        { login: "alice", kind: "user" },
        { login: "acme", kind: "org" },
      ],
      agentToken: { state: "set", fineGrained: true },
    },
  });
  assert.deepEqual(await get("repos?owner=acme"), {
    status: 200,
    body: {
      owner: "acme",
      repos: [
        {
          repo: "acme/widgets",
          private: true,
          language: "Go",
          updatedAt: "2026-10-01T00:00:00Z",
        },
      ],
    },
  });
  const missing = await get("repos?owner=ghost");
  assert.equal(missing.status, 502);
  assert.equal(missing.body.error.code, "github");
  assert.deepEqual(await get("repos?owner=garbled"), {
    status: 502,
    body: {
      error: {
        code: "github",
        message: "gh repo list garbled did not return a repository list",
      },
    },
  });
  assert.equal((await get("repos?owner=-bad")).status, 400);
  assert.deepEqual(await get("access?repos=acme/widgets,acme/secret"), {
    status: 200,
    body: {
      repos: [
        { repo: "acme/widgets", visible: true, message: null },
        {
          repo: "acme/secret",
          visible: false,
          message: "The agent token can't see acme/secret.",
        },
      ],
      token: { source: "shared", variable: "NAKARA_AGENT_GH_TOKEN" },
    },
  });
  assert.equal(
    (await get("access?repos=acme/widgets&slug=Not_A_Slug")).status,
    400,
  );
  const invalid = await get("access?repos=not-a-repo");
  assert.equal(invalid.status, 400);
  assert.equal(invalid.body.error.code, "invalid_input");
  assert.deepEqual((await get("name?name=Default")).body, {
    name: "Default",
    slug: "default",
    handle: "default",
    available: false,
    message:
      'The slug "default" is taken by the factory Default. Choose another name.',
  });
  assert.equal((await get("name?name=Web%20Shop")).body.available, true);
  store.db.close();
});

test("wizard API: templates, a preview that writes nothing, and Create with its progress", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nakara-wizard-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = loadConfig({
    NAKARA_DATA_DIR: dataDir,
    NAKARA_GITHUB_MIRROR: "false",
  });
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const registry = new FactoryRegistry(store, config);
  const cloned: string[] = [];
  let failClone = () => {};
  const brokenClone = new Promise<void>((resolve) => {
    failClone = resolve;
  });
  const app = createApp(
    registry,
    new GithubPoller(registry.default),
    config,
    "token",
    undefined,
    {
      gh: async () => ok(""),
      env: {},
      scaffold: {
        cloneWarpExamples: async (dest) => {
          await mkdir(join(dest, "examples/01-bug-fix"), { recursive: true });
          await mkdir(join(dest, "examples/00-warp-default-agents"));
        },
      },
      clone: async (_cache, owner, name) => {
        if (name === "broken") {
          // Held until the test lets the clone fail.
          await brokenClone;
          throw new Error("Could not resolve host");
        }
        cloned.push(`${owner}/${name}`);
      },
    },
  );
  const call = async (path: string, json?: unknown) => {
    const response = await app.request(
      `http://localhost/api/wizard/${path}`,
      json === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(json),
          },
      {
        incoming: { socket: { remoteAddress: "127.0.0.1" } },
      } as HttpBindings,
    );
    // biome-ignore lint/suspicious/noExplicitAny: Asserted field by field below.
    return { status: response.status, body: (await response.json()) as any };
  };

  assert.deepEqual((await call("examples")).body, {
    examples: ["00-warp-default-agents", "01-bug-fix"],
  });
  const nakara = await call("template?kind=nakara");
  assert.deepEqual(
    nakara.body.agents.map((a: { name: string; role: string }) => [
      a.name,
      a.role,
    ]),
    [
      ["foreman", "foreman"],
      ["triage", "triage"],
      ["spec", "spec"],
      ["implement", "implement"],
      ["review", "review"],
      // No wizard role: it comes along as an agent of the template.
      ["reflect", null],
    ],
  );
  assert.deepEqual(nakara.body.intake, {
    github: false,
    telegram: false,
    schedule: null,
  });
  const missing = await call(`template?kind=import&from=${dataDir}/nothing`);
  assert.equal(missing.status, 422);
  assert.match(
    missing.body.error.message,
    /nothing is not a folder Nakara can read/,
  );
  assert.equal((await call("template?kind=import&from=relative")).status, 400);

  const input = {
    name: "Web Shop",
    avatarColor: "#0E7490",
    repositories: ["acme/shop"],
    template: { kind: "blank" },
    location: { mode: "managed" },
    agents: { triage: { enabled: false } },
    intake: { github: true, telegram: true, schedule: { cron: "@daily" } },
  };
  const preview = await call("preview", input);
  assert.deepEqual(preview.body, {
    ok: true,
    files: [
      "agents/foreman/agent.md",
      "automations/issue-labeled/automation.md",
      "automations/scheduled/automation.md",
      "automations/telegram-request/automation.md",
      "factory.yaml",
    ],
    dir: join(dataDir, "factories/web-shop"),
    label: "factory:Web Shop",
    errors: [],
    warnings: [],
  });
  // Leaving the wizard before Create writes nothing.
  assert.deepEqual(await readdir(dataDir), []);
  const taken = await call("preview", { ...input, handle: "default" });
  assert.equal(taken.body.ok, false);
  assert.equal(
    taken.body.errors[0].message,
    "The handle @default is taken by Default. Choose another handle.",
  );
  assert.equal(
    (
      await call("preview", {
        ...input,
        intake: { ...input.intake, schedule: { cron: "every day" } },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await call("preview", {
        ...input,
        location: { mode: "repo", repo: "acme/other", folder: "factory" },
      })
    ).status,
    400,
  );

  assert.deepEqual(await call("creations", { ...input, name: "Default" }), {
    status: 409,
    body: {
      error: {
        code: "policy",
        message:
          'The slug "default" is taken by the factory Default. Choose another name.',
      },
    },
  });
  const created = await call("creations", input);
  assert.equal(created.status, 202);
  assert.equal(created.body.slug, "web-shop");
  const id = created.body.id;
  for (let i = 0; i < 200; i++) {
    if ((await call(`creations/${id}`)).body.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const done = await call(`creations/${id}`);
  assert.equal(done.body.status, "done", JSON.stringify(done.body.steps));
  assert.deepEqual(cloned, ["acme/shop"]);
  assert.equal(registry.get("web-shop")?.record?.avatar_color, "#0e7490");
  assert.equal((await call(`creations/${id}/retry`, {})).status, 409);
  assert.equal((await call("creations/not-a-uuid")).status, 400);
  assert.equal(
    (await call("creations/00000000-0000-4000-8000-000000000000")).status,
    404,
  );

  // A running job holds its slug; once it failed, Create replaces it.
  const broken = {
    ...input,
    name: "Broken Shop",
    repositories: ["acme/broken"],
  };
  const failing = await call("creations", broken);
  assert.equal(failing.status, 202);
  const again = await call("creations", broken);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "policy");
  assert.match(
    again.body.error.message,
    /^Broken Shop is being created in .+; wait for it to finish\.$/,
  );
  failClone();
  for (let i = 0; i < 200; i++) {
    if ((await call(`creations/${failing.body.id}`)).body.status !== "running")
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(
    (await call(`creations/${failing.body.id}`)).body.status,
    "failed",
  );
  const replaced = await call("creations", broken);
  assert.equal(replaced.status, 202);
  assert.equal((await call(`creations/${failing.body.id}`)).status, 404);
  for (let i = 0; i < 200; i++) {
    if ((await call(`creations/${replaced.body.id}`)).body.status !== "running")
      break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The new job got past the write the old one had done, then failed at the clone again.
  const replacedSteps = (await call(`creations/${replaced.body.id}`)).body
    .steps;
  assert.deepEqual(
    replacedSteps.map((step: { status: string }) => step.status),
    ["done", "done", "failed", "pending", "pending"],
  );

  // Create stays disabled where Validate would refuse: another factory owns the repository.
  await registry.default.start();
  const [owned] = registry.default.definition?.factory.repositories ?? [];
  assert.ok(owned);
  const owner = await call("preview", {
    ...input,
    name: "Other Shop",
    repositories: [`${owned.owner}/${owned.name}`],
  });
  assert.equal(owner.body.ok, false);
  assert.deepEqual(owner.body.errors, [
    {
      path: "factory.yaml",
      line: null,
      message: `repository ${owned.owner}/${owned.name} is already owned by the factory "Default"`,
    },
  ]);
  store.db.close();
});
