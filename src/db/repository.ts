import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import type { Notifier } from "./notifier.ts";

export const now = () => new Date().toISOString();

/** Run `fn` in an immediate transaction on `db`, rolling back when it throws. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Typed statements on the shared connection. Writes notify nothing by
 * themselves: each write method notifies its channels explicitly.
 */
export abstract class Repository {
  protected readonly db: DatabaseSync;
  protected readonly notifier: Notifier;

  constructor(db: DatabaseSync, notifier: Notifier) {
    this.db = db;
    this.notifier = notifier;
  }

  protected all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }
  protected get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }
  /** Run a write; returns the last inserted rowid. */
  protected run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.db.prepare(sql).run(...params).lastInsertRowid);
  }
}
