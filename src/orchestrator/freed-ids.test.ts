import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store, stubFactorySeed } from "../db.ts";
import { Logger } from "../telemetry/log.ts";
import { sweepFreedIds } from "./freed-ids.ts";

test("the startup sweep reserves the ids folders show, and removes only the state of factories and items that are gone", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "nakara-freed-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const workDir = join(dataDir, "work");
  const store = new Store(join(dataDir, "nakara.db"), {
    defaultBudgetUsd: 15,
    factory: stubFactorySeed,
  });
  t.after(() => store.close());
  const factory = store.repos.factories.defaultFactory().id;
  const item = store.createItem({ title: "a", request: "r", source: "manual" });
  // A deleted factory 9 left its applied copy, and deleted items 30 and 40 their folders.
  for (const dir of [
    join(dataDir, "applied", String(factory)),
    join(dataDir, "applied", "9"),
    join(workDir, "item-30.nakara"),
    join(workDir, "item-40.home"),
    join(workDir, "item-x"),
  ])
    await mkdir(dir, { recursive: true });
  const kept = [
    `reach:${factory}`,
    `reach:${factory}:pending`,
    "reach:default",
    `reflect:factory:${factory}:unchecked`,
    `run-limit-told:${item.id}`,
    `reflect:${item.id}:event`,
    `ci-wait:${item.id}`,
    "tg:cursor",
  ];
  const removed = [
    "reach:9",
    "reach:9:repos",
    "reflect:factory:9:unchecked",
    "run-limit-told:30",
    "reflect:30:event",
    "pr-closed:30:https://github.com/acme/a/pull/1",
    "slack:item:30",
    "merge-submitted:31",
  ];
  for (const key of [...kept, ...removed]) store.setKv(key, "1");

  const lines: string[] = [];
  await sweepFreedIds(
    store,
    { dataDir, workDir },
    new Logger({ write: (line) => lines.push(line), secrets: [] }),
  );

  for (const key of kept) assert.equal(store.getKv(key), "1", key);
  for (const key of removed) assert.equal(store.getKv(key), undefined, key);
  assert.ok(existsSync(join(dataDir, "applied", String(factory))));
  assert.equal(existsSync(join(dataDir, "applied", "9")), false);
  // The item folders keep their logs.
  assert.ok(existsSync(join(workDir, "item-30.nakara")));
  const logged = lines.map((l) => JSON.parse(l));
  assert.ok(logged.every((l) => l.event === "startup.stale_state_removed"));
  assert.deepEqual(
    logged.map((l) => l.key ?? l.path).sort(),
    [...removed, join(dataDir, "applied", "9")].sort(),
  );
  // Ids the folders show are not handed out.
  assert.equal(
    store.repos.factories.createFactory({ ...stubFactorySeed(), slug: "new" })
      .id,
    10,
  );
  assert.equal(
    store.createItem({ title: "b", request: "r", source: "manual" }).id,
    41,
  );

  // A second sweep finds nothing, and never lowers the next id.
  lines.length = 0;
  await sweepFreedIds(
    store,
    { dataDir, workDir },
    new Logger({ write: (line) => lines.push(line), secrets: [] }),
  );
  assert.deepEqual(lines, []);
  assert.equal(
    store.createItem({ title: "c", request: "r", source: "manual" }).id,
    42,
  );
});
