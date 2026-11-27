// State keyed by a factory or item id that outlived its row. Ids are not
// handed out again (migration 023), and a factory delete removes what it
// keys; this startup sweep counts the ids folders on disk show as used, and
// removes what a delete before either left behind.
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Logger } from "../telemetry/log.ts";
import { ITEM_KV_PREFIXES } from "./item-keys.ts";

/** Where the last applied copy of a registered factory's definition is kept. */
export const appliedDir = (dataDir: string, factoryId: number): string =>
  join(dataDir, "applied", String(factoryId));

/** kv keys `<prefix><factory id>` or `<prefix><factory id>:…`. */
const FACTORY_KV_PREFIXES = ["reach:", "reflect:factory:"];

/** The id in `<prefix><id>` or `<prefix><id>:…`, or undefined. */
const idIn = (key: string, prefix: string): number | undefined => {
  const id = /^(\d+)(:|$)/.exec(key.slice(prefix.length))?.[1];
  return id === undefined ? undefined : Number(id);
};

/**
 * Before the factories load: reserve the factory ids of the applied/
 * folders and the item ids of the work/ folders, then remove the applied/
 * folders and the kv keys of factories and items that no longer exist,
 * logging each. A factory or item that exists is never touched. An item's
 * work/ folders stay: its logs are kept, as for any closed item, in case a
 * snapshot from before the delete is restored.
 */
export async function sweepFreedIds(
  store: Store,
  dirs: Pick<Config, "dataDir" | "workDir">,
  log: Logger,
): Promise<void> {
  const { dataDir } = dirs;
  const itemDirs = (
    await readdir(dirs.workDir).catch(() => [] as string[])
  ).flatMap((name) => /^item-(\d+)(\.nakara|\.home)?$/.exec(name)?.[1] ?? []);
  store.repos.factories.reserveIds(
    "work_items",
    Math.max(0, ...itemDirs.map(Number)),
  );
  const factories = new Set(store.repos.factories.factories().map((f) => f.id));
  const applied = (
    await readdir(join(dataDir, "applied")).catch(() => [] as string[])
  ).filter((name) => /^\d+$/.test(name));
  store.repos.factories.reserveIds(
    "factories",
    Math.max(0, ...applied.map(Number)),
  );
  for (const name of applied) {
    if (factories.has(Number(name))) continue;
    const path = join(dataDir, "applied", name);
    await rm(path, { recursive: true, force: true });
    log.info("startup.stale_state_removed", { factory_id: name, path });
  }
  const sweep = (
    prefixes: readonly string[],
    exists: (id: number) => boolean,
    field: string,
  ) => {
    for (const prefix of prefixes)
      for (const key of store.repos.kv.kvKeys(prefix)) {
        const id = idIn(key, prefix);
        if (id === undefined || exists(id)) continue;
        store.repos.kv.deleteKv(key);
        log.info("startup.stale_state_removed", { [field]: id, key });
      }
  };
  sweep(FACTORY_KV_PREFIXES, (id) => factories.has(id), "factory_id");
  sweep(ITEM_KV_PREFIXES, (id) => store.item(id) !== undefined, "item_id");
}
