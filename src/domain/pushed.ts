// Whether an implement run's work reached the PR is Nakara's call, not the
// agent's: the worktree's HEAD must be the PR's head on GitHub, or an
// ancestor of it. A commit that was never pushed is not on GitHub at all.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { Definition } from "../definition/load.ts";
import { worktreeHead } from "../runner/head.ts";
import { parsePrUrl as parsePr } from "./pr-url.ts";

const exec = promisify(execFile);

/** The commit a pull request's branch is at on GitHub. */
export interface PrHead {
  sha: string;
  branch: string;
}

/** GitHub, through gh; tests replace it. */
export interface PrIO {
  readPrHead(prUrl: string): Promise<PrHead>;
  /** Whether `sha` is the PR head or one of its ancestors. */
  onPr(prUrl: string, sha: string, head: PrHead): Promise<boolean>;
}

function parsePrUrl(prUrl: string) {
  const pr = parsePr(prUrl);
  if (!pr) throw new Error("Invalid GitHub pull request URL");
  return pr;
}

export const GH_PR: PrIO = {
  async readPrHead(prUrl) {
    const { owner, name, number } = parsePrUrl(prUrl);
    const { stdout } = await exec(
      "gh",
      ["api", `repos/${owner}/${name}/pulls/${number}`],
      { timeout: 60_000 },
    );
    const pr = JSON.parse(stdout) as { head?: { sha?: string; ref?: string } };
    if (typeof pr.head?.sha !== "string" || typeof pr.head.ref !== "string")
      throw new Error("Invalid response from GitHub for the pull request");
    return { sha: pr.head.sha, branch: pr.head.ref };
  },
  async onPr(prUrl, sha, head) {
    if (sha === head.sha) return true;
    const { owner, name } = parsePrUrl(prUrl);
    try {
      const { stdout } = await exec(
        "gh",
        ["api", `repos/${owner}/${name}/compare/${sha}...${head.sha}`],
        { timeout: 60_000 },
      );
      const { status } = JSON.parse(stdout) as { status?: string };
      // The PR head is `sha` or ahead of it.
      return status === "identical" || status === "ahead";
    } catch (error) {
      // GitHub does not know a commit that was never pushed.
      if (/HTTP (404|422)\b/.test(String((error as Error).message)))
        return false;
      throw error;
    }
  },
};

/** A worktree whose HEAD is not on the PR. */
export interface Unpushed {
  /** owner/name */
  slug: string;
  /** The worktree's HEAD, or null when it cannot be read. */
  local: string | null;
  head: PrHead;
}

/**
 * The PR repository's worktree in the item's workspace, when its HEAD is not
 * on the PR. Without that worktree (a PR in another repository, a removed
 * workspace) there is nothing to compare.
 */
export async function findUnpushed(
  io: PrIO,
  def: Definition,
  workDir: string,
  itemId: number,
  prUrl: string,
  head: PrHead,
): Promise<Unpushed | null> {
  const { owner, name } = parsePrUrl(prUrl);
  const repo = def.factory.repositories.find(
    (r) =>
      r.owner.toLowerCase() === owner?.toLowerCase() &&
      r.name.toLowerCase() === name?.toLowerCase(),
  );
  if (!repo) return null;
  const worktree = join(workDir, `item-${itemId}`, repo.name);
  const slug = `${repo.owner}/${repo.name}`;
  const local = await worktreeHead(worktree);
  if (local === null)
    return (await exists(worktree)) ? { slug, local, head } : null;
  return (await io.onPr(prUrl, local, head)) ? null : { slug, local, head };
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export const prHeadReadError = (prUrl: string, error: unknown): string =>
  `Could not look up ${prUrl} on GitHub to check that the work is on it: ${String(error)}\nNakara's gh needs read access to the repository's pull requests and commits. Resolve access or connectivity, then send a message to retry.`;

/** Why the work is not on the PR, phrased as an instruction for the foreman. */
export function unpushedRefusal(u: Unpushed, prUrl: string): string {
  const where =
    u.local === null
      ? `Nakara could not read the HEAD of the ${u.slug} worktree`
      : `The ${u.slug} worktree is at ${u.local}`;
  return `The work is not on the PR: ${where}, but ${prUrl} is at ${u.head.sha} (branch ${u.head.branch}), and its checks ran there. Send the implementation agent a follow_up to push its commits, e.g. \`git push origin HEAD:${u.head.branch}\`, before you hand off.`;
}

/** What a refused handoff adds to the refusal while the push-only follow_up is unused. */
export const PUSH_ONLY_OFFER =
  "Use follow_up with push_only: true: Nakara sends the implementation agent a push-only prompt, and it does not count toward the revision cap. It is offered once; if the work is still not on the PR after it, the item waits for a human.";

/** The push-only follow_up's prompt, written by Nakara rather than the foreman. */
export const pushOnlyPrompt = (branch: string) =>
  `Push only. Nakara checked the PR and your committed work is not on it: the PR branch \`${branch}\` on GitHub does not contain your worktree's HEAD. Push the commits you already made, e.g. \`git push origin HEAD:${branch}\`, then confirm that \`gh pr view --json headRefOid\` shows your HEAD. Make no code changes: do not edit files, commit, amend, rebase or force-push, and do not address anything else. If the push is rejected, report why instead. Report the pushed SHA.`;

/** The operator's view once the push-only follow_up did not get the work onto the PR. */
export function unpushedPaused(u: Unpushed, prUrl: string): string {
  return `The work is still not on ${prUrl} after a push-only follow-up: the ${u.slug} worktree is at ${u.local ? short(u.local) : "an unreadable HEAD"}, the PR at ${short(u.head.sha)}. Push the commits by hand (\`git push origin HEAD:${u.head.branch}\` in the worktree), or tell the factory how to proceed.`;
}

/** The operator's view of the same: no foreman instructions. */
export function unpushedStatus(u: Unpushed, prUrl: string): string {
  return `The work is not on ${prUrl} yet: the ${u.slug} worktree is at ${u.local ? short(u.local) : "an unreadable HEAD"}, the PR at ${short(u.head.sha)}. Waiting for it to be pushed.`;
}

export const short = (sha: string) => sha.slice(0, 7);
