// Versioned schema migrations. `PRAGMA user_version` holds the version of the
// last migration applied; each pending migration runs in its own transaction
// that also bumps the version, so a failure leaves the database untouched.
import type { DatabaseSync } from "node:sqlite";

import { snapshot } from "../backup.ts";
import type { FactorySeed } from "./factories.ts";
import { baseline } from "./migrations/001-baseline.ts";
import { hotPathIndexes } from "./migrations/002-hot-path-indexes.ts";
import { interruptedRuns } from "./migrations/003-interrupted-runs.ts";
import { runInstance } from "./migrations/004-run-instance.ts";
import { factoryRegistry } from "./migrations/005-factory-registry.ts";
import { runSnapshots } from "./migrations/006-run-snapshots.ts";
import { reviewVerdicts } from "./migrations/007-review-verdicts.ts";
import { runTools } from "./migrations/008-run-tools.ts";
import { stageTransitions } from "./migrations/009-stage-transitions.ts";
import { evidence } from "./migrations/010-evidence.ts";
import { runLimits } from "./migrations/011-run-limits.ts";
import { requestEdited } from "./migrations/012-request-edited.ts";
import { learnings } from "./migrations/013-learnings.ts";
import { lessonRecurrences } from "./migrations/014-lesson-recurrences.ts";
import { factorySettings } from "./migrations/015-factory-settings.ts";
import { countedReviews } from "./migrations/016-counted-reviews.ts";
import { factoryPaused } from "./migrations/017-factory-paused.ts";
import { factoryArchive } from "./migrations/018-factory-archive.ts";
import { specRule } from "./migrations/019-spec-rule.ts";
import { automationSnapshot } from "./migrations/020-automation-snapshot.ts";
import { handoffGateChecks } from "./migrations/021-handoff-gate-checks.ts";
import { slackNotifications } from "./migrations/022-slack-notifications.ts";

export interface MigrationContext {
  /** The budget of items that predate per-item budgets. */
  defaultBudgetUsd: number;
  /** The run limit of items that predate per-item run limits; DEFAULT_MAX_RUNS when omitted. */
  defaultMaxRuns?: number | undefined;
  /** The review limit of items that predate per-item review limits; DEFAULT_MAX_REVIEWS when omitted. */
  defaultMaxReviews?: number | undefined;
  /** The revision limit of items that predate per-item revision limits; DEFAULT_MAX_REVISIONS when omitted. */
  defaultMaxRevisions?: number | undefined;
  /** Names the first factory (migration 005); called only by that migration. */
  factory?: (() => FactorySeed) | undefined;
}

export interface Migration {
  version: number;
  name: string;
  up(db: DatabaseSync, context: MigrationContext): void;
  /**
   * Undo `up` so an older release accepts the database again (`npm run
   * downgrade`). Only a migration whose undo loses nothing but its own data
   * has one; without it, a rollback restores the pre-migration snapshot.
   */
  down?(db: DatabaseSync): void;
}

/** In version order; append new migrations, never edit applied ones. */
export const MIGRATIONS: readonly Migration[] = [
  baseline,
  hotPathIndexes,
  interruptedRuns,
  runInstance,
  factoryRegistry,
  runSnapshots,
  reviewVerdicts,
  runTools,
  stageTransitions,
  evidence,
  runLimits,
  requestEdited,
  learnings,
  lessonRecurrences,
  factorySettings,
  countedReviews,
  factoryPaused,
  factoryArchive,
  specRule,
  automationSnapshot,
  handoffGateChecks,
  slackNotifications,
];

export const schemaVersion = (db: DatabaseSync): number =>
  Number(
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version,
  );

/**
 * Bring `db` to the latest schema version and return it. Refuses a database
 * from a newer Nakara. When `backup` is given and the database has tables, a
 * snapshot is taken before the first pending migration runs.
 */
export function migrate(
  db: DatabaseSync,
  options: MigrationContext & {
    backup?: { dir: string; keep: number };
    migrations?: readonly Migration[];
  },
): number {
  const migrations = options.migrations ?? MIGRATIONS;
  migrations.forEach((m, i) => {
    if (m.version !== i + 1)
      throw new Error(
        `Migration ${m.name} has version ${m.version}, expected ${i + 1}.`,
      );
  });
  const latest = migrations.length;
  const current = schemaVersion(db);
  if (current > latest)
    throw new Error(
      `The database is at schema version ${current}, but this Nakara knows versions up to ${latest}: the database is from a newer Nakara. Upgrade Nakara, or restore a snapshot taken before the upgrade.`,
    );
  const pending = migrations.slice(current);
  const first = pending[0];
  if (!first) return current;

  const hasTables = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' LIMIT 1")
    .get();
  if (options.backup && hasTables)
    snapshot(db, {
      ...options.backup,
      reason: `pre-migration-${String(first.version).padStart(3, "0")}`,
    });

  // Table rebuilds need foreign keys off; it cannot change inside a transaction.
  const foreignKeys = (
    db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }
  ).foreign_keys;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    for (const m of pending) {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Orphan rows that predate a migration are not its fault; only new ones fail it.
        const foreignKeyViolations = () =>
          db
            .prepare("PRAGMA foreign_key_check")
            .all()
            .map((v) => JSON.stringify(v));
        const before = new Set(foreignKeyViolations());
        m.up(db, options);
        const violations = foreignKeyViolations().filter((v) => !before.has(v));
        if (violations.length)
          throw new Error(
            `${violations.length} new foreign key violations, first: ${violations[0]}`,
          );
        db.exec(`PRAGMA user_version = ${m.version}`);
        db.exec("COMMIT");
      } catch (error) {
        // A failed COMMIT or a migration that ended the transaction leaves none to roll back.
        const rolledBack = db.isTransaction;
        if (rolledBack) db.exec("ROLLBACK");
        throw new Error(
          `Schema migration ${m.version} (${m.name}) failed${rolledBack ? " and was rolled back" : ""}: ${error instanceof Error ? error.message : error}`,
          { cause: error },
        );
      }
    }
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
  return latest;
}

/**
 * Undo the migrations above `target`, newest first, so a release that knows
 * versions up to `target` accepts `db`. Refuses before changing anything when
 * one of them has no `down`. With `backup`, the database is snapshotted first.
 */
export function migrateDown(
  db: DatabaseSync,
  target: number,
  options: {
    backup?: { dir: string; keep: number };
    migrations?: readonly Migration[];
  } = {},
): number {
  const migrations = options.migrations ?? MIGRATIONS;
  const current = schemaVersion(db);
  if (current > migrations.length)
    throw new Error(
      `The database is at schema version ${current}, newer than this Nakara (${migrations.length}): downgrade it with the release that migrated it.`,
    );
  if (!Number.isInteger(target) || target < 1)
    throw new Error(
      `Target version must be a positive integer, got ${target}.`,
    );
  const undo = migrations.slice(target, current).reverse();
  const stuck = undo.find((m) => !m.down);
  if (stuck)
    throw new Error(
      `Schema migration ${stuck.version} (${stuck.name}) cannot be undone: restore the pre-migration-${String(stuck.version).padStart(3, "0")} snapshot instead.`,
    );
  if (undo.length === 0) return current;
  if (options.backup)
    snapshot(db, {
      ...options.backup,
      reason: `pre-downgrade-${String(target).padStart(3, "0")}`,
    });
  for (const m of undo) {
    db.exec("BEGIN IMMEDIATE");
    try {
      m.down?.(db);
      db.exec(`PRAGMA user_version = ${m.version - 1}`);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new Error(
        `Undoing schema migration ${m.version} (${m.name}) failed: ${error instanceof Error ? error.message : error}`,
        { cause: error },
      );
    }
  }
  return target;
}
