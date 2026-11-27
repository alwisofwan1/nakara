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

/**
 * An id written as Nakara writes one, decimal digits without leading zeros,
 * from 1 up to Number.MAX_SAFE_INTEGER; anything else (a malformed or
 * oversized key or folder name) is no id, and is neither counted nor removed.
 */
const parseId = (text: string | undefined): number | undefined => {
  if (!text || !/^[1-9]\d{0,15}$/.test(text)) return undefined;
  const id = Number(text);
  return id <= Number.MAX_SAFE_INTEGER ? id : undefined;
};

/** The id in `<prefix><id>` or `<prefix><id>:…`, or undefined. */
const idIn = (key: string, prefix: string): number | undefined =>
  parseId(/^([^:]*)(:|$)/.exec(key.slice(prefix.length))?.[1]);

const highest = (ids: (number | undefined)[]): number =>
  ids.reduce<number>((max, id) => Math.max(max, id ?? 0), 0);

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
  ).map((name) => parseId(/^item-([^.]*)(\.nakara|\.home)?$/.exec(name)?.[1]));
  store.repos.factories.reserveIds("work_items", highest(itemDirs));
  const factories = new Set(store.repos.factories.factories().map((f) => f.id));
  const applied = (
    await readdir(join(dataDir, "applied")).catch(() => [] as string[])
  ).flatMap((name) => parseId(name) ?? []);
  store.repos.factories.reserveIds("factories", highest(applied));
  for (const id of applied) {
    if (factories.has(id)) continue;
    const path = appliedDir(dataDir, id);
    await rm(path, { recursive: true, force: true });
    log.info("startup.stale_state_removed", { factory_id: id, path });
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
