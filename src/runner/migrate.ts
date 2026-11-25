// Startup migration from the old item layout (ADR 0003): item-N held one git
// worktree per repository of a shared cache that agents could write, and
// Nakara's internal files in item-N/.nakara, inside the agent mount.
//
// Caches from before the upgrade are moved aside once, so host git only ever
// runs in fresh clones from GitHub. Each worktree is moved out of the item
// directory, given a .git built by Nakara in its own staging directory, and
// moved back: its files, uncommitted changes included, are never touched, and
// host git never runs with the old cache's or the worktree's config or hooks.
// The commits only the old cache holds are read from it as a plain object
// directory (an alternate of the staging repository). Internal files are
// copied out as regular files only, never through a symlink.
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { gitHead, readPlain } from "./head.ts";
import {
  ensureBareClone,
  initFromCache,
  internalDir,
  repoPaths,
  run,
  writeInternal,
} from "./workspace.ts";

const exec = promisify(execFile);
const entry = (p: string) => lstat(p).catch(() => null);

type Dirs = { workDir: string; repoCacheDir: string };

/**
 * Where the caches from before the upgrade are kept. Never removed by
 * Nakara: they hold the local branches and commits migration does not carry.
 */
export const oldCacheDir = (repoCacheDir: string) => `${repoCacheDir}.old`;

/** Move the caches agents could write aside, once; ensureBareClone then clones fresh ones from GitHub. */
export async function moveOldCaches(repoCacheDir: string): Promise<void> {
  const marker = join(repoCacheDir, ".layout");
  if (await entry(marker)) return;
  const old = oldCacheDir(repoCacheDir);
  if ((await entry(repoCacheDir)) && !(await entry(old)))
    await rename(repoCacheDir, old);
  await mkdir(repoCacheDir, { recursive: true });
  await writeFile(marker, "2\n");
}

/** The items whose directory is in the old layout: no internal directory beside it. */
export async function oldLayoutItems(workDir: string): Promise<number[]> {
  const names = await readdir(workDir).catch((): string[] => []);
  const ids: number[] = [];
  for (const name of names) {
    const id = /^item-(\d+)$/.exec(name)?.[1];
    if (id && !names.includes(`${name}.nakara`)) ids.push(Number(id));
  }
  return ids.sort((a, b) => a - b);
}

/**
 * Migrate item-N to the current layout. Done once its internal directory
 * exists; on failure its worktrees are back in place and a retry starts over.
 */
export async function migrateItem(
  dirs: Dirs,
  itemId: number,
  repos: { owner: string; name: string }[],
  freshCache = ensureBareClone,
): Promise<void> {
  const root = join(dirs.workDir, `item-${itemId}`);
  const work = `${root}.migrating`;
  const moved: { path: string; aside: string }[] = [];
  try {
    await mkdir(join(work, "internal", "logs"), { recursive: true });
    await mkdir(join(work, "repos"), { recursive: true });
    for (const { owner, name } of repos) {
      const { path } = repoPaths(dirs, itemId, owner, name);
      const aside = join(work, "repos", name);
      if (!(await entry(aside))) {
        const stat = await entry(path);
        if (!stat) continue;
        if (!stat.isDirectory()) throw new Error(`${name} is not a directory`);
        await rename(path, aside);
      }
      moved.push({ path, aside });
      // The .git file waits beside the worktree, so a crash never leaves it with none.
      const gitlink = `${aside}.gitlink`;
      const dotGit = await entry(join(aside, ".git"));
      if (dotGit?.isFile()) await rename(join(aside, ".git"), gitlink);
      if (dotGit?.isFile() || (!dotGit && (await entry(gitlink))))
        await rebuildGitDir(dirs, owner, name, aside, gitlink, freshCache);
      else if (!dotGit?.isDirectory())
        throw new Error(`${name} is not a git worktree`);
      await rename(aside, path);
      moved.pop();
    }
    const old = join(root, ".nakara");
    if ((await entry(old))?.isDirectory()) {
      await copyFiles(old, join(work, "internal"));
      await copyFiles(join(old, "logs"), join(work, "internal", "logs"));
      // The container HOME holds the harness sessions items resume.
      const home = join(old, "home");
      if ((await entry(home))?.isDirectory() && !(await entry(`${root}.home`)))
        await rename(home, `${root}.home`);
    }
    await rename(join(work, "internal"), internalDir(dirs.workDir, itemId));
  } catch (error) {
    for (const { path, aside } of moved) {
      if (!(await entry(join(aside, ".git"))))
        await rename(`${aside}.gitlink`, join(aside, ".git")).catch(() => {});
      if (!(await entry(path))) await rename(aside, path).catch(() => {});
    }
    throw error;
  }
  await rm(join(root, ".nakara"), { recursive: true, force: true });
  await rm(work, { recursive: true, force: true });
}

/** Replace a worktree's .git file with a clone of the fresh cache on the worktree's branch and commit. */
async function rebuildGitDir(
  dirs: Dirs,
  owner: string,
  name: string,
  worktree: string,
  gitlink: string,
  freshCache: typeof ensureBareClone,
): Promise<void> {
  const old = join(oldCacheDir(dirs.repoCacheDir), owner, `${name}.git`);
  const link = /^gitdir: .*\/worktrees\/([^/]+)$/m.exec(
    (await readPlain(gitlink))?.trim() ?? "",
  )?.[1];
  if (!link || link === "." || link === "..")
    throw new Error(`${name}/.git does not name a worktree`);
  const head = await gitHead(join(old, "worktrees", link), old);
  if (!head) throw new Error(`the HEAD of ${name} cannot be read`);
  // Objects are read from the old cache only, never through another repository it names.
  if (
    !(await entry(join(old, "objects")))?.isDirectory() ||
    (await entry(join(old, "objects", "info", "alternates")))
  )
    throw new Error(`the old cache of ${owner}/${name} was tampered with`);

  const cache = await freshCache(dirs.repoCacheDir, owner, name);
  const staging = `${worktree}.git-staging`;
  await initFromCache(cache.path, staging);
  // Pack what origin lacks of HEAD's history from the old cache into the new clone.
  const known = await run(
    "git",
    ["for-each-ref", "--format=^%(objectname)", "refs/remotes"],
    staging,
  );
  const pack = exec(
    "git",
    [
      "pack-objects",
      "--revs",
      "--quiet",
      join(".git", "objects", "pack", "pack"),
    ],
    {
      cwd: staging,
      env: {
        ...process.env,
        GIT_ALTERNATE_OBJECT_DIRECTORIES: join(old, "objects"),
      },
      timeout: 600_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  pack.child.stdin?.end(`${head.commit}\n${known}\n`);
  await pack;
  if (head.branch?.startsWith("refs/heads/")) {
    await run("git", ["update-ref", head.branch, head.commit], staging);
    await run("git", ["symbolic-ref", "HEAD", head.branch], staging);
  } else
    await run(
      "git",
      ["update-ref", "--no-deref", "HEAD", head.commit],
      staging,
    );
  await run("git", ["read-tree", "HEAD"], staging);
  await rename(join(staging, ".git"), join(worktree, ".git"));
  await rm(gitlink);
  await rm(staging, { recursive: true, force: true });
}

const { O_NOFOLLOW, O_NONBLOCK, O_RDONLY } = constants;

/** Copy the regular files directly in `from` to `to`; links, FIFOs and directories are skipped. */
async function copyFiles(from: string, to: string): Promise<void> {
  if (!(await entry(from))?.isDirectory()) return;
  for (const name of await readdir(from)) {
    const file = await open(
      join(from, name),
      O_RDONLY | O_NOFOLLOW | O_NONBLOCK,
    ).catch(() => null);
    if (!file) continue;
    try {
      if ((await file.stat()).isFile())
        await writeInternal(join(to, name), await file.readFile("utf8"));
    } finally {
      await file.close();
    }
  }
}
