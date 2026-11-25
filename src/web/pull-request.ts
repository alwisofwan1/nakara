import { run } from "../runner/workspace.ts";

export interface PullRequestDto {
  title: string;
  repo: string;
  head: string;
  /** The commit the PR's branch is at: the one its checks ran on. */
  headSha: string;
  base: string;
  additions: number;
  deletions: number;
  checks: "passing" | "failing" | "pending" | "none";
}

/** The subset of `gh pr view --json` that the PR handoff card reads. */
export interface GhPullRequest {
  title: string;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  statusCheckRollup?: {
    status?: string;
    conclusion?: string;
    state?: string;
  }[];
}
export type FetchPullRequest = (url: string) => Promise<GhPullRequest>;

export const fetchGithubPullRequest: FetchPullRequest = async (url) =>
  JSON.parse(
    await run(
      "gh",
      [
        "pr",
        "view",
        url,
        "--json",
        "title,headRefName,headRefOid,baseRefName,additions,deletions,statusCheckRollup",
      ],
      undefined,
      60_000,
    ),
  );

const FAILED = new Set([
  "FAILURE",
  "ERROR",
  "CANCELLED",
  "TIMED_OUT",
  "ACTION_REQUIRED",
  "STARTUP_FAILURE",
]);

/** Check runs carry status and conclusion; commit statuses carry state. */
export function pullRequestDto(url: string, pr: GhPullRequest): PullRequestDto {
  const checks = pr.statusCheckRollup ?? [];
  const outcome = checks.map((c) => c.conclusion || c.state || "");
  return {
    title: pr.title,
    repo: /github\.com\/([^/]+\/[^/]+)\//.exec(url)?.[1] ?? "",
    head: pr.headRefName,
    headSha: pr.headRefOid,
    base: pr.baseRefName,
    additions: pr.additions,
    deletions: pr.deletions,
    checks:
      checks.length === 0
        ? "none"
        : outcome.some((o) => FAILED.has(o))
          ? "failing"
          : checks.some(
                (c, i) =>
                  (c.status && c.status !== "COMPLETED") ||
                  outcome[i] === "PENDING" ||
                  outcome[i] === "EXPECTED" ||
                  outcome[i] === "",
              )
            ? "pending"
            : "passing",
  };
}
