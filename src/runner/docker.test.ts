import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  agentCredentials,
  credentialWarning,
  foremanTokenWarning,
  dockerSupportsEgress,
  dockerize,
  runLabels,
  sweepContainers,
  ensureEgress,
} from "./docker.ts";
import { run } from "./workspace.ts";

test("dockerize mounts at host paths and keeps secrets out of argv", () => {
  const c = dockerize(
    { image: "img", mounts: ["/w/item-1"], home: "/w/item-1.home" },
    process.execPath,
    "/w/item-1",
    ["claude", "-p"],
    {
      GH_TOKEN: "secret",
    },
  );
  assert.equal(c.cmd, "docker");
  assert.ok(c.args.includes("/w/item-1:/w/item-1"));
  assert.ok(c.args.includes("/w/item-1.home:/w/item-1.home"));
  assert.ok(!c.args.join(" ").includes("secret"));
  assert.equal(c.env.GH_TOKEN, "secret");
  assert.ok(c.args.includes("--cap-drop=ALL"));
  assert.ok(c.args.includes("--security-opt=no-new-privileges"));
  assert.deepEqual(c.args.slice(-3), ["img", "claude", "-p"]);
});

test("dockerize puts the container on the egress network behind its proxy", () => {
  const c = dockerize(
    {
      image: "img",
      mounts: [],
      home: "/h",
      egress: {
        network: "nakara-egress-x",
        proxy: "http://egress-proxy:3128",
      },
    },
    process.execPath,
    "/w",
    ["claude"],
    {},
  );
  const network = c.args.indexOf("--network");
  assert.equal(c.args[network + 1], "nakara-egress-x");
  assert.equal(c.env.HTTPS_PROXY, "http://egress-proxy:3128");
  assert.equal(c.env.https_proxy, "http://egress-proxy:3128");
  assert.ok(c.args.includes("HTTPS_PROXY"));
});

/** Run `fn` with these variables set (undefined deletes), then restore them. */
async function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => Promise<T> | T,
): Promise<T> {
  const saved = Object.fromEntries(
    Object.keys(vars).map((k) => [k, process.env[k]]),
  );
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, value] of Object.entries(v))
      if (value === undefined) delete process.env[k];
      else process.env[k] = value;
  };
  apply(vars);
  try {
    return await fn();
  } finally {
    apply(saved);
  }
}

test("a docker agent run without NAKARA_AGENT_GH_TOKEN fails closed", async () => {
  await withEnv(
    {
      NAKARA_AGENT_GH_TOKEN: undefined,
      NAKARA_ALLOW_PERSONAL_GH_TOKEN: undefined,
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    },
    async () => {
      await assert.rejects(
        agentCredentials("claude"),
        /needs NAKARA_AGENT_GH_TOKEN.*NAKARA_ALLOW_PERSONAL_GH_TOKEN=1/,
      );
      assert.equal(credentialWarning(), null);
    },
  );
});

test("the agent token is used as is, and the personal-token opt-in is flagged", async () => {
  await withEnv(
    {
      NAKARA_AGENT_GH_TOKEN: "agent-token",
      NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    },
    async () => {
      assert.equal((await agentCredentials("claude")).GH_TOKEN, "agent-token");
      assert.equal(credentialWarning(), null);
    },
  );
  await withEnv(
    { NAKARA_AGENT_GH_TOKEN: undefined, NAKARA_ALLOW_PERSONAL_GH_TOKEN: "1" },
    () => assert.match(credentialWarning() ?? "", /personal gh token/),
  );
});

test("the foreman uses its read-only token and no other; unset, it falls back to the agent token with a warning", async () => {
  await withEnv(
    {
      NAKARA_FOREMAN_GH_TOKEN: "read-only",
      NAKARA_AGENT_GH_TOKEN: "agent-token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    },
    async () => {
      const foreman = await agentCredentials("claude", "foreman");
      assert.equal(foreman.GH_TOKEN, "read-only");
      assert.ok(!Object.values(foreman).includes("agent-token"));
      // Agents keep theirs.
      assert.equal((await agentCredentials("claude")).GH_TOKEN, "agent-token");
      assert.equal(foremanTokenWarning(), null);
    },
  );
  await withEnv(
    {
      NAKARA_FOREMAN_GH_TOKEN: undefined,
      NAKARA_AGENT_GH_TOKEN: "agent-token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
    },
    async () => {
      assert.equal(
        (await agentCredentials("claude", "foreman")).GH_TOKEN,
        "agent-token",
      );
      assert.match(foremanTokenWarning() ?? "", /NAKARA_FOREMAN_GH_TOKEN/);
    },
  );
});

/** A scripted `docker` CLI: state lives in files under `dir`, calls go to `dir/log`. */
async function fakeDocker(dir: string) {
  const bin = join(dir, "docker");
  await writeFile(
    bin,
    `#!/bin/sh
echo "$1 $2" >> "${dir}/log"
case "$1 $2" in
  "version --format") cat "${dir}/version" 2>/dev/null || echo 29.4.1 ;;
  "network inspect") [ -f "${dir}/net" ] || exit 1 ;;
  "network create") touch "${dir}/net" ;;
  "network connect")
    if [ -f "${dir}/connect-fails" ]; then echo "Error: boom" >&2; exit 1; fi
    touch "${dir}/connected" ;;
  "inspect --format") [ -f "${dir}/proxy" ] && echo true || exit 1 ;;
  "rm --force") rm -f "${dir}/proxy" "${dir}/connected" ;;
  "run --detach")
    if [ -f "${dir}/proxy" ]; then echo "Conflict. The container name is already in use" >&2; exit 1; fi
    touch "${dir}/proxy" ;;
  "run --rm") [ -f "${dir}/connected" ] || exit 1 ;;
esac
`,
  );
  await chmod(bin, 0o755);
  const log = async () =>
    (await readFile(join(dir, "log"), "utf8").catch(() => ""))
      .trim()
      .split("\n");
  return log;
}

test("ensureEgress sets up the network and proxy and waits until it is reachable", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-docker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await fakeDocker(dir);
  await withEnv({ PATH: `${dir}:${process.env.PATH}` }, async () => {
    const egress = await ensureEgress(["a.example.com"], "img");
    assert.match(egress.network, /^nakara-egress-[0-9a-f]{12}$/);
    assert.equal(egress.proxy, "http://egress-proxy:3128");
    assert.deepEqual(await log(), [
      "version --format",
      "network inspect",
      "network create",
      "inspect --format",
      "rm --force",
      "run --detach",
      "network connect",
      "run --rm",
    ]);
  });
});

test("a proxy that is running but off the network is replaced", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-docker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await fakeDocker(dir);
  await writeFile(join(dir, "net"), "");
  await writeFile(join(dir, "proxy"), "");
  await withEnv({ PATH: `${dir}:${process.env.PATH}` }, async () => {
    await ensureEgress(["b.example.com"], "img");
    assert.deepEqual((await log()).slice(3), [
      "run --rm",
      "rm --force",
      "run --detach",
      "network connect",
      "run --rm",
    ]);
  });
});

test("a failed network connect removes the proxy and fails the run", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-docker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await fakeDocker(dir);
  await writeFile(join(dir, "connect-fails"), "");
  await withEnv({ PATH: `${dir}:${process.env.PATH}` }, async () => {
    await assert.rejects(ensureEgress(["c.example.com"], "img"), /boom/);
  });
  assert.equal(existsSync(join(dir, "proxy")), false);
});

test("Docker before v26 is refused before any network is created", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-docker-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = await fakeDocker(dir);
  await writeFile(join(dir, "version"), "25.0.5\n");
  await withEnv({ PATH: `${dir}:${process.env.PATH}` }, async () => {
    await assert.rejects(
      ensureEgress(["d.example.com"], "img"),
      /Docker 25\.0\.5 is too old/,
    );
    assert.deepEqual(await log(), ["version --format"]);
  });
});

const hasDocker = await run("docker", ["version"], undefined, 10_000).then(
  () => true,
  () => false,
);

// Outbound access from inside a real container: no route except the proxy,
// and the proxy refuses hosts off the allowlist.
test("an agent container reaches only allowlisted hosts", {
  skip: !hasDocker && "docker is not available",
  timeout: 300_000,
}, async () => {
  const image = process.env.NAKARA_TEST_DOCKER_IMAGE ?? "node:24-bookworm-slim";
  const egress = await ensureEgress(["registry.npmjs.org"], image);
  try {
    const script = `
        const http = require("node:http"), net = require("node:net"), dns = require("node:dns");
        const via = (host) => new Promise((done) => {
          const req = http.request({ host: "egress-proxy", port: 3128, method: "CONNECT", path: host + ":443" });
          req.on("connect", (res, socket) => { socket.destroy(); done(res.statusCode); });
          req.on("response", (res) => done(res.statusCode));
          req.on("error", (e) => done(e.code));
          req.end();
        });
        const direct = (host) => new Promise((done) => {
          const s = net.connect(443, host, () => { s.destroy(); done("open"); });
          s.setTimeout(5000, () => { s.destroy(); done("timeout"); });
          s.on("error", (e) => done(e.code));
        });
        const resolve = (host) => new Promise((done) =>
          dns.lookup(host, (e) => done(e ? e.code : "resolved")));
        (async () => console.log(JSON.stringify({
          dns: await resolve("example.com"),
          allowed: await via("registry.npmjs.org"),
          denied: await via("example.com"),
          direct: await direct("example.com"),
        })))();`;
    const out = await run(
      "docker",
      ["run", "--rm", "--network", egress.network, image, "node", "-e", script],
      undefined,
      120_000,
    );
    const result = JSON.parse(out.split("\n").at(-1) ?? "");
    assert.equal(result.allowed, 200);
    assert.equal(result.denied, 403);
    assert.notEqual(result.direct, "open");
    // External names do not resolve from the agent network either.
    assert.notEqual(result.dns, "resolved");
  } finally {
    await run("docker", ["rm", "--force", `${egress.network}-proxy`]).catch(
      () => undefined,
    );
    await run("docker", ["network", "rm", egress.network]).catch(
      () => undefined,
    );
  }
});

test("the egress allowlist needs Docker 26 or later", () => {
  assert.equal(dockerSupportsEgress("29.4.1\n"), true);
  assert.equal(dockerSupportsEgress("26.0.0"), true);
  assert.equal(dockerSupportsEgress("25.0.5"), false);
  assert.equal(dockerSupportsEgress(null), false);
  assert.equal(dockerSupportsEgress(""), false);
});
