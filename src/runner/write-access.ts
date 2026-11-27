// Who may direct a factory from GitHub: a user with write access to the
// repository. Issue intake asks it of whoever applied the label, and the PR
// feedback poller of whoever wrote a review or comment.
import { run } from "./workspace.ts";

/** Repository permissions that may start or direct work. */
const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"]);

/**
 * Whether a user has write access to a repository; null when GitHub cannot
 * tell (an API failure), so the caller neither trusts nor remembers a refusal.
 * `env` is gh's token, e.g. a factory's agent token; unset, gh's login asks.
 */
export async function hasWriteAccess(
  repo: string,
  login: string,
  env?: Record<string, string>,
): Promise<boolean | null> {
  try {
    const out = await run(
      "gh",
      [
        "api",
        `repos/${repo}/collaborators/${login}/permission`,
        "--jq",
        ".permission",
      ],
      undefined,
      60_000,
      env,
    );
    return WRITE_PERMISSIONS.has(out.trim());
  } catch {
    return null;
  }
}
