// One Nakara per database. The orchestrator keeps "in flight" in memory and
// startup recovery interrupts every run it does not own, so a second process
// on the same database would dispatch everything twice and interrupt the first
// one's live runs. The lock is SQLite's own exclusive file lock on a separate
// `<name>.lock` next to the database: the kernel drops it when the process
// dies, `kill -9` included, so a crash never leaves a stale lock behind.
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { DatabaseSync } from "node:sqlite";

/** The process that holds the lock; stored in kv so a refused start can name it. */
export interface Instance {
  id: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

export const INSTANCE_KEY = "instance";

const SQLITE_BUSY = 5;

/**
 * The locks this process holds. A collected connection closes, which would
 * drop its lock while the process still runs; only unlockDatabase() may.
 */
const held = new Set<DatabaseSync>();

/** Another Nakara holds the database. */
export class DatabaseLocked extends Error {}

const lockPath = (dbPath: string): string =>
  `${dbPath.replace(/\.db$/, "")}.lock`;

export function newInstance(): Instance {
  return {
    id: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    startedAt: new Date().toISOString(),
  };
}

/**
 * Take the exclusive lock of the database at `dbPath`, or fail at once when
 * another Nakara holds it. unlockDatabase() releases it.
 */
export function lockDatabase(dbPath: string): DatabaseSync {
  const path = lockPath(dbPath);
  const lock = new DatabaseSync(path);
  try {
    // No journal: the lock file stays empty and nothing is ever written to it.
    lock.exec(
      "PRAGMA busy_timeout = 0; PRAGMA journal_mode = MEMORY; BEGIN EXCLUSIVE",
    );
    held.add(lock);
    return lock;
  } catch (error) {
    lock.close();
    if ((error as { errcode?: number }).errcode !== SQLITE_BUSY) throw error;
    throw new DatabaseLocked(
      `Another Nakara (${holderText(readHolder(dbPath))}) is using ${dbPath}: it holds ${path}. Stop it first; two instances on one database would run every foreman turn and agent run twice.`,
    );
  }
}

export function unlockDatabase(lock: DatabaseSync): void {
  held.delete(lock);
  lock.close();
}

/**
 * The holder as far as we can tell. The record is written after the lock is
 * taken and the database migrated, so in between it names the previous
 * holder: say so when that process is gone. A PID on another host cannot be
 * checked.
 */
function holderText(holder: Instance | undefined): string {
  if (!holder) return "another process";
  const started = `started ${holder.startedAt}`;
  if (holder.hostname !== hostname())
    return `last recorded as PID ${holder.pid} on host ${holder.hostname}, ${started}`;
  if (!alive(holder.pid))
    return `another process; the last recorded holder, PID ${holder.pid} (${started}), is no longer running`;
  return `PID ${holder.pid} on this host, ${started}`;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The last instance that took the lock, as it recorded itself; best effort. */
function readHolder(dbPath: string): Instance | undefined {
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT value FROM kv WHERE key = ?")
        .get(INSTANCE_KEY) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as Instance) : undefined;
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}
