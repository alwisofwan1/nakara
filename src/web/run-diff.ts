import type { Run } from "../db.ts";
import {
  diffFile,
  diffRepos,
  type RepoDiff,
  type RepoSnapshot,
} from "../runner/snapshot.ts";
import { readInternal, repoPaths } from "../runner/workspace.ts";

export type RepoDiffDto = RepoDiff;

/**
 * A run's diff, one entry per repository. `log`: none was recorded (a run
 * before snapshots, a foreman turn, or a run cut short before its diff was
 * written); the page shows the edits from its log.
 */
export type RunDiffDto =
  | { source: "log" }
  | {
      source: "git";
      /** The run is still going: its end is the worktree as it is now. */
      live: boolean;
      repos: RepoDiffDto[];
    };

/** How long a live run's diff is reused: each one snapshots its worktrees. */
export const LIVE_DIFF_TTL_MS = 10_000;

/**
 * Live run diffs by run: concurrent requests share one computation, and its
 * result is reused for `ttlMs` after it completes. A failed one is not kept.
 */
export class LiveDiffs {
  private readonly entries = new Map<
    number,
    { promise: Promise<RepoDiffDto[]>; at: number | null }
  >();
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(ttlMs = LIVE_DIFF_TTL_MS, now: () => number = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
  }

  get(runId: number, compute: () => Promise<RepoDiffDto[]>) {
    const now = this.now();
    for (const [id, entry] of this.entries)
      if (entry.at !== null && now - entry.at >= this.ttlMs)
        this.entries.delete(id);
    const cached = this.entries.get(runId);
    if (cached) return cached.promise;
    const entry = {
      promise: compute(),
      at: null as number | null,
    };
    this.entries.set(runId, entry);
    entry.promise.then(
      () => {
        entry.at = this.now();
      },
      () => {
        if (this.entries.get(runId) === entry) this.entries.delete(runId);
      },
    );
    return entry.promise;
  }
}

export async function readRunDiff(
  run: Run,
  dirs: { workDir: string; repoCacheDir: string },
  options: { live?: LiveDiffs; maxBytes?: number } = {},
): Promise<RunDiffDto> {
  const snapshots: RepoSnapshot[] = run.snapshots
    ? JSON.parse(run.snapshots)
    : [];
  if (!snapshots.length) return { source: "log" };
  if (run.status === "running") {
    const repos = snapshots.map(({ slug }) => {
      const [owner = "", name = ""] = slug.split("/");
      return { slug, ...repoPaths(dirs, run.item_id, owner, name) };
    });
    const compute = () => diffRepos(snapshots, repos, options.maxBytes);
    return {
      source: "git",
      live: true,
      repos: await (options.live
        ? options.live.get(run.id, compute)
        : compute()),
    };
  }
  // An ended run's diff was written when it ended.
  if (!run.log_path) return { source: "log" };
  try {
    const text = await readInternal(
      dirs.workDir,
      run.item_id,
      diffFile(run.log_path),
    );
    if (text === null) return { source: "log" };
    const repos = JSON.parse(text) as RepoDiffDto[];
    return { source: "git", live: false, repos };
  } catch {
    return { source: "log" };
  }
}
