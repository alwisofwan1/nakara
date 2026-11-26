// The Setup page: what Nakara needs to run, checked now, with the way to fix
// each failure. Read-only. It reports only whether a credential is set, never
// its value, and probes Docker with short, bounded commands.
import { backupHealth } from "../backup.ts";
import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import { sandboxOf } from "../definition/reach.ts";
import {
  agentTokenLabel,
  agentTokenOf,
  agentTokenWarnings,
  factoryTokenVariable,
} from "../runner/agent-token.ts";
import { dockerSupportsEgress } from "../runner/docker.ts";
import { run } from "../runner/workspace.ts";

export type CheckState = "ok" | "warn" | "fail";
export type CheckGroup = "Host" | "Credentials" | "Factories" | "Operations";

export interface SetupCheckDto {
  id: string;
  group: CheckGroup;
  title: string;
  state: CheckState;
  detail: string;
  /** What to do about a warning or failure; null when there is nothing to do. */
  fix: string | null;
  /** The token this check can test against GitHub, when it is set. */
  verify: GithubTokenKind | null;
}

export type GithubTokenKind = "agent" | "foreman";

/** What GitHub said about one repository for a token. */
export interface VerifyRepoDto {
  repo: string;
  reachable: boolean;
  /** GitHub's `permissions.push` for the repository; null when it did not say. */
  canPush: boolean | null;
}

export interface VerifyDto {
  token: GithubTokenKind;
  state: CheckState;
  detail: string;
  repos: VerifyRepoDto[];
}

export interface SetupDto {
  checks: SetupCheckDto[];
  counts: Record<CheckState, number>;
}

/** What the checks touch outside the database; tests replace it. */
export interface SetupProbes {
  /** Runs `docker <args>`; rejects when Docker is missing or the command fails. */
  docker: (args: string[]) => Promise<string>;
  env: NodeJS.ProcessEnv;
  now: () => number;
}

export const systemProbes = (): SetupProbes => ({
  docker: (args) => run("docker", args, undefined, 10_000),
  env: process.env,
  now: Date.now,
});

export interface SetupInput {
  store: Store;
  config: Config;
  factories: {
    slug: string;
    definition: Definition | undefined;
    errors: number;
  }[];
  poll: { at: string; error: string | null } | null;
}

/** Images this repository builds; any other is pulled. */
const BUILD_IMAGE: Record<string, string> = {
  "nakara-agent":
    "docker build -t nakara-agent -f deploy/agent.Dockerfile deploy",
  "nakara-agent-browser":
    "docker build -t nakara-agent-browser -f deploy/agent-browser.Dockerfile deploy (after nakara-agent)",
};
const ENV_FILE =
  "Set it in ~/.config/nakara/env (mode 600) and restart Nakara.";

const message = (error: unknown) =>
  String((error as { stderr?: string }).stderr ?? error)
    .trim()
    .split("\n", 1)[0]
    ?.slice(0, 200);

/** Every check, in the order the page shows them. */
export async function readSetup(
  input: SetupInput,
  probes: SetupProbes = systemProbes(),
): Promise<SetupDto> {
  const checks: SetupCheckDto[] = [];
  const add = (
    group: CheckGroup,
    id: string,
    title: string,
    state: CheckState,
    detail: string,
    fix: string | null = null,
    verify: GithubTokenKind | null = null,
  ) => checks.push({ id, group, title, state, detail, fix, verify });
  const { env } = probes;
  const definitions = input.factories.flatMap((f) =>
    f.definition ? [f.definition] : [],
  );

  // Runners with an image are where agents and the foreman run.
  const images = new Set(
    definitions.flatMap((def) =>
      [...def.runners.values()].flatMap((r) => {
        const image = r.platform?.linux?.dockerImage;
        return image ? [image] : [];
      }),
    ),
  );
  const usesDocker = images.size > 0;

  let dockerUp = false;
  if (usesDocker) {
    try {
      const version = (
        await probes.docker(["version", "--format", "{{.Server.Version}}"])
      ).trim();
      dockerUp = true;
      if (dockerSupportsEgress(version))
        add("Host", "docker", "Docker", "ok", `Version ${version}.`);
      else
        add(
          "Host",
          "docker",
          "Docker",
          "fail",
          `Version ${version || "unknown"} is too old for the egress allowlist.`,
          "Upgrade Docker to v26 or later.",
        );
    } catch (error) {
      add(
        "Host",
        "docker",
        "Docker",
        "fail",
        `Docker is not reachable: ${message(error)}`,
        "Start the Docker daemon and make sure Nakara's user is in the docker group.",
      );
    }
    for (const image of [...images].sort()) {
      if (!dockerUp) {
        add(
          "Host",
          `image:${image}`,
          `Image ${image}`,
          "warn",
          "Not checked: Docker is not reachable.",
        );
        continue;
      }
      try {
        await probes.docker(["image", "inspect", "--format", "{{.Id}}", image]);
        add("Host", `image:${image}`, `Image ${image}`, "ok", "Present.");
      } catch {
        add(
          "Host",
          `image:${image}`,
          `Image ${image}`,
          "fail",
          "The image is missing, so agent runs and foreman turns cannot start.",
          BUILD_IMAGE[image] ?? `docker pull ${image}`,
        );
      }
    }
  } else {
    add(
      "Host",
      "docker",
      "Docker",
      "warn",
      "No runner has a dockerImage: agents run on the host, unsandboxed.",
      "Give a runner a dockerImage (see runners/docker.yaml in the bundled factory).",
    );
  }

  // Presence only: the value never leaves the process.
  const dockerFactories = input.factories.filter((f) =>
    [...(f.definition?.runners.values() ?? [])].some(
      (r) => r.platform?.linux?.dockerImage,
    ),
  );
  const allOwn =
    dockerFactories.length > 0 &&
    dockerFactories.every((f) => agentTokenOf(f.slug, env).source === "own");
  if (usesDocker) {
    if (allOwn && !env.NAKARA_AGENT_GH_TOKEN)
      add(
        "Credentials",
        "agent-token",
        "Agent GitHub token",
        "ok",
        "Every factory that runs agents in containers has its own agent token.",
      );
    else if (env.NAKARA_AGENT_GH_TOKEN)
      add(
        "Credentials",
        "agent-token",
        "Agent GitHub token",
        "ok",
        "NAKARA_AGENT_GH_TOKEN is set.",
        null,
        "agent",
      );
    else if (env.NAKARA_ALLOW_PERSONAL_GH_TOKEN === "1")
      add(
        "Credentials",
        "agent-token",
        "Agent GitHub token",
        "warn",
        "Agents get your personal gh token, which reaches every repository you can.",
        `Set NAKARA_AGENT_GH_TOKEN to a fine-grained token limited to the factory repositories. ${ENV_FILE}`,
      );
    else
      add(
        "Credentials",
        "agent-token",
        "Agent GitHub token",
        "fail",
        "NAKARA_AGENT_GH_TOKEN is not set, so docker agent runs of factories without their own token fail.",
        `Create a fine-grained token with Contents, Pull requests and Issues read/write on the factory repositories, as NAKARA_AGENT_GH_TOKEN or a factory's own NAKARA_AGENT_GH_TOKEN__<SLUG>. ${ENV_FILE}`,
      );
    add(
      "Credentials",
      "foreman-token",
      "Foreman GitHub token",
      env.NAKARA_FOREMAN_GH_TOKEN ? "ok" : "warn",
      env.NAKARA_FOREMAN_GH_TOKEN
        ? "NAKARA_FOREMAN_GH_TOKEN is set; the foreman cannot write to GitHub."
        : "The foreman uses the agent token, which can write.",
      env.NAKARA_FOREMAN_GH_TOKEN
        ? null
        : `Set NAKARA_FOREMAN_GH_TOKEN to a read-only fine-grained token. ${ENV_FILE}`,
      env.NAKARA_FOREMAN_GH_TOKEN ? "foreman" : null,
    );
    const claudeUsed = definitions.some((def) =>
      [...def.agents.values()].some((a) => a.harness.kind === "claude"),
    );
    if (claudeUsed) {
      const set = env.CLAUDE_CODE_OAUTH_TOKEN || env.ANTHROPIC_API_KEY;
      add(
        "Credentials",
        "claude-token",
        "Claude credentials",
        set ? "ok" : "fail",
        set
          ? "A Claude token is set for containers."
          : "Neither CLAUDE_CODE_OAUTH_TOKEN nor ANTHROPIC_API_KEY is set, so claude runs in containers fail.",
        set
          ? null
          : `Run \`claude setup-token\` and set CLAUDE_CODE_OAUTH_TOKEN. ${ENV_FILE}`,
      );
    }
  }
  if (env.NAKARA_ALLOW_HOST_FOREMAN === "1")
    add(
      "Credentials",
      "host-foreman",
      "Foreman on the host",
      "warn",
      "NAKARA_ALLOW_HOST_FOREMAN=1: a foreman without a sandbox runs with your full access.",
      "Remove it once every factory's foreman runner has a dockerImage.",
    );

  for (const f of input.factories) {
    const title = `Factory ${f.slug}`;
    if (!f.definition) {
      add(
        "Factories",
        `definition:${f.slug}`,
        title,
        "fail",
        `No valid definition is loaded (${f.errors} error${f.errors === 1 ? "" : "s"}).`,
        `Open the Definition page of ${f.slug} and fix the errors.`,
      );
      continue;
    }
    add(
      "Factories",
      `definition:${f.slug}`,
      title,
      "ok",
      `${f.definition.factory.repositories.length} repositor${f.definition.factory.repositories.length === 1 ? "y" : "ies"}, ${f.definition.agents.size} agents.`,
    );
    const box = sandboxOf(f.definition.runners, f.definition.foreman.runner);
    add(
      "Factories",
      `foreman:${f.slug}`,
      `Foreman of ${f.slug}`,
      box ? "ok" : "warn",
      box
        ? `Runs in a container (${box.image}).`
        : "Its runner has no dockerImage: its turns pause the item unless NAKARA_ALLOW_HOST_FOREMAN=1.",
      box ? null : "Give the foreman's runner a dockerImage.",
    );
    if (dockerFactories.includes(f)) {
      const token = agentTokenOf(f.slug, env);
      const problems = agentTokenWarnings(input.store, f.slug, env);
      const own = factoryTokenVariable(f.slug);
      add(
        "Factories",
        `agent-token:${f.slug}`,
        `Agent token of ${f.slug}`,
        token.source === "none"
          ? "fail"
          : token.source === "personal" || problems.length
            ? "warn"
            : "ok",
        token.source === "none"
          ? "No agent token: its docker agent runs fail."
          : [`Agents use the ${agentTokenLabel(token)}.`, ...problems].join(
              " ",
            ),
        token.source === "none" || token.source === "personal"
          ? `Set ${own} (this factory only) or NAKARA_AGENT_GH_TOKEN. ${ENV_FILE}`
          : problems.length
            ? `Give ${token.variable} Contents, Pull requests and Issues read/write on these repositories. A fine-grained token has one resource owner${token.source === "own" ? ", so they must all be under that owner." : `: for repositories under another owner, give this factory its own token, ${own}.`}`
            : null,
      );
    }
  }

  const { poll } = input;
  add(
    "Operations",
    "github-poll",
    "GitHub intake",
    !poll ? "warn" : poll.error ? "fail" : "ok",
    !poll
      ? "No poll has run yet."
      : poll.error
        ? `The last poll (${poll.at}) failed: ${poll.error.slice(0, 200)}`
        : `Last poll at ${poll.at}.`,
    poll?.error
      ? "Check `gh auth status` for Nakara's user and the repositories' access."
      : null,
  );
  const backup = backupHealth(input.config.backup, probes.now());
  add(
    "Operations",
    "backup",
    "Database backup",
    backup.stale ? "warn" : "ok",
    backup.at
      ? `Newest snapshot at ${backup.at}${backup.stale ? ", older than twice the interval" : ""}.`
      : "No snapshot yet.",
    backup.stale
      ? `Check NAKARA_BACKUP_DIR (${input.config.backup.dir}) is writable.`
      : null,
  );

  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.state]++;
  return { checks, counts };
}

/** What `verifyGithubToken` touches outside the process; tests replace it. */
export interface VerifyProbes {
  env: NodeJS.ProcessEnv;
  fetch: typeof fetch;
}

export const systemVerifyProbes = (): VerifyProbes => ({
  env: process.env,
  fetch: (input, init) => fetch(input, init),
});

/** The distinct `owner/name` repositories of the loaded definitions. */
export const repositoriesOf = (definitions: Definition[]): string[] => [
  ...new Set(
    definitions.flatMap((def) =>
      def.factory.repositories.map((r) => `${r.owner}/${r.name}`),
    ),
  ),
];

/**
 * Asks GitHub whether a token works and reaches each repository. The token
 * is sent to api.github.com only and is never part of the result. Whether it
 * can write is GitHub's `permissions.push` for the repository: a hint, not a
 * proof, since GitHub may report the account's role rather than the token's.
 */
export async function verifyGithubToken(
  kind: GithubTokenKind,
  repositories: string[],
  probes: VerifyProbes = systemVerifyProbes(),
): Promise<VerifyDto> {
  const name =
    kind === "agent" ? "NAKARA_AGENT_GH_TOKEN" : "NAKARA_FOREMAN_GH_TOKEN";
  const token = probes.env[name];
  const done = (
    state: CheckState,
    detail: string,
    repos: VerifyRepoDto[] = [],
  ): VerifyDto => ({ token: kind, state, detail, repos });
  if (!token) return done("fail", `${name} is not set.`);
  const get = (path: string) =>
    probes.fetch(`https://api.github.com${path}`, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "nakara-setup",
      },
      signal: AbortSignal.timeout(10_000),
    });
  try {
    if (repositories.length === 0) {
      const res = await get("/user");
      return res.ok
        ? done("ok", "GitHub accepts the token. No repositories to check yet.")
        : done("fail", `GitHub answered ${res.status} for the token.`);
    }
    const repos: VerifyRepoDto[] = [];
    for (const repo of repositories) {
      const res = await get(`/repos/${repo}`);
      if (res.status === 401)
        return done(
          "fail",
          "GitHub rejects the token (401): it is expired, revoked or mistyped.",
          repos,
        );
      const body = res.ok
        ? ((await res.json()) as { permissions?: { push?: boolean } })
        : null;
      repos.push({
        repo,
        reachable: res.ok,
        canPush: body?.permissions?.push ?? null,
      });
    }
    const lost = repos.filter((r) => !r.reachable).map((r) => r.repo);
    if (lost.length)
      return done(
        "fail",
        `The token cannot reach ${lost.join(", ")}. Add them under the token's repository access.`,
        repos,
      );
    if (kind === "foreman") {
      const writes = repos.filter((r) => r.canPush).map((r) => r.repo);
      if (writes.length)
        return done(
          "warn",
          `GitHub reports write access on ${writes.join(", ")}: this may not be a read-only token.`,
          repos,
        );
    } else {
      const reads = repos.filter((r) => r.canPush === false).map((r) => r.repo);
      if (reads.length)
        return done(
          "warn",
          `GitHub reports no push access on ${reads.join(", ")}: agents could not push there.`,
          repos,
        );
    }
    return done(
      "ok",
      `GitHub accepts the token and it reaches ${repos.length} repositor${repos.length === 1 ? "y" : "ies"}.`,
      repos,
    );
  } catch (error) {
    return done("fail", `Could not ask GitHub: ${message(error)}`);
  }
}
