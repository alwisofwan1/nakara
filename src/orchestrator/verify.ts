// The latest verify of a Work Item's PR head (issue #65): the repository's
// `verify` commands, run by Nakara after an implementation run whose work is
// on the PR. Kept in kv under `verify:<item>` with the PR and head it ran on:
// each verify replaces the last, recording another PR clears it, and
// PullRequestGate.refreshVerify drops one whose head the PR moved past.
import type { Store } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import { DEFAULT_VERIFY_TIMEOUT_MINUTES } from "../definition/schema.ts";
import { parsePrUrl } from "../domain/pr-url.ts";
import { short } from "../domain/pushed.ts";
import type { VerifyOutcome } from "../runner/verify.ts";

export const VERIFY = "verify:";

export interface VerifyResult extends VerifyOutcome {
  prUrl: string;
  /** The PR head the commands ran on. */
  head: string;
  /** owner/name */
  repo: string;
  /** The implementation run after which Nakara verified. */
  runId: number;
}

/** The repository of a PR URL in the definition, when it lists verify commands. */
export function verifyConfig(
  def: Definition,
  prUrl: string,
): {
  owner: string;
  name: string;
  commands: string[];
  runner: string | undefined;
  timeoutMs: number;
} | null {
  const pr = parsePrUrl(prUrl);
  if (!pr) return null;
  const repo = def.factory.repositories.find(
    (r) =>
      r.owner.toLowerCase() === pr.owner.toLowerCase() &&
      r.name.toLowerCase() === pr.name.toLowerCase(),
  );
  if (!repo?.verify?.length) return null;
  return {
    owner: repo.owner,
    name: repo.name,
    commands: repo.verify,
    runner: repo.runner,
    timeoutMs:
      (repo.verifyTimeoutMinutes ?? DEFAULT_VERIFY_TIMEOUT_MINUTES) * 60_000,
  };
}

/** The item's latest verify, or null when none ran on its current PR. */
export function latestVerify(
  store: Store,
  itemId: number,
): VerifyResult | null {
  const raw = store.getKv(VERIFY + itemId);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as VerifyResult;
  } catch {
    return null;
  }
}

export function recordVerify(store: Store, itemId: number, r: VerifyResult) {
  store.setKv(VERIFY + itemId, JSON.stringify(r));
}

export function clearVerify(store: Store, itemId: number) {
  store.setKv(VERIFY + itemId, "");
}

/**
 * The Operator answered a paused item whose verify could not run: they
 * decided how to go on, so that verify no longer holds review and handoff.
 * A failed verify stays: only a passing one lifts it.
 */
export function releaseUnrunVerify(store: Store, itemId: number) {
  if (latestVerify(store, itemId)?.status === "error")
    clearVerify(store, itemId);
}

/** The policy's part of the latest verify. */
export function verifyPolicy(
  store: Store,
  itemId: number,
): { verifyFailed: string | null; verifyUnavailable: string | null } {
  const r = latestVerify(store, itemId);
  return {
    verifyFailed: r?.status === "failed" ? (r.failed ?? "a command") : null,
    verifyUnavailable:
      r?.status === "error" ? (r.reason ?? "unknown reason") : null,
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** A fence longer than any backtick run in `text`, so the output cannot close it. */
const fence = (text: string) =>
  "`".repeat(
    Math.max(3, ...(text.match(/`+/g) ?? []).map((r) => r.length + 1)),
  );

/** What the foreman reads under "Checked by Nakara". */
export function verifySummary(r: VerifyResult): string {
  const where = `${r.repo} at ${short(r.head)}`;
  const lines = r.commands.map(
    (c) =>
      `- ${c.ok ? "pass" : "fail"} \`${c.command}\` (${seconds(c.durationMs)})`,
  );
  const fullOutput = `The full output is on the page of run #${r.runId}.`;
  if (r.status === "passed")
    return `Verify passed on ${where}:\n${lines.join("\n")}`;
  if (r.status === "failed") {
    const tail = r.tail ?? "";
    const f = fence(tail);
    return [
      `Verify FAILED on ${where}: \`${r.failed}\` failed.`,
      lines.join("\n"),
      `Last lines of its output (at most 200):\n${f}text\n${tail}\n${f}`,
      `${fullOutput} Review and handoff are refused while this verify fails. Send the implementation agent a follow_up with the failure; it counts toward the revision cap. Nakara verifies again when that run reports success.`,
    ].join("\n\n");
  }
  return [
    `Verify could not run on ${where}: ${r.reason}`,
    lines.length ? lines.join("\n") : "",
    `This is not a failure of the change. The work item is paused for the Operator: review and handoff are refused until the Operator answers. Do not send a follow_up about it; end your turn.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** What the Operator reads when a verify could not run. */
export const verifyPaused = (r: VerifyResult) =>
  `Nakara could not run the verify commands of ${r.repo} on ${short(r.head)}: ${r.reason}\nReview and handoff wait for you. Fix the cause (the runner, Docker, or verifyTimeoutMinutes in factory.yaml), then send a message to go on without this verify; the next implementation run verifies again.`;

/** Where a run's verify output is kept: beside its log, `run-<id>.verify.log`. */
export const verifyLogPath = (runLog: string) =>
  `${runLog.replace(/\.jsonl$/, "")}.verify.log`;
