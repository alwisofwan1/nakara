// `npm run scaffold` against the real script. No network: only the bundled
// templates.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { HARNESS_FALLBACK, loadDefinition } from "../definition/load.ts";

const SCAFFOLD = join(import.meta.dirname, "scaffold.ts");

const run = (...args: string[]) =>
  spawnSync(process.execPath, [SCAFFOLD, ...args], { encoding: "utf8" });

function scratch(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(join(tmpdir(), "nakara-scaffold-cli-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("scaffold writes a factory directory from the choices", async (t) => {
  const dir = join(scratch(t), "shop");
  const out = run(
    dir,
    "--name",
    "Web Shop",
    "--repo",
    "acme/shop",
    "--repo",
    "acme/web",
    "--disable",
    "triage",
    "--disable",
    "spec",
    "--disable",
    "review",
    "--harness",
    "implement=codex",
    "--intake",
    "github,telegram",
    "--schedule",
    "0 2 * * 1",
  );
  assert.equal(out.status, 0, out.stderr);
  assert.match(
    out.stdout,
    /Web Shop \(slug web-shop, label factory:Web Shop\)/,
  );
  const loaded = await loadDefinition(dir, HARNESS_FALLBACK);
  assert.ok(loaded.ok, JSON.stringify(!loaded.ok && loaded.errors));
  const d = loaded.definition;
  assert.equal(d.label, "factory:Web Shop");
  assert.deepEqual(
    d.factory.repositories.map((r) => `${r.owner}/${r.name}`),
    ["acme/shop", "acme/web"],
  );
  assert.deepEqual([...d.agents.keys()].sort(), [
    "foreman",
    "implement",
    "reflect",
  ]);
  assert.equal(d.agents.get("implement")?.harness.kind, "codex");
  assert.deepEqual(d.automations.map((a) => a.name).sort(), [
    "issue-labeled",
    "scheduled",
    "telegram-request",
  ]);
});

test("scaffold writes nothing when the choices do not validate", (t) => {
  const dir = join(scratch(t), "shop");
  const out = run(
    dir,
    "--name",
    "Web Shop",
    "--template",
    "blank",
    "--schedule",
    "every day",
  );
  assert.equal(out.status, 1);
  assert.match(out.stderr, /automations\/scheduled\/automation.md/);
  assert.equal(existsSync(dir), false);
  const usage = run(dir);
  assert.equal(usage.status, 1);
  assert.match(usage.stdout, /Usage: npm run scaffold/);
});
