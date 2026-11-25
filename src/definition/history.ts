// A Nakara-managed definition is a local git repository: every web edit
// through the definition writer is a commit, so its history exists without
// GitHub. Commits are authored as Nakara, whatever git identity the host has.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const IDENTITY = [
  "-c",
  "user.name=Nakara",
  "-c",
  "user.email=nakara@localhost",
  "-c",
  "commit.gpgsign=false",
];

const git = async (dir: string, args: string[]) =>
  (
    await exec("git", [...IDENTITY, ...args], {
      cwd: dir,
      maxBuffer: 16 * 1024 * 1024,
    })
  ).stdout;

/** Whether `dir` is the top of its own git repository (not a folder in one). */
const isRepository = (dir: string) =>
  stat(join(dir, ".git")).then(
    () => true,
    () => false,
  );

/**
 * Make `dir` a git repository with its files committed, once: a managed
 * definition created or migrated before history existed gets a first commit
 * of the tree as it is, so the next edit's commit holds only that edit.
 */
export async function ensureHistory(dir: string): Promise<void> {
  if (await isRepository(dir)) return;
  await git(dir, ["init", "--quiet", "--initial-branch=main"]);
  await commitDefinition(dir, "Initial definition");
}

/** Commit every change in `dir`; nothing to commit is no commit and no error. */
export async function commitDefinition(
  dir: string,
  message: string,
): Promise<void> {
  await git(dir, ["add", "--all"]);
  if (!(await git(dir, ["status", "--porcelain"])).trim()) return;
  await git(dir, ["commit", "--quiet", "--no-verify", "-m", message]);
}

export interface Commit {
  sha: string;
  at: string;
  message: string;
}

/** The latest commits of a managed definition, newest first; none before its first. */
export async function definitionHistory(
  dir: string,
  limit = 20,
): Promise<Commit[]> {
  if (!(await isRepository(dir))) return [];
  const out = await git(dir, [
    "log",
    `--max-count=${limit}`,
    "--format=%H%x09%cI%x09%s",
  ]).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", at = "", ...message] = line.split("\t");
      return { sha, at, message: message.join("\t") };
    });
}
