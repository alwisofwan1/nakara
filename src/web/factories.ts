import { z } from "zod";

import type { Repositories } from "../db.ts";
import type { Commit } from "../definition/history.ts";
import { SPEC_RULES } from "../domain/policy.ts";
import { FOLDER, REPO } from "./wizard.ts";

/** The registered factories the shell lists, oldest (the default) first. */
export function readFactories(
  repos: Pick<Repositories, "factories" | "factorySettings">,
) {
  return repos.factories.factories().map((f) => ({
    slug: f.slug,
    name: f.name,
    avatarColor: f.avatar_color,
    // The sidebar shows a Paused chip.
    paused: repos.factorySettings.pausedAt(f.id) !== null,
  }));
}
export type FactoryDto = ReturnType<typeof readFactories>[number];

/** A factory's Settings page; undefined for an unknown slug. */
export function readFactorySettings(
  repos: Pick<Repositories, "factories" | "factorySettings">,
  slug: string,
  running: {
    /** The `owner/name` repositories of the applied definition. */
    repositories: string[];
    /** The GitHub label of the applied definition, if one is loaded. */
    label: string | null;
    /** The managed definition's latest commits, newest first. */
    history: Commit[];
    /** Where a move would archive the managed definition; null in a repository. */
    archiveDir: string | null;
    /** Where a delete saves its database snapshot. */
    backupDir: string;
  },
) {
  const { factories, factorySettings } = repos;
  const record = factories.factory(slug);
  if (!record) return undefined;
  return {
    slug: record.slug,
    name: record.name,
    avatarColor: record.avatar_color,
    foremanHandle: record.foreman_handle,
    label: running.label,
    // The first factory takes Telegram and work without a factory.
    isDefault: factories.defaultFactory().id === record.id,
    activeItems: factories.activeItems(record.id),
    backupDir: running.backupDir,
    // What new Work Items copy; null-saved limits show their default.
    limits: factorySettings.settings(record.id),
    ...pauseState(factorySettings.pausedAt(record.id)),
    definition: {
      mode: record.definition_mode,
      dir: record.definition_dir,
      repositories: running.repositories,
      history: running.history,
      archiveDir: running.archiveDir,
    },
  };
}
/** Whether a factory is paused, and since when; what pause and resume return. */
export const pauseState = (pausedAt: string | null) => ({
  paused: pausedAt !== null,
  pausedAt,
});

export type FactorySettingsDto = NonNullable<
  ReturnType<typeof readFactorySettings>
>;

export const renameInput = z.object({
  name: z.string().trim().min(1, "Enter a factory name").max(200),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "avatarColor must be #rrggbb"),
});

const limit = (min: number, max: number, step: number) =>
  z
    .number()
    .min(min, `must be at least ${min}`)
    .max(max, `must be at most ${max}`)
    .multipleOf(step, `must be a multiple of ${step}`)
    .nullable()
    .optional();

/**
 * A limits edit: each key optional, null resets it to the environment default
 * (`when_asked` for the Spec rule).
 */
export const limitsInput = z.strictObject({
  budgetUsd: limit(1, 100, 0.5),
  maxReviews: limit(1, 5, 1),
  maxRevisions: limit(0, 5, 1),
  maxRuns: limit(5, 200, 1),
  specRule: z.enum(SPEC_RULES).nullable().optional(),
});

export const moveInput = z.object({
  repo: z.string().regex(REPO, "repo must be owner/name"),
  folder: z
    .string()
    .max(200)
    .regex(FOLDER, "folder must be a relative path such as factory"),
});
