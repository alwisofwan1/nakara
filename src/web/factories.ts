import { z } from "zod";

import type { FactoryRepository } from "../db/factories.ts";
import type { Commit } from "../definition/history.ts";
import { FOLDER, REPO } from "./wizard.ts";

/** The registered factories the shell lists, oldest (the default) first. */
export function readFactories(factories: FactoryRepository) {
  return factories.factories().map((f) => ({
    slug: f.slug,
    name: f.name,
    avatarColor: f.avatar_color,
  }));
}
export type FactoryDto = ReturnType<typeof readFactories>[number];

/** A factory's Settings page; undefined for an unknown slug. */
export function readFactorySettings(
  factories: FactoryRepository,
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
    definition: {
      mode: record.definition_mode,
      dir: record.definition_dir,
      repositories: running.repositories,
      history: running.history,
      archiveDir: running.archiveDir,
    },
  };
}
export type FactorySettingsDto = NonNullable<
  ReturnType<typeof readFactorySettings>
>;

export const renameInput = z.object({
  name: z.string().trim().min(1, "Enter a factory name").max(200),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-f]{6}$/i, "avatarColor must be #rrggbb"),
});

export const moveInput = z.object({
  repo: z.string().regex(REPO, "repo must be owner/name"),
  folder: z
    .string()
    .max(200)
    .regex(FOLDER, "folder must be a relative path such as factory"),
});
