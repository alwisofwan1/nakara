// What a run changed, made by any tool and committed or not: each clone is
// snapshotted as a git tree when the run starts and when it ends, and the run's
// diff is the diff between the two trees. When the run ends, its diff is
// written next to its log; the run page reads that file from then on.
//
// The agent controls its clone, config and hooks included, so Nakara never
// runs git in it. Every command here runs in a temporary repository of
// Nakara's own, with an empty config and no system or global config: the
// agent's core.fsmonitor, hooks, filters and diff drivers never run on the
// host. GIT_WORK_TREE points it at the clone's files and GIT_OBJECT_DIRECTORY
// at an object directory Nakara owns, where the trees are written; the
// repository's cache is its alternate, so unchanged files cost nothing. The
// temporary index starts empty, so the agent's index, HEAD and stash stay
// untouched; ignored files stay out, untracked ones are included.
import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { writeInternal } from "./workspace.ts";

const exec = promisify(execFile);

/** One repository of a run: its tree at the run's start and, once it ended, at its end. */
export interface RepoSnapshot {
  /** owner/name */
  slug: string;
  start: string;
  end?: string;
}

/** Where a repository's files and objects are: its clone, its cache and Nakara's snapshot objects. */
export interface RepoPaths {
  slug: string;
  path: string;
  bare: string;
  objects: string;
}

/** Where snapshot trees are written, and the cache they borrow objects from. */
type ObjectStore = Pick<RepoPaths, "bare" | "objects">;

/** Per repository, the diff text a run page shows at most. */
export const MAX_DIFF_BYTES = 256 * 1024;

/** A temporary repository of Nakara's own whose objects are the snapshot objects. */
async function isolated<T>(
  store: ObjectStore,
  worktree: string | null,
  fn: (env: NodeJS.ProcessEnv) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "nakara-git-"));
  try {
    const gitDir = join(dir, "git");
    await mkdir(join(gitDir, "refs"), { recursive: true });
    await mkdir(join(gitDir, "objects"));
    await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n");
    await mkdir(store.objects, { recursive: true });
    await writeFile(
      join(gitDir, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
    );
    // Nothing of the host's git environment leaks in, either.
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    );
    return await fn({
      ...env,
      GIT_DIR: gitDir,
      ...(worktree ? { GIT_WORK_TREE: worktree } : {}),
      GIT_OBJECT_DIRECTORY: store.objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(store.bare, "objects"),
      GIT_INDEX_FILE: join(dir, "index"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const git = (args: string[], cwd: string, env: NodeJS.ProcessEnv) =>
  exec("git", args, {
    cwd,
    env,
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  }).then(({ stdout }) => stdout.trim());

/** The tree of a clone as it is on disk, written into the snapshot objects. */
export function snapshotTree(
  worktree: string,
  store: ObjectStore,
): Promise<string> {
  return isolated(store, worktree, async (env) => {
    // Never a symlink the agent put in place of its clone.
    if (!(await lstat(worktree)).isDirectory())
      throw new Error(`${worktree} is not a directory`);
    await git(["add", "--all", "."], worktree, env);
    return git(["write-tree"], worktree, env);
  });
}

/**
 * Snapshot each worktree at a run's start. A repository that cannot be
 * snapshotted is left out; with none, the run page falls back to the log.
 */
export async function startSnapshots(
  repos: RepoPaths[],
): Promise<RepoSnapshot[]> {
  const snapshots: RepoSnapshot[] = [];
  for (const repo of repos) {
    try {
      snapshots.push({
        slug: repo.slug,
        start: await snapshotTree(repo.path, repo),
      });
    } catch {
      // The run goes on; only its diff is lost.
    }
  }
  return snapshots;
}

/** The start snapshots with the worktrees' trees at the run's end. */
export async function endSnapshots(
  repos: RepoPaths[],
  started: RepoSnapshot[],
): Promise<RepoSnapshot[]> {
  const ended: RepoSnapshot[] = [];
  for (const snapshot of started) {
    const repo = repos.find((r) => r.slug === snapshot.slug);
    try {
      if (!repo) throw new Error("gone");
      ended.push({
        ...snapshot,
        end: await snapshotTree(repo.path, repo),
      });
    } catch {
      ended.push(snapshot);
    }
  }
  return ended;
}

export interface TreeDiff {
  /** The unified diff, cut at a line once it passes maxBytes. */
  diff: string;
  /** git's summary, e.g. "2 files changed, 5 insertions(+), 1 deletion(-)"; empty without changes. */
  stat: string;
  truncated: boolean;
}

/** The diff between two trees in the snapshot objects. */
export function diffTrees(
  store: ObjectStore,
  start: string,
  end: string,
  maxBytes = MAX_DIFF_BYTES,
): Promise<TreeDiff> {
  return isolated(store, null, async (env) => {
    const args = [
      "-c",
      "core.quotePath=false",
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--src-prefix=a/",
      "--dst-prefix=b/",
    ];
    const stat = await git([...args, "--shortstat", start, end], tmpdir(), env);
    const { text, truncated } = await readCapped(
      [...args, start, end],
      env,
      maxBytes,
    );
    return { diff: text, stat, truncated };
  });
}

/** git's stdout up to maxBytes, cut at the last full line; git is stopped there. */
function readCapped(
  args: string[],
  env: NodeJS.ProcessEnv,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: tmpdir(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      chunks.push(chunk);
      size += chunk.length;
      if (size > maxBytes) {
        truncated = true;
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (!truncated && code !== 0)
        return reject(new Error(stderr.trim() || `git exited with ${code}`));
      let out = Buffer.concat(chunks);
      if (truncated) {
        out = out.subarray(0, maxBytes);
        const cut = out.lastIndexOf(10);
        if (cut >= 0) out = out.subarray(0, cut + 1);
      }
      resolve({ text: out.toString("utf8"), truncated });
    });
  });
}

export interface RepoDiff extends TreeDiff {
  /** owner/name */
  slug: string;
  /** The diff was cut at `limitBytes`. */
  limitBytes: number;
  /** Why this repository's diff could not be read. */
  error: string | null;
}

/**
 * Each repository's diff from its start to its end, or to its worktree as it
 * is now when the end was not recorded yet.
 */
export function diffRepos(
  snapshots: RepoSnapshot[],
  repos: RepoPaths[],
  maxBytes = MAX_DIFF_BYTES,
): Promise<RepoDiff[]> {
  return Promise.all(
    snapshots.map(async ({ slug, start, end }): Promise<RepoDiff> => {
      const empty = { slug, diff: "", stat: "", truncated: false };
      try {
        const repo = repos.find((r) => r.slug === slug);
        if (!repo) throw new Error(`${slug} is not in the workspace`);
        const to = end ?? (await snapshotTree(repo.path, repo));
        return {
          ...(await diffTrees(repo, start, to, maxBytes)),
          slug,
          limitBytes: maxBytes,
          error: null,
        };
      } catch (error) {
        return {
          ...empty,
          limitBytes: maxBytes,
          error: `Could not read the diff: ${String((error as Error).message ?? error).slice(0, 300)}`,
        };
      }
    }),
  );
}

/** The file next to a run's log that holds its final diff. */
export const diffFile = (logPath: string) =>
  `${logPath.replace(/\.jsonl$/, "")}.diff.json`;

/** Write a run's final diff next to its log. */
export async function recordDiff(
  logPath: string,
  snapshots: RepoSnapshot[],
  repos: RepoPaths[],
  maxBytes = MAX_DIFF_BYTES,
): Promise<void> {
  await writeInternal(
    diffFile(logPath),
    JSON.stringify(await diffRepos(snapshots, repos, maxBytes)),
  );
}
