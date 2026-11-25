import assert from "node:assert/strict";
import { test } from "node:test";

import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { loadDefinition } from "../definition/load.ts";
import {
  readSetup,
  type SetupProbes,
  type VerifyProbes,
  verifyGithubToken,
} from "./setup.ts";

async function bundled() {
  const result = await loadDefinition("factory", {
    kind: "claude",
    model: undefined,
  });
  if (!result.ok) throw new Error("the bundled factory must load");
  return result.definition;
}

const probes = (
  over: Partial<SetupProbes> & { images?: string[]; version?: string },
): SetupProbes => ({
  docker: async (args) => {
    if (args[0] === "version") {
      if (over.version === "down") throw new Error("Cannot connect");
      return `${over.version ?? "27.0.1"}\n`;
    }
    if (
      !(over.images ?? ["nakara-agent", "nakara-agent-browser"]).includes(
        args.at(-1) ?? "",
      )
    )
      throw new Error("No such image");
    return "sha256:abc";
  },
  env: over.env ?? {},
  now: () => Date.parse("2026-11-17T12:00:00Z"),
});

const config = loadConfig({});
const check = (dto: Awaited<ReturnType<typeof readSetup>>, id: string) =>
  dto.checks.find((c) => c.id === id);

async function input(
  over: Partial<Parameters<typeof readSetup>[0]> = {},
): Promise<Parameters<typeof readSetup>[0]> {
  return {
    store: new Store(":memory:", { defaultBudgetUsd: 15 }),
    config,
    factories: [{ slug: "box", definition: await bundled(), errors: 0 }],
    poll: null,
    ...over,
  };
}

test("setup reports a missing image, missing tokens and the way to fix each", async () => {
  const dto = await readSetup(await input(), probes({ images: [] }));
  assert.equal(check(dto, "docker")?.state, "ok");
  const image = check(dto, "image:nakara-agent");
  assert.equal(image?.state, "fail");
  assert.match(image?.fix ?? "", /docker build -t nakara-agent -f/);
  assert.match(
    check(dto, "image:nakara-agent-browser")?.fix ?? "",
    /docker build -t nakara-agent-browser -f deploy\/agent-browser\.Dockerfile/,
  );
  assert.equal(check(dto, "agent-token")?.state, "fail");
  assert.equal(check(dto, "foreman-token")?.state, "warn");
  assert.equal(check(dto, "claude-token")?.state, "fail");
  assert.equal(check(dto, "foreman:box")?.state, "ok");
  assert.equal(check(dto, "github-poll")?.state, "warn");
  assert.equal(dto.counts.fail, 4);
});

test("setup is green with the tokens set, and never carries a token's value", async () => {
  const env = {
    NAKARA_AGENT_GH_TOKEN: "ghp_secret_agent",
    NAKARA_FOREMAN_GH_TOKEN: "ghp_secret_foreman",
    CLAUDE_CODE_OAUTH_TOKEN: "oauth_secret",
  };
  const dto = await readSetup(
    await input({ poll: { at: "2026-11-17T11:59:00Z", error: null } }),
    probes({ env }),
  );
  assert.equal(dto.counts.fail, 0);
  for (const id of ["agent-token", "foreman-token", "claude-token"])
    assert.equal(check(dto, id)?.state, "ok");
  const text = JSON.stringify(dto);
  for (const value of Object.values(env)) assert.ok(!text.includes(value));
});

test("setup flags an unreachable or too old Docker, a failed poll and a broken definition", async () => {
  const down = await readSetup(await input(), probes({ version: "down" }));
  assert.equal(check(down, "docker")?.state, "fail");
  assert.equal(check(down, "image:nakara-agent")?.state, "warn");

  const old = await readSetup(await input(), probes({ version: "25.0.0" }));
  assert.match(check(old, "docker")?.fix ?? "", /v26/);

  const broken = await readSetup(
    await input({
      factories: [{ slug: "box", definition: undefined, errors: 2 }],
      poll: { at: "2026-11-17T11:00:00Z", error: "HTTP 401" },
    }),
    probes({}),
  );
  assert.equal(check(broken, "definition:box")?.state, "fail");
  assert.match(check(broken, "definition:box")?.detail ?? "", /2 errors/);
  assert.match(check(broken, "github-poll")?.detail ?? "", /HTTP 401/);
});

test("setup warns when the host foreman opt-in is on", async () => {
  const dto = await readSetup(
    await input(),
    probes({ env: { NAKARA_ALLOW_HOST_FOREMAN: "1" } }),
  );
  assert.equal(check(dto, "host-foreman")?.state, "warn");
});

/** A GitHub that answers per repository: status and `permissions.push`. */
const github = (
  answers: Record<string, { status: number; push?: boolean }>,
  seen: { url: string; auth: string | null }[] = [],
  env: NodeJS.ProcessEnv = {
    NAKARA_AGENT_GH_TOKEN: "ghp_agent_secret",
    NAKARA_FOREMAN_GH_TOKEN: "ghp_foreman_secret",
  },
): VerifyProbes => ({
  env,
  fetch: async (input, init) => {
    const url = String(input);
    seen.push({
      url,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const a = answers[url.replace("https://api.github.com", "")] ?? {
      status: 404,
    };
    return new Response(
      JSON.stringify(
        a.status === 200 ? { permissions: { push: a.push ?? false } } : {},
      ),
      { status: a.status },
    );
  },
});

test("verifying a token asks GitHub per repository and reports what it reaches", async () => {
  const seen: { url: string; auth: string | null }[] = [];
  const ok = await verifyGithubToken(
    "agent",
    ["o/a", "o/b"],
    github(
      {
        "/repos/o/a": { status: 200, push: true },
        "/repos/o/b": { status: 200, push: true },
      },
      seen,
    ),
  );
  assert.equal(ok.state, "ok");
  assert.equal(ok.repos.length, 2);
  // The token goes to GitHub only, and never into the result.
  assert.ok(seen.every((r) => r.auth === "Bearer ghp_agent_secret"));
  assert.ok(!JSON.stringify(ok).includes("ghp_agent_secret"));

  const lost = await verifyGithubToken(
    "agent",
    ["o/a", "o/b"],
    github({ "/repos/o/a": { status: 200, push: true } }),
  );
  assert.equal(lost.state, "fail");
  assert.match(lost.detail, /cannot reach o\/b/);

  const rejected = await verifyGithubToken(
    "agent",
    ["o/a"],
    github({ "/repos/o/a": { status: 401 } }),
  );
  assert.equal(rejected.state, "fail");
  assert.match(rejected.detail, /401/);
});

test("verifying warns when the agent token cannot push or the foreman token can", async () => {
  const agent = await verifyGithubToken(
    "agent",
    ["o/a"],
    github({ "/repos/o/a": { status: 200, push: false } }),
  );
  assert.equal(agent.state, "warn");
  assert.match(agent.detail, /no push access on o\/a/);

  const foreman = await verifyGithubToken(
    "foreman",
    ["o/a"],
    github({ "/repos/o/a": { status: 200, push: true } }),
  );
  assert.equal(foreman.state, "warn");
  assert.match(foreman.detail, /may not be a read-only token/);

  const readOnly = await verifyGithubToken(
    "foreman",
    ["o/a"],
    github({ "/repos/o/a": { status: 200, push: false } }),
  );
  assert.equal(readOnly.state, "ok");
});

test("verifying says so when the token is not set or GitHub cannot be reached", async () => {
  const unset = await verifyGithubToken("foreman", ["o/a"], github({}, [], {}));
  assert.equal(unset.state, "fail");
  assert.match(unset.detail, /NAKARA_FOREMAN_GH_TOKEN is not set/);

  const offline = await verifyGithubToken("agent", ["o/a"], {
    env: { NAKARA_AGENT_GH_TOKEN: "x" },
    fetch: async () => {
      throw new Error("getaddrinfo ENOTFOUND api.github.com");
    },
  });
  assert.equal(offline.state, "fail");
  assert.match(offline.detail, /Could not ask GitHub/);
});
