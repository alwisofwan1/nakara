// The first factory of a database that predates the factory registry, named
// after the running definition's label (`factory:<alias>`).
import { join, relative } from "node:path";

import type { Config } from "../config.ts";
import type { FactorySeed } from "../db.ts";
import { HARNESS_DEFAULT, loadDefinition } from "./load.ts";

const AVATAR_COLOR = "#6d4aff";

/** A URL- and handle-safe form of a factory name: `Nakara Web` → `nakara-web`. */
export function slugify(name: string): string {
  return (
    name
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "factory"
  );
}

/**
 * The seed as the Store takes it: migration 005 calls it only when it runs,
 * so a definition that does not load refuses that migration and nothing else.
 */
export async function lazyFactorySeed(
  config: Pick<Config, "definitionDir" | "dataDir">,
): Promise<() => FactorySeed> {
  return factorySeed(config).then(
    (seed) => () => seed,
    (error: unknown) => () => {
      throw error;
    },
  );
}

export async function factorySeed(
  config: Pick<Config, "definitionDir" | "dataDir">,
): Promise<FactorySeed> {
  const dir = config.definitionDir;
  const loaded = await loadDefinition(dir, HARNESS_DEFAULT);
  if (!loaded.ok)
    throw new Error(
      `The definition at ${dir} must load to name the first factory: ${loaded.errors
        .map((e) => `${e.path}: ${e.message}`)
        .join("; ")}`,
    );
  const { alias, factory } = loaded.definition;
  const managed = relative(join(config.dataDir, "factories"), dir);
  return {
    slug: slugify(alias),
    name: alias,
    description: factory.description?.trim() ?? "",
    avatar_color: AVATAR_COLOR,
    foreman_handle: slugify(alias),
    definition_dir: dir,
    definition_mode:
      managed && !managed.startsWith("..") && !managed.startsWith("/")
        ? "managed"
        : "repo",
  };
}
