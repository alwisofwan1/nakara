// Each codex run gets its own CODEX_HOME (#114) with Nakara's execpolicy
// rules and the item's earlier sessions; afterwards only the sessions come
// back, so what an agent writes there (config.toml, AGENTS.md, ...) never
// reaches a later run. The login is the one exception: auth.json links to the
// operator's, because codex rotates the refresh token. Runs holding copies
// would refresh with a token another run already used and lose the login;
// sharing the file, a run that gets a 401 reloads the token another refreshed.
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

// codex has no --disallowedTools; execpolicy rules forbid the same prefixes.
export const CODEX_RULES = `prefix_rule(pattern = ["gh", "pr", "merge"], decision = "forbidden")
prefix_rule(pattern = ["gh", "repo", "delete"], decision = "forbidden")
prefix_rule(pattern = ["git", "push", ["--force", "-f", "--force-with-lease"]], decision = "forbidden")
`;

/** Directories and regular files only: an agent's symlink is never followed or carried. */
const plain = async (src: string) => {
  const stat = await lstat(src);
  return stat.isDirectory() || stat.isFile();
};

/** The operator's session file for `id` (rollout-…-<id>.jsonl), for sessions from before per-run homes. */
async function legacySession(
  operatorHome: string,
  id: string,
): Promise<string | null> {
  const dir = join(operatorHome, "sessions");
  const names = await readdir(dir, { recursive: true }).catch(
    (): string[] => [],
  );
  const name = names.find((n) => n.endsWith(`-${id}.jsonl`));
  return name ? join(dir, name) : null;
}

/**
 * A fresh CODEX_HOME for one run. `login` is the operator's auth.json its
 * link points at, which a container must mount at the same path. `close`
 * keeps the run's sessions and removes the home.
 */
export async function openCodexHome(
  operatorHome: string,
  sessions: string | undefined,
  resume: string | undefined,
): Promise<{ path: string; login: string | null; close: () => Promise<void> }> {
  const runs = `${operatorHome}.runs`;
  await mkdir(runs, { recursive: true, mode: 0o700 });
  // shortcut: a home left by a crash stays until removed by hand; sweep at startup if they pile up.
  const home = await mkdtemp(join(runs, "run-"));
  const auth = join(operatorHome, "auth.json");
  // codex writes auth.json in place (open, truncate, write), so a refresh goes through the link.
  const login = (await lstat(auth).catch(() => null))?.isFile() ? auth : null;
  if (login) await symlink(login, join(home, "auth.json"));
  await mkdir(join(home, "rules"));
  await writeFile(join(home, "rules", "nakara.rules"), CODEX_RULES);
  if (sessions && (await lstat(sessions).catch(() => null))?.isDirectory())
    await cp(sessions, join(home, "sessions"), {
      recursive: true,
      filter: plain,
    });
  else if (resume) {
    const old = await legacySession(operatorHome, resume);
    if (old) {
      await mkdir(join(home, "sessions"));
      await cp(old, join(home, "sessions", old.split("/").pop() ?? ""));
    }
  }

  const close = async () => {
    try {
      if (
        sessions &&
        (await lstat(join(home, "sessions")).catch(() => null))?.isDirectory()
      )
        await cp(join(home, "sessions"), sessions, {
          recursive: true,
          force: true,
          filter: plain,
        });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  return { path: home, login, close };
}
