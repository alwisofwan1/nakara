import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Store, stubFactorySeed } from "../db.ts";

import { CODEX_RULES } from "../harness/codex-home.ts";
import { type MergeIO, mergePullRequest } from "./operator-merge.ts";
import { NEVER } from "./run-support.ts";

// The Operator's merge endpoint must not open merging to agents (ADR-0006 rule 6).
test("agents stay unable to merge: the claude deny list and codex rules forbid gh pr merge", () => {
  assert.ok(NEVER.includes("Bash(gh pr merge:*)"));
  assert.match(
    CODEX_RULES,
    /^prefix_rule\(pattern = \["gh", "pr", "merge"\], decision = "forbidden"\)$/m,
  );
});

test("a submitted merge is refused again after a restart until the poller reports it", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-merge-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "nakara.db");
  const merges: string[] = [];
  const io: MergeIO = {
    readPrChecks: async () => [{ name: "CI", bucket: "pass" }],
    allowedMethods: async () => ({ squash: true, merge: true, rebase: true }),
    merge: async (url, method) => {
      merges.push(`${url} --${method}`);
    },
  };
  const PR = "https://github.com/o/r/pull/7";
  let store = new Store(path, {
    factory: stubFactorySeed,
    defaultBudgetUsd: 15,
  });
  const item = store.createItem({ title: "T", request: "R", source: "manual" });
  store.updateItem(item.id, { stage: "handoff", pr_url: PR });
  assert.deepEqual(await mergePullRequest(store, item.id, io), {
    ok: true,
    method: "squash",
  });
  store.close();

  store = new Store(path, { factory: stubFactorySeed, defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const again = await mergePullRequest(store, item.id, io);
  assert.equal(again.ok, false);
  assert.deepEqual(merges, [`${PR} --squash`]);
  // A new PR for the item can be merged.
  const next = "https://github.com/o/r/pull/8";
  store.updateItem(item.id, { pr_url: next });
  assert.equal((await mergePullRequest(store, item.id, io)).ok, true);
  assert.deepEqual(merges, [`${PR} --squash`, `${next} --squash`]);
});
