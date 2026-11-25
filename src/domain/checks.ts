import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export interface PrCheck {
  name: string;
  bucket: "pass" | "fail" | "pending" | "skipping" | "cancel";
}

const failedNames = (checks: PrCheck[]): string =>
  checks
    .filter((c) => c.bucket === "fail" || c.bucket === "cancel")
    .map((c) => c.name)
    .join(", ");

/** Why a handoff is refused, phrased as an instruction for the foreman. */
export function checksRefusal(checks: PrCheck[]): string | null {
  const failed = failedNames(checks);
  if (failed)
    return `Checks failed: ${failed}. Send fixes to the implementation agent with follow_up (subject to the revision cap).`;
  if (checks.some((c) => c.bucket === "pending"))
    return "Checks pending. End your turn; completion will wake you.";
  return null;
}

/** The operator's view of a refused handoff: CI status without foreman instructions. */
export function checksStatus(checks: PrCheck[], prUrl: string): string | null {
  const failed = failedNames(checks);
  if (failed) return `CI failed on ${prUrl}: ${failed}`;
  if (checks.some((c) => c.bucket === "pending"))
    return `Waiting for CI on ${prUrl}`;
  return null;
}

export async function readPrChecks(
  prUrl: string,
  json = true,
): Promise<PrCheck[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(
      "gh",
      ["pr", "checks", prUrl, ...(json ? ["--json", "name,bucket"] : [])],
      { timeout: 60_000 },
    ));
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    if (json && result.stderr?.includes("unknown flag: --json"))
      return readPrChecks(prUrl, false);
    // gh uses 1 for failures/no checks and 8 for pending checks.
    if (
      result.code === 1 &&
      /^no checks reported\b/i.test(result.stderr?.trim() ?? "")
    )
      return checksNotReported(prUrl);
    if ((result.code !== 1 && result.code !== 8) || !result.stdout?.trim())
      throw error;
    stdout = result.stdout;
  }
  const rows: unknown = json
    ? JSON.parse(stdout)
    : stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, state] = line.split("\t");
          return { name, bucket: state };
        });
  if (
    !Array.isArray(rows) ||
    rows.some(
      (c) =>
        !c ||
        typeof c.name !== "string" ||
        !["pass", "fail", "pending", "skipping", "cancel"].includes(c.bucket),
    )
  )
    throw new Error("Invalid response from gh pr checks");
  return rows.length ? (rows as PrCheck[]) : checksNotReported(prUrl);
}

export const checksReadError = (error: unknown): string =>
  `Could not read PR checks: ${String(error)}\nNakara's gh needs Checks/Actions read access. Resolve access or connectivity, then send a message to retry.`;

async function checksNotReported(prUrl: string): Promise<PrCheck[]> {
  const match =
    /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/.exec(prUrl);
  if (!match) throw new Error("Invalid GitHub pull request URL");
  const { stdout: prJson } = await exec(
    "gh",
    ["api", `repos/${match[1]}/${match[2]}/pulls/${match[3]}`],
    { timeout: 60_000 },
  );
  const pr = JSON.parse(prJson) as {
    head: { sha: string; repo: { full_name: string } };
  };
  const { stdout: treeJson } = await exec(
    "gh",
    [
      "api",
      `repos/${pr.head.repo.full_name}/git/trees/${pr.head.sha}?recursive=1`,
    ],
    { timeout: 60_000 },
  );
  const tree = JSON.parse(treeJson) as {
    truncated: boolean;
    tree: { path: string; type: string }[];
  };
  if (tree.truncated)
    throw new Error(
      "PR head file tree is truncated; cannot determine whether workflows exist",
    );
  return tree.tree.some(
    (file) =>
      file.type === "blob" && file.path.startsWith(".github/workflows/"),
  )
    ? [{ name: "Workflow checks not yet reported", bucket: "pending" }]
    : [];
}
