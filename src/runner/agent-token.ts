// The GitHub token a factory's agents run with. A fine-grained token has one
// resource owner, so factories whose repositories live under different owners
// each need their own: NAKARA_AGENT_GH_TOKEN__<SLUG> when set, else the shared
// NAKARA_AGENT_GH_TOKEN, else (opt-in) the operator's own gh login. Values
// stay in the environment: callers get the source and the variable's name, and
// only agentTokenSecret hands out the value, for GH_TOKEN.
import { execFile } from "node:child_process";

import type { Store } from "../db.ts";
import type { Definition } from "../definition/load.ts";

export const SHARED_AGENT_TOKEN = "NAKARA_AGENT_GH_TOKEN";

/**
 * `own`: the factory's NAKARA_AGENT_GH_TOKEN__<SLUG>; `shared`:
 * NAKARA_AGENT_GH_TOKEN; `personal`: the operator's gh login
 * (NAKARA_ALLOW_PERSONAL_GH_TOKEN=1); `none`: docker agent runs fail closed.
 */
export type AgentTokenSource = "own" | "shared" | "personal" | "none";

/**
 * The factory's own variable: the slug upper-cased, every other character
 * than A-Z and 0-9 as `_`. Slugs are lower-case letters, digits and `-`, so
 * two slugs never share a variable, and the `__` keeps it apart from
 * NAKARA_AGENT_GH_TOKEN itself.
 */
export const factoryTokenVariable = (slug: string): string =>
  `${SHARED_AGENT_TOKEN}__${slug.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

export interface AgentToken {
  source: AgentTokenSource;
  /** The variable holding the token; null for the personal login and none. */
  variable: string | null;
}

/** Where a factory's agent token comes from; never its value. */
export function agentTokenOf(
  slug: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AgentToken {
  const own = slug ? factoryTokenVariable(slug) : undefined;
  if (own && env[own]) return { source: "own", variable: own };
  if (env[SHARED_AGENT_TOKEN])
    return { source: "shared", variable: SHARED_AGENT_TOKEN };
  return {
    source: env.NAKARA_ALLOW_PERSONAL_GH_TOKEN === "1" ? "personal" : "none",
    variable: null,
  };
}

/** The value of the factory's own or the shared token; undefined for personal and none. */
export function agentTokenSecret(
  slug: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const { variable } = agentTokenOf(slug, env);
  return variable ? env[variable] : undefined;
}

/** How the UI and /healthz name a source. */
export const agentTokenLabel = ({ source, variable }: AgentToken): string =>
  source === "own"
    ? `own token (${variable})`
    : source === "shared"
      ? `shared token (${SHARED_AGENT_TOKEN})`
      : source === "personal"
        ? "personal gh token (NAKARA_ALLOW_PERSONAL_GH_TOKEN=1)"
        : "none";

export interface GhResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}
/** Runs `gh` with `args`; `env` overrides Nakara's environment, e.g. GH_TOKEN. */
export type Gh = (
  args: string[],
  env?: Record<string, string>,
) => Promise<GhResult>;

export const runGh: Gh = (args, env) =>
  new Promise((resolve) => {
    execFile(
      "gh",
      args,
      {
        env: env ? { ...process.env, ...env } : process.env,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) =>
        resolve({
          ok: !error,
          stdout: String(stdout),
          // A missing gh binary fails before it writes anything.
          stderr: String(stderr) || (error ? error.message : ""),
        }),
    );
  });

export interface PushAccess {
  repo: string;
  /** Whether the token can push; a repository counts only with push permission, since any token reads a public one. */
  canPush: boolean;
  /** Why not, when it can't. */
  message: string | null;
}

/**
 * Asks GitHub for each repository whether `token` can push to it; without a
 * token, gh's own login is asked. `who` names the token in the messages. The
 * token goes to gh's environment only.
 */
export function pushAccess(
  gh: Gh,
  token: string | undefined,
  who: string,
  repos: string[],
): Promise<PushAccess[]> {
  const env = token ? { GH_TOKEN: token, GITHUB_TOKEN: "" } : undefined;
  return Promise.all(
    repos.map(async (repo) => {
      const result = await gh(
        ["api", `repos/${repo}`, "--jq", ".permissions.push"],
        env,
      );
      if (result.ok)
        return result.stdout.trim() === "true"
          ? { repo, canPush: true, message: null }
          : {
              repo,
              canPush: false,
              message: `The ${who} can't push to ${repo}.`,
            };
      const notFound = /HTTP 40[34]|Not Found/i.test(result.stderr);
      return {
        repo,
        canPush: false,
        message: notFound
          ? `The ${who} can't see ${repo}.`
          : `Could not check ${repo}: ${result.stderr.trim().slice(0, 200)}`,
      };
    }),
  );
}

/** What the last check found for a factory's agent token. */
export interface AgentTokenCheck {
  checkedAt: string;
  source: AgentTokenSource;
  /** One line per repository the token cannot push to. */
  problems: string[];
}

const checkKey = (slug: string | undefined) =>
  `agent-token:${slug ?? "default"}`;

export function readAgentTokenCheck(
  store: Pick<Store, "getKv">,
  slug: string | undefined,
): AgentTokenCheck | null {
  const value = store.getKv(checkKey(slug));
  return value ? JSON.parse(value) : null;
}

/**
 * Whether the token a factory's agent containers get can push to each of its
 * repositories, recorded for the UI and /healthz. A factory without docker
 * runners gives agents no token, and one with none fails closed, so neither
 * is asked about.
 */
export async function checkAgentToken(
  store: Pick<Store, "getKv" | "setKv">,
  slug: string | undefined,
  def: Definition,
  gh: Gh = runGh,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const token = agentTokenOf(slug, env);
  const docker = [...def.runners.values()].some(
    (r) => r.platform?.linux?.dockerImage,
  );
  const repos = def.factory.repositories
    .filter((r) => !r.deferred)
    .map((r) => `${r.owner}/${r.name}`);
  const problems =
    docker && token.source !== "none" && repos.length
      ? (
          await pushAccess(
            gh,
            agentTokenSecret(slug, env),
            token.source === "personal" ? "personal gh token" : "agent token",
            repos,
          )
        ).flatMap((r) => (r.message ? [r.message] : []))
      : [];
  const check: AgentTokenCheck = {
    checkedAt: new Date().toISOString(),
    source: token.source,
    problems,
  };
  store.setKv(checkKey(slug), JSON.stringify(check));
}

/** The write-access warnings of the last check, while the source it checked is still the one in use. */
export function agentTokenWarnings(
  store: Pick<Store, "getKv">,
  slug: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const check = readAgentTokenCheck(store, slug);
  if (!check || check.source !== agentTokenOf(slug, env).source) return [];
  return check.problems.map(
    (problem) =>
      `${problem} Agents of ${slug ?? "this factory"} could not push branches or open pull requests there.`,
  );
}
