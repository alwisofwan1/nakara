// The commit a clone's (or worktree's) HEAD names, read from its files as
// plain data.
//
// The agent controls its clone, config included, so Nakara runs no git
// here: git would read the agent's repository config (core.fsmonitor and the
// like) on the host. HEAD, a worktree's admin directory and the refs are
// small text files; every one read is a regular
// file (no symlink, FIFO or device), and only a commit id or a ref name is
// taken from it.
import { lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const REF = /^ref: (refs\/\S+)$/;
/** packed-refs grows with the repository; HEAD and loose refs are a line. */
const MAX_BYTES = 64 * 1024 * 1024;

export async function readPlain(path: string): Promise<string | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.size > MAX_BYTES) return null;
  return readFile(path, "utf8").catch(() => null);
}

/** A ref's commit, or its target when it is symbolic; null when it does not exist. */
async function readRef(common: string, name: string): Promise<string | null> {
  if (name.split("/").some((part) => part === ".." || part === "."))
    return null;
  const loose = (await readPlain(join(common, name)))?.trim();
  if (loose) return loose;
  const packed = await readPlain(join(common, "packed-refs"));
  for (const line of packed?.split("\n") ?? []) {
    const [sha, ref] = line.trim().split(" ");
    if (ref === name && sha && COMMIT.test(sha)) return sha;
  }
  return null;
}

/**
 * The commit a worktree's HEAD is at, or null when it cannot be read: no
 * worktree, an unborn branch, or files that are not what git writes.
 */
export async function worktreeHead(worktree: string): Promise<string | null> {
  const dotGit = join(worktree, ".git");
  const stat = await lstat(dotGit).catch(() => null);
  let gitDir: string;
  if (stat?.isDirectory()) gitDir = dotGit;
  else {
    const pointer = /^gitdir: (.+)$/m.exec((await readPlain(dotGit)) ?? "");
    if (!pointer?.[1]) return null;
    gitDir = resolve(worktree, pointer[1].trim());
  }
  const commonDir = (await readPlain(join(gitDir, "commondir")))?.trim();
  const common = commonDir ? resolve(gitDir, commonDir) : gitDir;
  return (await gitHead(gitDir, common))?.commit ?? null;
}

/**
 * The commit HEAD in `gitDir` is at, and the branch it is on (null when
 * detached); refs are read from `common`. Null when it cannot be read.
 */
export async function gitHead(
  gitDir: string,
  common: string,
): Promise<{ commit: string; branch: string | null } | null> {
  let value = (await readPlain(join(gitDir, "HEAD")))?.trim();
  let branch: string | null = null;
  // A symbolic ref may point to another; git stops after a few as well.
  for (let depth = 0; value && depth < 5; depth++) {
    if (COMMIT.test(value)) return { commit: value, branch };
    const ref = REF.exec(value)?.[1];
    if (!ref) return null;
    branch ??= ref;
    value = (await readRef(common, ref)) ?? undefined;
  }
  return null;
}
