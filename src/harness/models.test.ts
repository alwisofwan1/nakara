import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { resolveHarness } from "../definition/load.ts";
import { runTurn } from "./claude.ts";
import {
  claudeModels,
  codexModels,
  ModelCatalog,
  type ModelOption,
} from "./models.ts";

test("Claude Code's list keeps one entry per model, aliases first, without default", () => {
  const models = claudeModels([
    {
      value: "default",
      resolvedModel: "claude-opus-5-5",
      displayName: "Default",
    },
    {
      value: "opus",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus 5.5",
      supportedEffortLevels: ["low", "medium", "high", "xhigh", "max"],
    },
    {
      value: "claude-opus-5-5",
      resolvedModel: "claude-opus-5-5",
      displayName: "Opus 5.5",
    },
    {
      value: "claude-haiku-4-5-20251001",
      displayName: "Haiku 4.5",
      description: "Fastest",
    },
  ]);
  assert.deepEqual(
    models.map((m) => [m.id, m.efforts.length, m.defaultEffort]),
    [
      ["opus", 5, "high"],
      ["claude-haiku-4-5-20251001", 0, null],
    ],
  );
  assert.match(models[0]?.description ?? "", /newest opus: claude-opus-5-5/);
});

test("codex's list drops hidden models and keeps its default effort", () => {
  const models = codexModels([
    {
      model: "gpt-5.6-sol",
      displayName: "GPT-5.6-Sol",
      supportedReasoningEfforts: [
        { reasoningEffort: "low" },
        { reasoningEffort: "ultra" },
      ],
      defaultReasoningEffort: "low",
    },
    { model: "internal", displayName: "Internal", hidden: true },
  ]);
  assert.deepEqual(models, [
    {
      id: "gpt-5.6-sol",
      label: "GPT-5.6-Sol",
      description: "",
      efforts: ["low", "ultra"],
      defaultEffort: "low",
    },
  ]);
});

test("the catalog caches a list and never caches a failure", async () => {
  const model = (id: string): ModelOption => ({
    id,
    label: id,
    description: "",
    efforts: [],
    defaultEffort: null,
  });
  let calls = 0;
  let fail = true;
  const catalog = new ModelCatalog(
    { claude: "claude", codex: "codex" },
    {
      claude: async () => {
        calls++;
        if (fail) throw new Error("not logged in");
        return [model(`m${calls}`)];
      },
      codex: async () => [],
    },
  );
  await assert.rejects(catalog.list("claude"), /not logged in/);
  fail = false;
  assert.equal((await catalog.list("claude"))[0]?.id, "m2");
});

test("a CLI that exits before reading its input fails the lookup, not Nakara", async () => {
  const catalog = new ModelCatalog({ claude: "false", codex: "false" });
  await assert.rejects(catalog.list("claude"), /exited \(code 1\)/);
  await assert.rejects(catalog.list("codex"), /exited \(code 1\)/);
});

test("a chosen Claude model id runs as written, not as its family alias", () => {
  const fallback = { kind: "claude" as const, model: undefined };
  assert.deepEqual(
    resolveHarness(
      {
        harness: {
          type: "claude",
          model: "claude-opus-4-8",
          reasoningLevel: "xhigh",
        },
      },
      fallback,
    ).harness,
    { kind: "claude", model: "claude-opus-4-8", effort: "xhigh" },
  );
  assert.equal(
    resolveHarness({ model: "claude-5-opus-high" }, fallback).harness.model,
    "opus",
  );
});

test("the effort reaches each CLI in its own flag", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-effort-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = async (name: string, line: string) => {
    const path = join(dir, name);
    await writeFile(
      path,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/${name}.args"; cat > /dev/null\necho '${line}'\n`,
    );
    await chmod(path, 0o755);
    return path;
  };
  const bins = {
    claude: await fake(
      "claude",
      '{"type":"result","subtype":"success","result":"ok","total_cost_usd":0}',
    ),
    qwen: "qwen",
    codex: await fake("codex", '{"type":"turn.completed"}'),
    codexHome: join(dir, "home"),
  };
  await writeFile(join(dir, "system.md"), "");
  const base = {
    cwd: dir,
    prompt: "do it",
    systemPromptFile: join(dir, "system.md"),
    permissionMode: "bypassPermissions" as const,
    idleTimeoutMs: 10_000,
    logPath: join(dir, "log"),
  };
  await runTurn(
    { ...base, harness: "claude", model: "opus", effort: "max" },
    bins,
  );
  const claude = await readFile(join(dir, "claude.args"), "utf8");
  assert.match(claude, /^--model\nopus\n--effort\nmax\n/m);
  await runTurn(
    { ...base, harness: "codex", model: "gpt-5.6-sol", effort: "ultra" },
    bins,
  );
  const codex = await readFile(join(dir, "codex.args"), "utf8");
  assert.match(codex, /^model_reasoning_effort="ultra"$/m);
});
