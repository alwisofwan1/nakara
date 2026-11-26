// Docker runner: an agent turn or setup command runs in a throwaway container
// that sees only the item directory and, read-only, the repository caches its
// clones borrow objects from, mounted at their host paths so the clones'
// alternates and `--resume` keep working.
// The host's claude binary is mounted read-only; the image provides git, gh, node.
// Containers sit on an internal network whose only way out is an allowlisting
// proxy (egress-proxy.ts).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { EGRESS_PORT } from "./egress-proxy.ts";
import type { Logger } from "../telemetry/log.ts";
import { run } from "./workspace.ts";

export interface DockerSpec {
  image: string;
  /** Host paths mounted read-write at the same path. */
  mounts: string[];
  /** Container HOME, mounted read-write, so claude sessions persist between turns. */
  home: string;
  /** Host files mounted read-only at the same path (e.g. the qwen wrapper). */
  readOnly?: string[];
  /** The runner's Warp `instanceShape`, enforced as container limits. */
  shape?: { vcpus: number; memoryGb: number } | undefined;
  /** Container name, so a stopped run's container can be removed by name. */
  name?: string | undefined;
  /** Labels on the container (`nakara.run`, `nakara.instance`), so a later start can find what a crash left; see sweepContainers. */
  labels?: Record<string, string> | undefined;
  /** Internal network and its proxy; see ensureEgress. */
  egress?: Egress | undefined;
}

export interface Egress {
  network: string;
  /** Proxy URL as seen from inside the network. */
  proxy: string;
  /** The hosts the proxy forwards to, named when a harness cannot reach its model. */
  allow?: string[] | undefined;
}

export interface Command {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * Wrap `inner` in `docker run`. Values travel through the docker CLI's own
 * environment (`-e NAME`), so secrets never show up in `ps`.
 */
export function dockerize(
  spec: DockerSpec,
  claudeBin: string,
  cwd: string,
  inner: string[],
  env: Record<string, string>,
): Command {
  const vol = (p: string, mode = "") => ["-v", `${p}:${p}${mode}`];
  // CLAUDE_CODE_TMPDIR: /tmp parents of a mount are root-owned, which claude refuses.
  const vars = {
    ...env,
    HOME: spec.home,
    CLAUDE_CODE_TMPDIR: spec.home,
    ...(spec.egress ? proxyEnv(spec.egress.proxy) : {}),
  };
  return {
    cmd: "docker",
    args: [
      "run",
      "--rm",
      "-i",
      "--init",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      ...(spec.name ? ["--name", spec.name] : []),
      ...Object.entries(spec.labels ?? {}).flatMap(([k, v]) => [
        "--label",
        `${k}=${v}`,
      ]),
      ...(spec.egress ? ["--network", spec.egress.network] : []),
      "--pids-limit",
      "4096",
      ...(spec.shape
        ? [
            "--cpus",
            String(spec.shape.vcpus),
            "--memory",
            `${spec.shape.memoryGb}g`,
          ]
        : []),
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "-w",
      cwd,
      ...[...spec.mounts, spec.home].flatMap((p) => vol(p)),
      ...(spec.readOnly ?? []).flatMap((p) => vol(p, ":ro")),
      "-v",
      `${realpathSync(onPath(claudeBin))}:/usr/local/bin/claude:ro`,
      ...Object.keys(vars).flatMap((k) => ["-e", k]),
      spec.image,
      ...inner,
    ],
    env: { ...process.env, ...vars },
  };
}

/** Both spellings: curl and git read the lower-case ones, Go and npm either. */
const proxyEnv = (url: string): Record<string, string> => ({
  HTTPS_PROXY: url,
  https_proxy: url,
  HTTP_PROXY: url,
  http_proxy: url,
  NO_PROXY: "localhost,127.0.0.1",
  no_proxy: "localhost,127.0.0.1",
  // Node's built-in fetch ignores the proxy variables without this.
  NODE_USE_ENV_PROXY: "1",
});

/** What a docker runner without an `egress` section may reach: Claude, GitHub and npm. */
export const DEFAULT_EGRESS_ALLOW = [
  "api.anthropic.com",
  "statsig.anthropic.com",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
];

/**
 * The hosts each harness must reach for its model, so its runner's egress
 * must allow them. codex logs in with ChatGPT: chatgpt.com serves the model
 * and auth.openai.com refreshes the login. qwen reaches the gateway its
 * wrapper names, which Nakara does not know.
 */
export const HARNESS_HOSTS: Record<"claude" | "codex" | "qwen", string[]> = {
  claude: ["api.anthropic.com"],
  codex: ["chatgpt.com", "auth.openai.com"],
  qwen: [],
};

const PROXY_SCRIPT = join(import.meta.dirname, "egress-proxy.ts");
const PROXY_ALIAS = "egress-proxy";
/** On every egress network and proxy, so stale ones are easy to find and remove. */
const EGRESS_LABEL = "nakara.egress";
const pending = new Map<string, Promise<Egress>>();

/** Runs inside the network: exits 0 once the proxy accepts connections, 1 after 30 s. */
const WAIT_FOR_PROXY = `const net = require("node:net");
const end = Date.now() + 30000;
const attempt = () => {
  const s = net.connect(${EGRESS_PORT}, "${PROXY_ALIAS}", () => { s.destroy(); process.exit(0); });
  s.on("error", () => Date.now() > end ? process.exit(1) : setTimeout(attempt, 200));
};
attempt();`;

const stderrOf = (error: unknown) =>
  String((error as { stderr?: string }).stderr ?? error);

/** Docker before v26 may forward external DNS from --internal networks, a way out past the proxy. */
export const dockerSupportsEgress = (version: string | null) =>
  Number(version?.trim().split(".")[0]) >= 26;

/**
 * An internal Docker network (no route out) plus a proxy container that sits
 * on it and on the default bridge, forwarding only to `allow`. One pair per
 * allowlist, image and proxy version, so a change gets a fresh pair; older
 * pairs stay until removed (see the README). Resolves once the proxy accepts
 * connections from inside the network.
 */
export function ensureEgress(allow: string[], image: string): Promise<Egress> {
  const network = `nakara-egress-${createHash("sha256")
    .update(JSON.stringify([image, readFileSync(PROXY_SCRIPT, "utf8"), allow]))
    .digest("hex")
    .slice(0, 12)}`;
  const inFlight = pending.get(network);
  if (inFlight) return inFlight;
  const docker = (args: string[], timeout = 60_000) =>
    run("docker", args, undefined, timeout);
  const probe = (args: string[]) => docker(args).catch(() => null);
  const proxy = `${network}-proxy`;
  const reachable = () =>
    docker(
      [
        "run",
        "--rm",
        "--network",
        network,
        image,
        "node",
        "-e",
        WAIT_FOR_PROXY,
      ],
      90_000,
    ).then(
      () => true,
      () => false,
    );
  const start = async () => {
    await removeContainer(proxy);
    try {
      await docker([
        "run",
        "--detach",
        "--init",
        "--name",
        proxy,
        "--label",
        EGRESS_LABEL,
        "--restart",
        "unless-stopped",
        "--user",
        `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
        "--env",
        `NAKARA_EGRESS_ALLOW=${allow.join(",")}`,
        "-v",
        `${PROXY_SCRIPT}:${PROXY_SCRIPT}:ro`,
        image,
        "node",
        PROXY_SCRIPT,
      ]);
    } catch (error) {
      // Another Nakara process started it first; the reachability check decides.
      if (/already in use/.test(stderrOf(error))) return;
      throw error;
    }
    try {
      await docker([
        "network",
        "connect",
        "--alias",
        PROXY_ALIAS,
        network,
        proxy,
      ]);
    } catch (error) {
      if (/already exists/.test(stderrOf(error))) return;
      // A proxy off the network would look running but serve nobody.
      await removeContainer(proxy);
      throw error;
    }
  };
  const ready = (async () => {
    const version = await probe(["version", "--format", "{{.Server.Version}}"]);
    if (!dockerSupportsEgress(version))
      throw new Error(
        `Docker ${version?.trim() || "(unknown version)"} is too old for the agent egress allowlist: before v26, --internal networks can forward DNS out. Upgrade Docker to v26 or later.`,
      );
    if ((await probe(["network", "inspect", network])) === null)
      await docker([
        "network",
        "create",
        "--internal",
        "--label",
        EGRESS_LABEL,
        network,
      ]).catch(async (error) => {
        // Another Nakara process created it first.
        if ((await probe(["network", "inspect", network])) === null)
          throw error;
      });
    const running = await probe([
      "inspect",
      "--format",
      "{{.State.Running}}",
      proxy,
    ]);
    if (running !== "true") await start();
    if (!(await reachable())) {
      // A proxy left half set up (e.g. never connected to the network): start over once.
      await start();
      if (!(await reachable())) {
        await removeContainer(proxy);
        throw new Error(
          `The egress proxy ${proxy} does not accept connections on ${network}.`,
        );
      }
    }
    return { network, proxy: `http://${PROXY_ALIAS}:${EGRESS_PORT}`, allow };
  })().finally(() => pending.delete(network));
  pending.set(network, ready);
  return ready;
}

const onPath = (bin: string) =>
  bin.includes("/")
    ? bin
    : ((process.env.PATH ?? "")
        .split(":")
        .map((d) => join(d, bin))
        .find((p) => existsSync(p)) ?? bin);

/**
 * The codex npm launcher (bin/codex.js) wraps a static musl binary; mounting
 * that binary lets codex run in any image without node or the npm package.
 */
export function nativeCodex(bin: string): string {
  const real = realpathSync(onPath(bin));
  if (!real.endsWith(".js")) return real;
  // ponytail: linux x64 only; other platforms ship a different vendor directory.
  return join(
    dirname(real),
    "../node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex",
  );
}

/** The labels of a run's container; `instance` is the data directory, which a restart keeps. */
export const runLabels = (
  runId: number,
  instance: string,
): Record<string, string> => ({
  "nakara.run": String(runId),
  "nakara.instance": instance,
});

/**
 * At startup nothing of this process runs yet, so every container labelled
 * for this instance belongs to a run a crash left behind: remove it before the
 * run's follow-up starts a second copy. Other instances' containers and the
 * egress proxy (no label) stay. No docker, or a failing one, sweeps nothing.
 */
export async function sweepContainers(
  instance: string,
  log: Pick<Logger, "info">,
): Promise<void> {
  const listed = await run(
    "docker",
    [
      "ps",
      "--all",
      "--filter",
      `label=nakara.instance=${instance}`,
      "--format",
      '{{.ID}} {{.Label "nakara.run"}}',
    ],
    undefined,
    30_000,
  ).catch(() => undefined);
  for (const line of (listed ?? "").split("\n")) {
    const [id, runId] = line.trim().split(" ");
    if (!id) continue;
    await removeContainer(id);
    log.info("startup.container_removed", { container: id, run_id: runId });
  }
}

/** Force-remove a container; a container that is already gone is not an error. */
export async function removeContainer(name: string): Promise<void> {
  await run("docker", ["rm", "--force", name], undefined, 30_000).catch(
    () => undefined,
  );
}

/**
 * Credentials a container needs: GitHub for clone/push/PRs, git identity, and
 * Claude auth. The foreman reads GitHub with its own read-only token when one
 * is set, and then holds no other.
 */
export async function agentCredentials(
  harness: string,
  role: "agent" | "foreman" = "agent",
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};
  // A fine-grained token scoped to the factory repos. The operator's own gh
  // token reaches every repo they can, so using it is an explicit opt-in.
  if (role === "foreman" && process.env.NAKARA_FOREMAN_GH_TOKEN)
    env.GH_TOKEN = process.env.NAKARA_FOREMAN_GH_TOKEN;
  else if (process.env.NAKARA_AGENT_GH_TOKEN)
    env.GH_TOKEN = process.env.NAKARA_AGENT_GH_TOKEN;
  else if (personalTokenAllowed())
    env.GH_TOKEN = await run("gh", ["auth", "token"]);
  else
    throw new Error(
      "The Docker runner needs NAKARA_AGENT_GH_TOKEN in Nakara's environment: a fine-grained token limited to the factory repositories with Contents, Pull requests and Issues read/write. To give agents your own `gh auth token` instead, set NAKARA_ALLOW_PERSONAL_GH_TOKEN=1.",
    );
  const name = await run("git", ["config", "--global", "user.name"]).catch(
    () => "",
  );
  const email = await run("git", ["config", "--global", "user.email"]).catch(
    () => "",
  );
  if (name) env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = name;
  if (email) env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email;
  // qwen authenticates through its own settings file and codex through CODEX_HOME;
  // an Anthropic token would override qwen's gateway.
  if (harness === "claude") {
    const token =
      process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
    if (!token)
      throw new Error(
        "The Docker runner needs CLAUDE_CODE_OAUTH_TOKEN (from `claude setup-token`) or ANTHROPIC_API_KEY in Nakara's environment.",
      );
    env[
      process.env.CLAUDE_CODE_OAUTH_TOKEN
        ? "CLAUDE_CODE_OAUTH_TOKEN"
        : "ANTHROPIC_API_KEY"
    ] = token;
  }
  return env;
}

const personalTokenAllowed = () =>
  !process.env.NAKARA_AGENT_GH_TOKEN &&
  process.env.NAKARA_ALLOW_PERSONAL_GH_TOKEN === "1";

/** Shown in the UI and /healthz while agents run with the operator's own token. */
export function credentialWarning(): string | null {
  return personalTokenAllowed()
    ? "Agent containers get your personal gh token (NAKARA_ALLOW_PERSONAL_GH_TOKEN=1), which reaches every repository you can. Set NAKARA_AGENT_GH_TOKEN to a fine-grained token limited to the factory repositories."
    : null;
}

/** Shown in the UI and /healthz while the foreman holds the agents' write token. */
export const foremanTokenWarning = (): string | null =>
  process.env.NAKARA_FOREMAN_GH_TOKEN
    ? null
    : "The foreman reads GitHub with the agent token, which can write. Set NAKARA_FOREMAN_GH_TOKEN to a fine-grained read-only token so a prompt-injected foreman cannot change anything on GitHub.";

/**
 * The container HOME of an item: beside its directory, so the host creates
 * and removes it without walking a path the agent could have swapped for a symlink.
 */
export async function containerHome(root: string): Promise<string> {
  const home = `${root}.home`;
  await mkdir(home, { recursive: true });
  return home;
}
