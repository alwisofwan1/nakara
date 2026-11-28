import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import type { Definition } from "../definition/load.ts";
import type { RunnerFile } from "../definition/schema.ts";
import {
  runVerify,
  type VerifyDocker,
  type VerifyJob,
  type VerifyOutcome,
} from "./verify.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const RUNNERS: Record<string, RunnerFile> = {
  std: {
    platform: { os: "linux", linux: { dockerImage: "nakara-agent:test" } },
    egress: { allow: ["registry.npmjs.org", "github.com"] },
    instanceShape: { vcpus: 2, memoryGb: 4 },
  },
  local: { description: "no image: agents run on the host" },
};

const NETWORK = "nakara-egress-0123456789ab";
const PROXY = "http://egress-proxy:3128";

/** What a stubbed `docker run` does with one command. */
type Behaviour =
  | { code: number; output?: string }
  | "reject"
  | "hang"
  | ((cwd: string) => { code: number; output?: string });

/**
 * A repository cache for acme/widgets whose origin is a local seed with two
 * commits, and Docker stubbed at the process boundary: the checkout is real,
 * every container is recorded instead of started.
 */
function fixture(t: TestContext, behave: (command: string) => Behaviour) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-verify-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const seed = join(dir, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  const commit = (text: string) => {
    writeFileSync(join(seed, "README.md"), text);
    git(seed, "add", ".");
    git(
      seed,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      text,
    );
    return git(seed, "rev-parse", "HEAD");
  };
  commit("v1\n");
  const head = commit("v2\n");
  const repoCacheDir = join(dir, "repos");
  const cache = join(repoCacheDir, "acme", "widgets.git");
  git(dir, "clone", "--bare", "--quiet", seed, cache);
  git(
    cache,
    "config",
    "remote.origin.fetch",
    "+refs/heads/*:refs/remotes/origin/*",
  );
  const logs = join(dir, "work", "item-1.nakara", "logs");
  mkdirSync(logs, { recursive: true });

  const runs: { cmd: string; args: string[]; env: Record<string, string> }[] =
    [];
  const egress: [string[], string][] = [];
  const removed: string[] = [];
  let egressFails = false;
  const docker: VerifyDocker = {
    ensureEgress: async (allow, image) => {
      egress.push([allow, image]);
      if (egressFails) throw new Error("Cannot connect to the Docker daemon");
      return { network: NETWORK, proxy: PROXY, allow };
    },
    removeContainer: async (name) => {
      removed.push(name);
    },
    run: async (p) => {
      runs.push({ cmd: p.cmd, args: p.args, env: p.env });
      const command = p.args.at(-1) ?? "";
      const cwd = p.args[p.args.indexOf("-w") + 1] ?? "";
      let b = behave(command);
      if (typeof b === "function") b = b(cwd);
      if (b === "reject") throw new Error("spawn docker ENOENT");
      if (b === "hang")
        return new Promise((resolve) =>
          p.signal.addEventListener("abort", () => resolve(null), {
            once: true,
          }),
        );
      if (b.output) p.onOutput(b.output);
      return b.code;
    },
  };
  const job = (over: Partial<VerifyJob> = {}): VerifyJob => ({
    def: { runners: new Map(Object.entries(RUNNERS)) } as unknown as Definition,
    itemId: 1,
    runId: 7,
    owner: "acme",
    name: "widgets",
    head,
    commands: [],
    runner: "std",
    timeoutMs: 60_000,
    dirs: { workDir: join(dir, "work"), repoCacheDir, dataDir: dir },
    logPath: join(logs, "run-7.verify.log"),
    ...over,
  });
  return {
    dir,
    head,
    cache,
    root: join(dir, "work", "item-1.verify"),
    runs,
    egress,
    removed,
    failEgress: () => {
      egressFails = true;
    },
    verify: (over: Partial<VerifyJob> = {}): Promise<VerifyOutcome> =>
      runVerify(job(over), docker),
    log: () => readFileSync(job().logPath, "utf8"),
  };
}

/** The values of `flag` in docker args, e.g. every `-v`. */
const values = (args: string[], flag: string) =>
  args.flatMap((a, i) => (a === flag ? [args[i + 1] ?? ""] : []));

test("each verify command runs in its own fresh container of the runner's image, behind its egress and limits, with no token, session or secret", async (t) => {
  const secret = `ghp_${"s".repeat(36)}`;
  const saved = { ...process.env };
  t.after(() => {
    process.env = saved;
  });
  Object.assign(process.env, {
    GH_TOKEN: secret,
    NAKARA_AGENT_GH_TOKEN: secret,
    CLAUDE_CODE_OAUTH_TOKEN: secret,
    ANTHROPIC_API_KEY: secret,
    DOCKER_HOST: "unix:///run/docker.sock",
  });
  const seen: string[] = [];
  const f = fixture(t, () => (cwd) => {
    // The checkout exists while the container runs, at the PR head.
    seen.push(readFileSync(join(cwd, "README.md"), "utf8"));
    return { code: 0, output: "ok\n" };
  });
  const outcome = await f.verify({ commands: ["npm ci", "npm test"] });
  assert.equal(outcome.status, "passed", JSON.stringify(outcome));
  assert.deepEqual(
    outcome.commands.map((c) => [c.command, c.ok]),
    [
      ["npm ci", true],
      ["npm test", true],
    ],
  );
  assert.deepEqual(seen, ["v2\n", "v2\n"]);
  // The runner's egress allowlist and image, once.
  assert.deepEqual(f.egress, [
    [["registry.npmjs.org", "github.com"], "nakara-agent:test"],
  ]);
  // One fresh container per command.
  assert.equal(f.runs.length, 2);
  const checkout = join(f.root, "widgets");
  for (const [i, { cmd, args, env }] of f.runs.entries()) {
    assert.equal(cmd, "docker");
    assert.deepEqual(args.slice(0, 5), [
      "run",
      "--rm",
      "--init",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
    ]);
    assert.deepEqual(values(args, "--name"), [`nakara-verify-7-${i + 1}`]);
    assert.deepEqual(values(args, "--label"), [
      "nakara.run=7",
      `nakara.instance=${f.dir}`,
      "nakara.verify=1",
    ]);
    assert.deepEqual(values(args, "--network"), [NETWORK]);
    assert.deepEqual(values(args, "--cpus"), ["2"]);
    assert.deepEqual(values(args, "--memory"), ["4g"]);
    assert.deepEqual(values(args, "-w"), [checkout]);
    // Only the verify directory, and the cache read-only: no item clone, no definition, no claude.
    assert.deepEqual(values(args, "-v"), [
      `${f.root}:${f.root}`,
      `${f.cache}:${f.cache}:ro`,
    ]);
    assert.deepEqual(values(args, "-e"), [
      `HOME=${join(f.root, ".home")}`,
      `HTTPS_PROXY=${PROXY}`,
      `https_proxy=${PROXY}`,
      `HTTP_PROXY=${PROXY}`,
      `http_proxy=${PROXY}`,
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
      "NODE_USE_ENV_PROXY=1",
    ]);
    assert.deepEqual(args.slice(-4), [
      "nakara-agent:test",
      "bash",
      "-lc",
      i === 0 ? "npm ci" : "npm test",
    ]);
    // No secret anywhere, and the docker CLI sees only how to reach Docker.
    assert.doesNotMatch(JSON.stringify({ args, env }), new RegExp(secret));
    assert.doesNotMatch(args.join(" "), /claude|session|TOKEN|API_KEY/i);
    for (const key of Object.keys(env))
      assert.match(key, /^(PATH|HOME|DOCKER_\w+)$/, key);
    assert.equal(env.DOCKER_HOST, "unix:///run/docker.sock");
  }
  assert.match(f.log(), /\$ npm ci\nok\n/);
  // The checkout is gone once the verify ends.
  assert.equal(existsSync(f.root), false);
});

test("verify stops at the first failing command and returns the tail of its output, redacted", async (t) => {
  const token = `ghp_${"a".repeat(36)}`;
  const output = `${Array.from({ length: 300 }, (_, i) => i + 1).join("\n")}\n${token}\n`;
  const f = fixture(t, (command) =>
    command === "npm test" ? { code: 3, output } : { code: 0 },
  );
  const outcome = await f.verify({
    commands: ["npm ci", "npm test", "npm run lint"],
  });
  assert.equal(outcome.status, "failed");
  assert.equal(outcome.failed, "npm test");
  assert.deepEqual(
    outcome.commands.map((c) => c.ok),
    [true, false],
  );
  assert.equal(f.runs.length, 2, "npm run lint never ran");
  const lines = outcome.tail?.split("\n") ?? [];
  assert.equal(lines.length, 200);
  assert.equal(lines[0], "102");
  assert.equal(lines.at(-1), "[redacted]");
  assert.doesNotMatch(f.log(), /ghp_a/);
});

test("a container that could not start, or no Docker, is a verify that could not run", async (t) => {
  const start = fixture(t, () => ({
    code: 125,
    output:
      "docker: Error response from daemon: pull access denied for nakara-agent:test.\n",
  }));
  const notStarted = await start.verify({ commands: ["npm test"] });
  assert.equal(notStarted.status, "error");
  assert.match(
    notStarted.reason ?? "",
    /Docker could not start the std container: .*pull access denied/,
  );
  assert.deepEqual(notStarted.commands, []);

  const missing = fixture(t, () => "reject");
  const noDocker = await missing.verify({ commands: ["npm test"] });
  assert.equal(noDocker.status, "error");
  assert.match(noDocker.reason ?? "", /Docker is not available/);

  const daemon = fixture(t, () => ({ code: 0 }));
  daemon.failEgress();
  const noDaemon = await daemon.verify({ commands: ["npm test"] });
  assert.equal(noDaemon.status, "error");
  assert.match(noDaemon.reason ?? "", /Cannot connect to the Docker daemon/);
  assert.equal(daemon.runs.length, 0);
});

test("verify never runs on the host: no runner, or a runner without a dockerImage, could not run", async (t) => {
  const f = fixture(t, () => ({ code: 0 }));
  for (const [runner, reason] of [
    [undefined, /no runner: Nakara runs verify commands only in a container/],
    ["local", /runner "local" has no dockerImage.*never on the host/],
    ["gone", /runner "gone" is not in the definition/],
  ] as const) {
    const outcome = await f.verify({ commands: ["npm test"], runner });
    assert.equal(outcome.status, "error", runner);
    assert.match(outcome.reason ?? "", reason);
  }
  assert.equal(f.runs.length, 0);
  assert.equal(f.egress.length, 0);
});

test("a verify that times out removes its container and could not run; so does an unknown head", async (t) => {
  const f = fixture(t, () => "hang");
  const slow = await f.verify({ commands: ["sleep 600"], timeoutMs: 100 });
  assert.equal(slow.status, "error");
  assert.match(slow.reason ?? "", /timeout .* ran out during `sleep 600`/);
  assert.deepEqual(f.removed, ["nakara-verify-7-1"]);
  const unknown = await f.verify({
    commands: ["true"],
    head: "0".repeat(40),
  });
  assert.equal(unknown.status, "error");
  assert.match(unknown.reason ?? "", /could not check out/);
});
