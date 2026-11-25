import type { RunRowDto } from "../../src/web/api.ts";

export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (Number.isNaN(seconds)) return "at an unknown time";
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

/** A backup is stale once it is older than twice the interval, or missing. */
export function backupStale(
  backup: { at: string | null; intervalHours: number },
  now = Date.now(),
): boolean {
  if (!backup.at) return true;
  return now - Date.parse(backup.at) > backup.intervalHours * 2 * 3_600_000;
}

export const timeOfDay = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export const plural = (n: number, noun: string) =>
  `${n} ${noun}${n === 1 ? "" : "s"}`;

/** `path:line`, or just the path when the problem has no line. */
export const problemLocation = (p: { path: string; line: number | null }) =>
  p.line === null ? p.path : `${p.path}:${p.line}`;

/** A React key that stays unique when one problem is reported twice. */
export const problemKey = (
  p: { path: string; line: number | null; message: string },
  index: number,
) => `${index} ${problemLocation(p)} ${p.message}`;

/** Running runs count up from their start; queued and unfinished runs have no duration. */
export function runDuration(
  run: Pick<RunRowDto, "status" | "startedAt" | "durationMs">,
  now: number,
): number | null {
  if (run.status === "running") return now - Date.parse(run.startedAt);
  return run.durationMs;
}
