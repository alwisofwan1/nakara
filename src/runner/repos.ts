// Clone or access status of each factory repository, refreshed by fetching its
// bare clone. A repository the agent token cannot read keeps its gh error.
// The real guard against merges and force pushes is branch protection on
// GitHub, so the check also warns when the default branch lacks it.
import type { Store } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import { ensureBareClone, run } from "./workspace.ts";

export interface RepoStatus {
  checkedAt: string;
  /** Last successful clone or fetch; kept when a later fetch fails. */
  fetchedAt: string | null;
  defaultBranch: string | null;
  error: string | null;
  /** Why the default branch is not safe from agents; null when it is or was not checked. */
  protection?: string | null;
}

export type RepoProbe = (
  cacheDir: string,
  owner: string,
  name: string,
) => Promise<{ defaultBranch: string; protection?: string | null }>;

export type GhApi = (path: string) => Promise<string>;

const key = (slug: string) => `repo:${slug}`;

export function readRepoStatus(store: Store, slug: string): RepoStatus | null {
  const value = store.getKv(key(slug));
  return value ? JSON.parse(value) : null;
}

/** `gh: <last line of stderr>`, so the reason survives without the command line. */
export function commandError(error: unknown): string {
  const e = error as { cmd?: string; stderr?: string; message?: string };
  const tool = e.cmd?.split(" ")[0];
  const lines = (e.stderr || e.message || String(error))
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.at(-1) ?? "failed";
  return (tool ? `${tool}: ${reason}` : reason).slice(0, 500);
}

/**
 * Whether `branch` requires an approved pull request and refuses force pushes,
 * through rulesets (readable with repository read access) or classic branch
 * protection (needs Administration read; counts only when it binds
 * administrators too). Ruleset bypass actors are not visible to this check.
 * Returns the warning, or null.
 */
export async function branchProtection(
  owner: string,
  name: string,
  branch: string,
  gh: GhApi = (path) => run("gh", ["api", path], undefined, 60_000),
): Promise<string | null> {
  const repo = `repos/${owner}/${name}`;
  const ref = encodeURIComponent(branch);
  // `gh api` already prefixes its errors with `gh:`.
  const reason = (error: unknown) =>
    commandError(error).replace(/^gh: gh: /, "gh: ");
  let review = false;
  let noForce = false;
  let rulesUnreadable: string | null = null;
  let rules: unknown = [];
  try {
    rules = JSON.parse(await gh(`${repo}/rules/branches/${ref}`));
  } catch (error) {
    rulesUnreadable = reason(error);
  }
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (
      rule?.type === "pull_request" &&
      (rule.parameters?.required_approving_review_count ?? 0) > 0
    )
      review = true;
    if (rule?.type === "non_fast_forward") noForce = true;
  }
  if (review && noForce) return null;
  let unreadable: string | null = null;
  let adminsBypass = false;
  try {
    const classic = JSON.parse(await gh(`${repo}/branches/${ref}/protection`));
    if (classic?.enforce_admins?.enabled) {
      if (
        (classic.required_pull_request_reviews
          ?.required_approving_review_count ?? 0) > 0
      )
        review = true;
      if (!classic.allow_force_pushes?.enabled) noForce = true;
    } else adminsBypass = true;
  } catch (error) {
    const why = reason(error);
    // "Not protected" only settles it when the rulesets could be read as well.
    if (!/Branch not protected/i.test(why)) unreadable = why;
    else unreadable = rulesUnreadable;
  }
  if (review && noForce) return null;
  if (unreadable)
    return `Could not verify that ${branch} requires reviewed pull requests (${unreadable}). Protect it on GitHub.`;
  return [
    !review &&
      `${branch} allows direct pushes or merges without an approving review`,
    !noForce && `${branch} allows force pushes`,
    adminsBypass &&
      `its classic branch protection does not apply to administrators (enable "Do not allow bypassing the above settings")`,
  ]
    .filter(Boolean)
    .join("; ")
    .concat(". Protect it on GitHub: agents run with a token that can push.");
}

/** The default probe: fetch the bare clone, then check the default branch's protection. */
export const probeRepository: RepoProbe = async (cacheDir, owner, name) => {
  const { defaultBranch } = await ensureBareClone(cacheDir, owner, name);
  return {
    defaultBranch,
    protection: await branchProtection(owner, name, defaultBranch),
  };
};

export async function checkRepositories(
  store: Store,
  def: Definition,
  cacheDir: string,
  probe: RepoProbe = probeRepository,
): Promise<void> {
  // The factory's default probe is the bare clone alone; add the protection check.
  const check = probe === ensureBareClone ? probeRepository : probe;
  for (const repo of def.factory.repositories) {
    if (repo.deferred) continue;
    const slug = `${repo.owner}/${repo.name}`;
    const previous = readRepoStatus(store, slug);
    const checkedAt = new Date().toISOString();
    let status: RepoStatus;
    try {
      const { defaultBranch, protection } = await check(
        cacheDir,
        repo.owner,
        repo.name,
      );
      status = {
        checkedAt,
        fetchedAt: checkedAt,
        defaultBranch,
        error: null,
        protection: protection ?? null,
      };
    } catch (error) {
      status = {
        checkedAt,
        fetchedAt: previous?.fetchedAt ?? null,
        defaultBranch: previous?.defaultBranch ?? null,
        error: commandError(error),
        protection: previous?.protection ?? null,
      };
    }
    store.setKv(key(slug), JSON.stringify(status));
    store.notify({ type: "definition", id: "global" });
  }
}

/** Security warnings for the UI and /healthz: unprotected default branches. */
export function protectionWarnings(store: Store, def: Definition): string[] {
  return def.factory.repositories.flatMap((repo) => {
    if (repo.deferred) return [];
    const slug = `${repo.owner}/${repo.name}`;
    const protection = readRepoStatus(store, slug)?.protection;
    return protection ? [`${slug}: ${protection}`] : [];
  });
}
