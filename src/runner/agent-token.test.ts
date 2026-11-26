import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../db.ts";
import { loadDefinition } from "../definition/load.ts";
import {
  agentTokenOf,
  agentTokenSecret,
  agentTokenWarnings,
  checkAgentToken,
  factoryTokenVariable,
  type Gh,
  readAgentTokenCheck,
} from "./agent-token.ts";

test("a factory's own variable: the slug upper-cased, - as _, after a double underscore", () => {
  assert.equal(factoryTokenVariable("acme"), "NAKARA_AGENT_GH_TOKEN__ACME");
  assert.equal(
    factoryTokenVariable("client-app-2"),
    "NAKARA_AGENT_GH_TOKEN__CLIENT_APP_2",
  );
  // Slugs are a-z, 0-9 and -, so distinct slugs never share a variable.
  const slugs = ["a-b", "ab", "a--b", "a-b-", "a"];
  assert.equal(new Set(slugs.map(factoryTokenVariable)).size, slugs.length);
});

test("the own token, else the shared one, else the personal opt-in, else none", () => {
  const env = {
    NAKARA_AGENT_GH_TOKEN: "shared",
    NAKARA_AGENT_GH_TOKEN__CLIENT: "client",
    NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1",
  };
  assert.deepEqual(agentTokenOf("client", env), {
    source: "own",
    variable: "NAKARA_AGENT_GH_TOKEN__CLIENT",
  });
  assert.equal(agentTokenSecret("client", env), "client");
  assert.deepEqual(agentTokenOf("acme", env), {
    source: "shared",
    variable: "NAKARA_AGENT_GH_TOKEN",
  });
  assert.equal(agentTokenSecret("acme", env), "shared");
  // A standalone factory has no slug and so no own token.
  assert.equal(agentTokenOf(undefined, env).source, "shared");
  // An empty value counts as unset.
  assert.equal(
    agentTokenOf("client", { ...env, NAKARA_AGENT_GH_TOKEN__CLIENT: "" })
      .source,
    "shared",
  );
  assert.deepEqual(
    agentTokenOf("acme", { NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1" }),
    { source: "personal", variable: null },
  );
  assert.equal(
    agentTokenSecret("acme", { NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1" }),
    undefined,
  );
  assert.deepEqual(agentTokenOf("acme", {}), {
    source: "none",
    variable: null,
  });
});

test("the token check records the repositories the token cannot push to, never the token", async () => {
  const loaded = await loadDefinition("factory", {
    kind: "claude",
    model: undefined,
  });
  if (!loaded.ok) throw new Error("the bundled factory must load");
  const def = {
    ...loaded.definition,
    factory: {
      ...loaded.definition.factory,
      repositories: [
        { owner: "acme", name: "app" },
        { owner: "client", name: "app" },
        { owner: "acme", name: "later", deferred: true },
      ],
    },
  } as typeof loaded.definition;
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  const seen: { repo: string | undefined; token: string | undefined }[] = [];
  const gh: Gh = async (args, env) => {
    seen.push({ repo: args[1], token: env?.GH_TOKEN });
    return args[1] === "repos/client/app"
      ? { ok: false, stdout: "", stderr: "gh: Not Found (HTTP 404)" }
      : { ok: true, stdout: "true\n", stderr: "" };
  };
  const env = { NAKARA_AGENT_GH_TOKEN__BOX: "github_pat_box_secret" };
  await checkAgentToken(store, "box", def, gh, env);
  // The factory's own token, and no deferred repository.
  assert.deepEqual(seen, [
    { repo: "repos/acme/app", token: "github_pat_box_secret" },
    { repo: "repos/client/app", token: "github_pat_box_secret" },
  ]);
  const check = readAgentTokenCheck(store, "box");
  assert.equal(check?.source, "own");
  assert.deepEqual(check?.problems, ["The agent token can't see client/app."]);
  assert.ok(!(store.getKv("agent-token:box") ?? "").includes("secret"));
  const [warning] = agentTokenWarnings(store, "box", env);
  assert.match(
    warning ?? "",
    /can't see client\/app.*Agents of box could not push/,
  );
  // Once the factory runs with another token, the old finding no longer applies.
  assert.deepEqual(
    agentTokenWarnings(store, "box", { NAKARA_AGENT_GH_TOKEN: "x" }),
    [],
  );
  // Factories record their checks apart.
  assert.equal(readAgentTokenCheck(store, "other"), null);
});
