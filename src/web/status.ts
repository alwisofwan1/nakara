import { type BackupConfig, latestSnapshot } from "../backup.ts";
import type { Store } from "../db.ts";
import { inboxCount } from "./inbox.ts";

export interface FactoryStatusDto {
  slug: string;
  /** False until a valid definition is loaded; a failed reload keeps the last valid one. */
  loaded: boolean;
  /** Errors of the last load or reload. */
  errors: number;
  /** The running definition's repositories (0 when none is loaded). */
  repositories: number;
}

export interface StatusDto {
  /** Each factory's definition, in registry order. */
  factories: FactoryStatusDto[];
  github: { at: string; error: string | null } | null;
  telegram: { configured: boolean };
  slots: { busy: number; total: number };
  /** Open items that need you, as listed in the Inbox. */
  inbox: number;
  /** The newest snapshot; stale once older than twice the interval. */
  backup: { at: string | null; intervalHours: number };
}

/** Read-only projection; no clock, network, writes, or credentials in the DTO. */
export function readStatus(
  store: Store,
  options: {
    telegramConfigured: boolean;
    concurrency: number;
    factories: FactoryStatusDto[];
    backup: BackupConfig;
  },
): StatusDto {
  const poll = store.getKv("github:lastPoll");
  return {
    factories: options.factories,
    github: poll ? JSON.parse(poll) : null,
    telegram: { configured: options.telegramConfigured },
    slots: {
      busy: store.runningRuns().filter((run) => run.role === "agent").length,
      total: options.concurrency,
    },
    inbox: inboxCount(store),
    backup: {
      at: latestSnapshot(options.backup.dir)?.at ?? null,
      intervalHours: options.backup.intervalHours,
    },
  };
}
