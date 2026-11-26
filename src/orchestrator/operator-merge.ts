// The Operator's merge of a Work Item's PR at Handoff (ADR-0006 rule 6).
// Only the human Operator merges, through the web API: agents keep `gh pr
// merge` on their deny lists (NEVER in run-support.ts, CODEX_RULES). The merge
// completes nothing itself; the poller sees the PR merged and delivers
// pr_merged, so the item completes through the normal path.
import type { Store } from "../db.ts";
import { checksStatus } from "../domain/checks.ts";
import { run } from "../runner/workspace.ts";
import { GH_PULL_REQUESTS, type PullRequestPort } from "./pull-request-gate.ts";

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = (typeof MERGE_METHODS)[number];

export const MERGED_MESSAGE = "Merged by the Operator";

/** GitHub as the merge reads and writes it, with Nakara's own gh; tests replace gh. */
export interface MergeIO extends Pick<PullRequestPort, "readPrChecks"> {
  /** The merge methods `owner/name` allows. */
  allowedMethods(repo: string): Promise<Record<MergeMethod, boolean>>;
  merge(prUrl: string, method: MergeMethod): Promise<unknown>;
}

export const GH_MERGE: MergeIO = {
  readPrChecks: GH_PULL_REQUESTS.readPrChecks,
  async allowedMethods(repo) {
    const out = await run(
      "gh",
      [
        "repo",
        "view",
        repo,
        "--json",
        "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed",
      ],
      undefined,
      60_000,
    );
    const allowed = JSON.parse(out) as Record<string, unknown>;
    return {
      squash: allowed.squashMergeAllowed === true,
      merge: allowed.mergeCommitAllowed === true,
      rebase: allowed.rebaseMergeAllowed === true,
    };
  },
  // Same runner as markReady. No --admin and no --delete-branch: branch
  // protection applies, and the branch stays.
  merge: (prUrl, method) =>
    run("gh", ["pr", "merge", prUrl, `--${method}`], undefined, 120_000),
};

export type MergeResult =
  | { ok: true; method: MergeMethod }
  | { ok: false; code: "not_found" | "policy"; reason: string };

const PR_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/;

/** What gh said when it failed: its stderr, else the error. */
const ghMessage = (error: unknown): string => {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const text =
    typeof stderr === "string" && stderr.trim()
      ? stderr.trim()
      : error instanceof Error
        ? error.message
        : String(error);
  return text.slice(0, 1000);
};

/** Items whose merge is in flight, so a double submit merges once. */
const merging = new Set<number>();

/**
 * Merge the item's PR for the Operator: only at handoff, with a PR not yet
 * merged, whose checks pass. Success records a factory Message and nothing
 * else; a refusal (Nakara's or GitHub's) records nothing.
 */
export async function mergePullRequest(
  store: Store,
  itemId: number,
  io: MergeIO = GH_MERGE,
): Promise<MergeResult> {
  const item = store.item(itemId);
  if (!item)
    return { ok: false, code: "not_found", reason: "Work item not found" };
  const refuse = (reason: string): MergeResult => ({
    ok: false,
    code: "policy",
    reason,
  });
  if (item.stage !== "handoff")
    return refuse("Only a work item at Handoff can be merged.");
  const prUrl = item.pr_url;
  if (!prUrl) return refuse("The work item has no pull request.");
  if (item.pr_merged) return refuse("The pull request is already merged.");
  const repo = PR_URL.exec(prUrl);
  if (!repo) return refuse("The pull request is not a GitHub pull request.");
  if (merging.has(itemId)) return refuse("The pull request is being merged.");
  merging.add(itemId);
  try {
    let status: string | null;
    try {
      status = checksStatus(await io.readPrChecks(prUrl), prUrl);
    } catch (error) {
      return refuse(`Could not read the PR checks: ${ghMessage(error)}`);
    }
    if (status) return refuse(`Checks are not passing: ${status}`);
    let method: MergeMethod | undefined;
    try {
      const allowed = await io.allowedMethods(`${repo[1]}/${repo[2]}`);
      method = MERGE_METHODS.find((m) => allowed[m]);
    } catch (error) {
      return refuse(
        `Could not read the repository settings: ${ghMessage(error)}`,
      );
    }
    if (!method) return refuse("The repository allows no merge method.");
    try {
      await io.merge(prUrl, method);
    } catch (error) {
      return refuse(ghMessage(error));
    }
    // The poller reports the merge as pr_merged; the foreman then completes.
    store.addMessage(itemId, "factory", MERGED_MESSAGE);
    return { ok: true, method };
  } finally {
    merging.delete(itemId);
  }
}
