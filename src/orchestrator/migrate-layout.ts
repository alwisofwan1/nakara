// The startup migration of item directories still in the old layout; the
// file work is in runner/migrate.ts.
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../config.ts";
import type { Store } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import {
  migrateItem,
  moveOldCaches,
  oldCacheDir,
  oldLayoutItems,
} from "../runner/migrate.ts";
import { type ensureBareClone, internalDir } from "../runner/workspace.ts";
import type { Telemetry } from "../telemetry/metrics.ts";
import { pauseItem } from "./run-support.ts";

/**
 * At startup, before orphaned runs are recovered, migrate the item
 * directories still in the old layout. An item that cannot be migrated is
 * paused with the reason; the others go on. A complete or cancelled item is
 * left as it is: nothing runs in it again.
 */
export async function migrateOldLayout(
  store: Store,
  dirs: Pick<Config, "workDir" | "repoCacheDir">,
  definitionFor: (itemId: number) => Definition | undefined,
  telemetry: Telemetry,
  freshCache?: typeof ensureBareClone,
): Promise<void> {
  await moveOldCaches(dirs.repoCacheDir);
  for (const id of await oldLayoutItems(dirs.workDir)) {
    const item = store.item(id);
    if (!item || item.stage === "complete" || item.stage === "cancelled")
      continue;
    try {
      const def = definitionFor(id);
      if (!def) throw new Error("its factory's definition is not loaded");
      await migrateItem(dirs, id, def.factory.repositories, freshCache);
      store.moveRunLogs(
        id,
        join(dirs.workDir, `item-${id}`, ".nakara"),
        internalDir(dirs.workDir, id),
      );
      telemetry.log.info("item.migrated", { item_id: id });
    } catch (error) {
      telemetry.log.warn("item.migration_failed", { item_id: id, error });
      pauseItem(
        store,
        telemetry.log,
        id,
        `Could not move this item's workspace to the new layout: ${String((error as Error).message ?? error).slice(0, 1500)}. Its files are unchanged; restart Nakara to retry.`,
      );
    }
  }
  const old = oldCacheDir(dirs.repoCacheDir);
  if (existsSync(old))
    telemetry.log.warn("startup.old_caches_kept", {
      path: old,
      message: `${old} holds the repository caches from before the upgrade, with local branches and unpushed commits migration did not carry. Delete it once nothing there is needed.`,
    });
}
