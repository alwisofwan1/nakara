// On-host snapshots of nakara.db. `VACUUM INTO` writes a consistent copy from
// inside the process, so it is safe in WAL mode while Nakara keeps writing;
// copying the .db file with `cp` is not.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type Logger, silentLogger } from "./telemetry/log.ts";

export interface BackupConfig {
  dir: string;
  /** Scheduled snapshots kept; older ones are deleted after each snapshot. */
  keep: number;
  intervalHours: number;
}

export interface Snapshot {
  path: string;
  /** ISO time the snapshot was taken, read back from the file name. */
  at: string;
  reason: string;
}

const SNAPSHOT =
  /^nakara-(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z)-([\w-]+)\.db$/;
/** A copy of a database that a restore replaced, not of the running one. */
const PRE_RESTORE = "pre-restore";
/** Taken by the timer; the only snapshots that `keep` prunes. */
const SCHEDULED = "scheduled";

const fileTime = (iso: string) => iso.replace(/[:.]/g, "-");
const isoTime = (stamp: string) =>
  stamp.replace(/T(\d\d)-(\d\d)-(\d\d)-(\d{3})Z$/, "T$1:$2:$3.$4Z");

/** Snapshots in `dir`, newest first. */
export function listSnapshots(dir: string): Snapshot[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .flatMap((name) => {
      const [, stamp, reason] = SNAPSHOT.exec(name) ?? [];
      return stamp && reason
        ? [{ path: join(dir, name), at: isoTime(stamp), reason }]
        : [];
    })
    .sort((a, b) => b.at.localeCompare(a.at) || b.path.localeCompare(a.path));
}

/** The newest snapshot of the running database; backup age and schedule follow it. */
export const latestSnapshot = (dir: string): Snapshot | null =>
  listSnapshots(dir).find((s) => s.reason !== PRE_RESTORE) ?? null;

/** `PRAGMA integrity_check` result: "ok" or the problems SQLite found. */
export function integrityCheck(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (
      db.prepare("PRAGMA integrity_check").all() as {
        integrity_check: string;
      }[]
    )
      .map((row) => row.integrity_check)
      .join("\n");
  } finally {
    db.close();
  }
}

/**
 * Write a consistent copy of `db` to `<dir>/nakara-<time>-<reason>.db`, verify
 * it and keep the newest `keep` scheduled snapshots. Callers such as a schema
 * migration pass a reason that ends up in the file name; snapshots with any
 * other reason are never pruned.
 */
export function snapshot(
  db: DatabaseSync,
  options: { dir: string; keep: number; reason: string },
): Snapshot {
  if (!Number.isInteger(options.keep) || options.keep < 1)
    throw new Error(
      `Snapshots to keep must be a whole number ≥ 1, not ${options.keep}.`,
    );
  const reason = options.reason.replace(/[^\w-]+/g, "-") || "manual";
  mkdirSync(options.dir, { recursive: true });
  const at = new Date().toISOString();
  const path = join(options.dir, `nakara-${fileTime(at)}-${reason}.db`);
  // A partial file never looks like a snapshot: write aside, then rename.
  const partial = `${path}.partial`;
  rmSync(partial, { force: true });
  try {
    db.prepare("VACUUM INTO ?").run(partial);
    const check = integrityCheck(partial);
    if (check !== "ok")
      throw new Error(`Snapshot failed integrity check: ${check}`);
    renameSync(partial, path);
  } finally {
    rmSync(partial, { force: true });
  }
  const scheduled = listSnapshots(options.dir).filter(
    (s) => s.reason === SCHEDULED,
  );
  for (const old of scheduled.slice(options.keep))
    rmSync(old.path, { force: true });
  return { path, at, reason };
}

/** Age of the newest snapshot; stale when older than twice the interval or missing. */
export function backupHealth(config: BackupConfig, now = Date.now()) {
  const last = latestSnapshot(config.dir);
  const ageSeconds = last
    ? Math.max(0, Math.floor((now - Date.parse(last.at)) / 1000))
    : null;
  return {
    at: last?.at ?? null,
    ageSeconds,
    stale: ageSeconds === null || ageSeconds > config.intervalHours * 7200,
  };
}

/** Takes a snapshot whenever the newest one is older than the interval. */
export class Backups {
  private timer: NodeJS.Timeout | undefined;
  readonly db: DatabaseSync;
  readonly config: BackupConfig;
  private readonly log: Logger;
  constructor(
    db: DatabaseSync,
    config: BackupConfig,
    log: Logger = silentLogger,
  ) {
    this.db = db;
    this.config = config;
    this.log = log;
  }

  snapshot(reason: string): Snapshot {
    return snapshot(this.db, { ...this.config, reason });
  }

  start(): void {
    const interval = this.config.intervalHours * 3_600_000;
    const tick = () => {
      const last = latestSnapshot(this.config.dir);
      let due = last ? Date.parse(last.at) + interval - Date.now() : 0;
      if (due <= 0) {
        try {
          this.snapshot(SCHEDULED);
        } catch (error) {
          this.log.error("backup.failed", { error });
        }
        due = interval;
      }
      // Re-check at least hourly so a deleted snapshot is replaced in time.
      this.timer = setTimeout(tick, Math.min(due, 3_600_000));
      this.timer.unref();
    };
    tick();
  }

  stop(): void {
    clearTimeout(this.timer);
  }
}

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const inUse = (error: unknown) =>
  [SQLITE_BUSY, SQLITE_LOCKED].includes(
    (error as { errcode?: number }).errcode ?? -1,
  );

/**
 * Replace the database at `dbPath` with `file`. Refuses while another
 * connection (Nakara, Litestream) has the database open. The current database
 * is snapshotted first, so a restore can be undone; when it cannot be read it
 * is moved aside as `<dbPath>.pre-restore-<time>` instead.
 */
export function restoreSnapshot(
  file: string,
  dbPath: string,
  config: BackupConfig,
): {
  previous: Snapshot | null;
  unreadable: { path: string; error: string } | null;
} {
  if (!existsSync(file)) throw new Error(`No such file: ${file}`);
  const check = integrityCheck(file);
  if (check !== "ok")
    throw new Error(`${file} failed integrity check: ${check}`);
  mkdirSync(dirname(dbPath), { recursive: true });
  // Copy first: pruning after the safety snapshot may delete `file` itself.
  const incoming = `${dbPath}.restore`;
  copyFileSync(file, incoming);
  // Closing the connection below may delete an unreadable database's WAL.
  const walCopy = `${dbPath}.restore-wal`;
  try {
    if (existsSync(`${dbPath}-wal`)) copyFileSync(`${dbPath}-wal`, walCopy);
    let previous: Snapshot | null = null;
    let unreadable: { path: string; error: string } | null = null;
    if (existsSync(dbPath)) {
      let failure: unknown = null;
      const current = new DatabaseSync(dbPath);
      try {
        // Keep an exclusive lock until close, so nobody writes until the swap.
        current.exec(
          "PRAGMA busy_timeout = 0; PRAGMA locking_mode = EXCLUSIVE",
        );
        current.exec("BEGIN EXCLUSIVE; COMMIT");
        previous = snapshot(current, { ...config, reason: PRE_RESTORE });
      } catch (error) {
        if (inUse(error))
          throw new Error(
            `${dbPath} is in use by another process: stop Nakara and Litestream first.`,
          );
        failure = error;
      } finally {
        current.close();
      }
      if (failure) {
        const aside = `${dbPath}.${PRE_RESTORE}-${fileTime(new Date().toISOString())}`;
        renameSync(dbPath, aside);
        if (existsSync(walCopy)) renameSync(walCopy, `${aside}-wal`);
        unreadable = {
          path: aside,
          error: failure instanceof Error ? failure.message : String(failure),
        };
      }
    }
    // A leftover WAL belongs to the old database and would be replayed onto the new one.
    for (const suffix of ["-wal", "-shm"])
      rmSync(`${dbPath}${suffix}`, { force: true });
    renameSync(incoming, dbPath);
    return { previous, unreadable };
  } finally {
    rmSync(incoming, { force: true });
    rmSync(walCopy, { force: true });
  }
}
