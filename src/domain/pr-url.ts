// A GitHub pull request's identity, read from its URL. Pure: the policy, the
// pull request gate and the verify state compare PRs with it, so two
// spellings of one PR (a trailing slash, a query or fragment, other casing
// of owner or repository, which GitHub ignores) are the same PR everywhere.

export interface PrIdentity {
  owner: string;
  name: string;
  /** The PR number, without leading zeros. */
  number: string;
}

const PR_URL =
  /^https:\/\/github\.com\/([^/?#]+)\/([^/?#]+)\/pull\/(\d+)\/?(?:[?#].*)?$/i;

/** The owner, repository and number of a GitHub PR URL; null when it is not one. */
export function parsePrUrl(url: string): PrIdentity | null {
  const m = PR_URL.exec(url.trim());
  if (!m?.[1] || !m[2] || !m[3]) return null;
  return { owner: m[1], name: m[2], number: String(Number(m[3])) };
}

/**
 * Whether two URLs name the same GitHub PR: owner and repository compared
 * case-insensitively, the number exactly. Two strings that are not PR URLs
 * are the same only when they are equal.
 */
export function samePr(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || b == null) return a === b;
  const x = parsePrUrl(a);
  const y = parsePrUrl(b);
  if (!x || !y) return a === b;
  return (
    x.owner.toLowerCase() === y.owner.toLowerCase() &&
    x.name.toLowerCase() === y.name.toLowerCase() &&
    x.number === y.number
  );
}
