// Each work item gets a directory with its own clone of every factory
// repository, sharing the objects of a private cache (a bare clone only the
// host's fetch writes, mounted read-only into containers). Agents work there on
// the host (local runner, not a sandbox) or in a container (runner with a
// dockerImage, see docker.ts). Host git never runs in an item's clone, which
// the agent controls, config and hooks included. Nakara's own files for the
// item sit beside that directory, never inside an agent mount (ADR 0003).
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";

import type { Definition } from "../definition/load.ts";
import {
  containerHome,
  DEFAULT_EGRESS_ALLOW,
  dockerize,
  type DockerSpec,
  ensureEgress,
} from "./docker.ts";
import { hostEnv } from "./env.ts";
import { excludeProof } from "./evidence.ts";

const exec = promisify(execFile);
const exists = (p: string) =>
  stat(p).then(
    () => true,
    () => false,
  );

export interface Workspace {
  root: string;
  /** Nakara-private files (prompts, MCP config, logs, actions, diffs); outside every agent mount. */
  internal: string;
  repos: {
    slug: string;
    path: string;
    /** The repository's cache, read-only to agents. */
    bare: string;
    /** Nakara's own object directory for the item's snapshots. */
    objects: string;
    defaultBranch: string;
  }[];
}

/** `env` is added to Nakara's environment, e.g. a GH_TOKEN; it never reaches argv. */
export async function run(
  cmd: string,
  args: string[],
  cwd?: string,
  timeoutMs = 600_000,
  env?: Record<string, string>,
): Promise<string> {
  const { stdout } = await exec(cmd, args, {
    cwd,
    ...(env && { env: { ...process.env, ...env } }),
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.trim();
}

/** Where an item's internal files live: beside its directory, so no agent mount includes it. */
export const internalDir = (workDir: string, itemId: number) =>
  join(workDir, `item-${itemId}.nakara`);

/** Where an item's clone of a repository, its cache and its snapshot objects are. */
export const repoPaths = (
  dirs: { workDir: string; repoCacheDir: string },
  itemId: number,
  owner: string,
  name: string,
) => ({
  path: join(dirs.workDir, `item-${itemId}`, name),
  bare: join(dirs.repoCacheDir, owner, `${name}.git`),
  objects: join(internalDir(dirs.workDir, itemId), "objects", name),
});

const { O_APPEND, O_CREAT, O_NOFOLLOW, O_RDONLY, O_TRUNC, O_WRONLY } =
  constants;

/** Write an internal file; a symlink in its place is an error, never followed. */
export const writeInternal = (path: string, data: string, mode = 0o644) =>
  writeFile(path, data, {
    flag: O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW,
    mode,
  });

/** Append to an internal file without following a symlink. */
export const appendInternal = (path: string, data: string) =>
  appendFile(path, data, { flag: O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW });

/** Open an internal file for appending (a run log) without following a symlink. */
export const openInternal = (path: string) =>
  open(path, O_WRONLY | O_CREAT | O_APPEND | O_NOFOLLOW);

/**
 * `path` resolved, if it is a file inside the item's internal directory;
 * null otherwise, so the UI never serves a file elsewhere on the host.
 */
export async function internalFile(
  workDir: string,
  itemId: number,
  path: string,
): Promise<string | null> {
  try {
    const real = await realpath(path);
    const rel = relative(await realpath(internalDir(workDir, itemId)), real);
    const outside = rel === ".." || rel.startsWith(`..${sep}`);
    return rel && !outside && !isAbsolute(rel) ? real : null;
  } catch {
    return null;
  }
}

/** Read an internal file, or null when it is missing or not inside the item's internal directory. */
export async function readInternal(
  workDir: string,
  itemId: number,
  path: string,
): Promise<string | null> {
  const real = await internalFile(workDir, itemId, path);
  return real
    ? readFile(real, { encoding: "utf8", flag: O_RDONLY | O_NOFOLLOW }).catch(
        () => null,
      )
    : null;
}

const locks = new Map<string, Promise<unknown>>();
/** Serialize operations on one path: a cache's fetches, an item clone's creation. */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

export async function ensureBareClone(
  cacheDir: string,
  owner: string,
  name: string,
): Promise<{ path: string; defaultBranch: string }> {
  const path = join(cacheDir, owner, `${name}.git`);
  return withLock(path, async () => {
    if (!(await exists(path))) {
      await mkdir(join(cacheDir, owner), { recursive: true });
      await run("gh", [
        "repo",
        "clone",
        `${owner}/${name}`,
        path,
        "--",
        "--bare",
        "--quiet",
      ]);
      await run(
        "git",
        [
          "config",
          "remote.origin.fetch",
          "+refs/heads/*:refs/remotes/origin/*",
        ],
        path,
      );
    }
    // Item clones borrow its objects, so gc must never prune one.
    await run(
      "git",
      ["-c", "gc.pruneExpire=never", "fetch", "--prune", "--quiet", "origin"],
      path,
    );
    const head = await run(
      "git",
      ["ls-remote", "--symref", "origin", "HEAD"],
      path,
    );
    const defaultBranch =
      /ref: refs\/heads\/(\S+)\s+HEAD/.exec(head)?.[1] ?? "main";
    return { path, defaultBranch };
  });
}

/**
 * Clone the cache into `path`: made in a directory Nakara owns, then moved
 * into place, so host git never runs in agent-writable files. Its objects stay
 * in the cache (alternates), so a clone costs little disk; its origin is the
 * cache's, so agents push to GitHub as before.
 */
async function cloneFromCache(
  cache: string,
  defaultBranch: string,
  staging: string,
  path: string,
): Promise<void> {
  await initFromCache(cache, staging);
  await run(
    "git",
    ["checkout", "--quiet", "--detach", `origin/${defaultBranch}`],
    staging,
  );
  await rename(staging, path);
}

/** A new repository in `staging` with the cache's objects, origin and remote branches; nothing checked out. */
export async function initFromCache(
  cache: string,
  staging: string,
): Promise<void> {
  await rm(staging, { recursive: true, force: true });
  await run("git", ["init", "--quiet", staging]);
  await writeFile(
    join(staging, ".git", "objects", "info", "alternates"),
    `${join(cache, "objects")}\n`,
  );
  const url = await run("git", ["config", "--get", "remote.origin.url"], cache);
  await run("git", ["remote", "add", "origin", url], staging);
  await run(
    "git",
    ["fetch", "--quiet", cache, "+refs/remotes/origin/*:refs/remotes/origin/*"],
    staging,
  );
}

export async function prepareWorkspace(
  def: Definition,
  itemId: number,
  dirs: { workDir: string; repoCacheDir: string },
  onlyRepo: string | null,
  claudeBin = "claude",
): Promise<Workspace> {
  const root = join(dirs.workDir, `item-${itemId}`);
  const internal = internalDir(dirs.workDir, itemId);
  await mkdir(root, { recursive: true });
  await mkdir(join(internal, "logs"), { recursive: true });

  const wanted = def.factory.repositories.filter(
    (r) => !r.deferred && (!onlyRepo || `${r.owner}/${r.name}` === onlyRepo),
  );
  const repos: Workspace["repos"] = [];
  for (const r of wanted) {
    const slug = `${r.owner}/${r.name}`;
    const { path, objects } = repoPaths(dirs, itemId, r.owner, r.name);
    const bare = await ensureBareClone(dirs.repoCacheDir, r.owner, r.name);
    // The agent and foreman runners may prepare one item at once.
    await withLock(path, async () => {
      if (await exists(path)) return;
      await cloneFromCache(
        bare.path,
        bare.defaultBranch,
        join(internal, `clone-${r.name}`),
        path,
      );
      await runSetup(def, path, root, internal, [bare.path], claudeBin);
    });
    // Also for clones made before proof existed. A clone that cannot take it
    // still runs; the agent is told not to commit the proof either way.
    await excludeProof(path).catch(() => undefined);
    repos.push({
      slug,
      path,
      bare: bare.path,
      objects,
      defaultBranch: bare.defaultBranch,
    });
  }
  return { root, internal, repos };
}

/** The container an agent on `runner` works in, or undefined for the host. */
export async function dockerSpec(
  def: Definition,
  runner: string | undefined,
  ws: Workspace,
): Promise<DockerSpec | undefined> {
  const r = runner ? def.runners.get(runner) : undefined;
  const image = r?.platform?.linux?.dockerImage;
  if (!image) return undefined;
  // The definition is mounted read-only: agent prompts point at its skill files.
  // The caches are too: clones read their objects through alternates.
  return {
    image,
    mounts: [ws.root],
    readOnly: [def.root, ...ws.repos.map((x) => x.bare)],
    shape: r.instanceShape,
    home: await containerHome(ws.root),
    egress: await ensureEgress(r.egress?.allow ?? DEFAULT_EGRESS_ALLOW, image),
  };
}

async function runSetup(
  def: Definition,
  repoPath: string,
  root: string,
  internal: string,
  caches: string[],
  claudeBin: string,
): Promise<void> {
  // Setup runs once per clone, so it uses the factory-wide default runner.
  const name = def.factory.agentDefaults.runner;
  const runner = name ? def.runners.get(name) : undefined;
  const image = runner?.platform?.linux?.dockerImage;
  for (const command of runner?.setupCommands ?? []) {
    try {
      if (image) {
        const spec = {
          image,
          mounts: [root],
          readOnly: caches,
          shape: runner?.instanceShape,
          home: await containerHome(root),
          egress: await ensureEgress(
            runner?.egress?.allow ?? DEFAULT_EGRESS_ALLOW,
            image,
          ),
        };
        const c = dockerize(
          spec,
          claudeBin,
          repoPath,
          ["bash", "-lc", command],
          {},
        );
        await exec(c.cmd, c.args, {
          env: c.env,
          timeout: 1_800_000,
          maxBuffer: 16 * 1024 * 1024,
        });
      } else
        await exec("bash", ["-lc", command], {
          cwd: repoPath,
          env: hostEnv(),
          timeout: 1_800_000,
          maxBuffer: 16 * 1024 * 1024,
        });
    } catch (error) {
      await appendInternal(
        join(internal, "logs", "setup.log"),
        `$ ${command}\n${String(error)}\n`,
      );
    }
  }
}

/** Remove an item's clones and container home once it is complete or cancelled; logs stay for the UI. */
export async function removeWorkspace(
  itemId: number,
  dirs: { workDir: string },
) {
  const root = join(dirs.workDir, `item-${itemId}`);
  // A plain delete: rm never follows the symlinks an agent left in there.
  await rm(root, { recursive: true, force: true });
  await rm(`${root}.home`, { recursive: true, force: true });
}
