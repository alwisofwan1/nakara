/** A repository as factory.yaml lists it. */
export interface RepoRef {
  owner: string;
  name: string;
}

// GitHub's characters, as the server's input check has them.
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/**
 * The repository an "Add repository" input names, or why it cannot be added;
 * null while the input is empty, so nothing is shown yet. A github.com URL is
 * taken too. GitHub compares names case-insensitively, so a listed one in
 * another spelling is already listed.
 */
export function parseRepo(
  input: string,
  listed: string[],
): { repo: RepoRef } | { error: string } | null {
  const text = input
    .trim()
    .replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, "")
    .replace(/(?:\.git)?\/?$/, "");
  if (!text) return null;
  const [owner = "", name = "", ...rest] = text.split("/");
  if (rest.length || !OWNER.test(owner) || !NAME.test(name))
    return { error: "Enter a repository as owner/name, such as acme/web." };
  const repo = `${owner}/${name}`.toLowerCase();
  if (listed.some((r) => r.toLowerCase() === repo))
    return {
      error: `${owner}/${name} is already a repository of this factory.`,
    };
  return { repo: { owner, name } };
}

/** The reach line a repository adds, as the server's reachOf writes it. */
const reachLine = (repo: string) => `repository ${repo}`;

/**
 * One row per repository factory.yaml lists: whether it waits for the
 * Operator's approval, whether it can be removed (a factory keeps at least
 * one), and the `verify` commands Nakara runs on its PRs.
 */
export function repoRows(
  repositories: string[],
  pendingReach: string[] | null,
  verify: Record<string, string[]> = {},
) {
  const pending = new Set(pendingReach ?? []);
  return repositories.map((repo) => ({
    repo,
    pending: pending.has(reachLine(repo)),
    removable: repositories.length > 1,
    verify: verify[repo] ?? [],
  }));
}

/** What one save does: add a repository or remove one. */
export type RepoChange = { add: RepoRef } | { remove: string };

/** The `owner/name` a change adds or removes. */
export const repoOf = (change: RepoChange) =>
  "add" in change ? `${change.add.owner}/${change.add.name}` : change.remove;

/**
 * Whether the refusal of the failed `change` shows at `place`: under the
 * "Add repository" input (`"add"`) or under the row of an `owner/name`.
 */
export function refusedAt(
  change: RepoChange | undefined,
  place: "add" | string,
): boolean {
  if (!change) return false;
  return place === "add"
    ? "add" in change
    : "remove" in change && change.remove === place;
}
