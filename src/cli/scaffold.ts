// Usage: npm run scaffold -- <dir> --name <name> --repo <owner/name> [options]
// Creates a factory definition directory from the wizard's choices.
import { parseArgs } from "node:util";

import {
  type AgentRole,
  type HarnessChoice,
  type ScaffoldChoices,
  scaffold,
  type Template,
  writeTree,
} from "../definition/scaffold.ts";

const USAGE = `Usage: npm run scaffold -- <dir> --name <name> --repo <owner/name> [options]
  --template nakara|warp|import|blank   (default nakara)
  --example <folder>        Warp example (default 00-warp-default-agents)
  --from <dir>              definition to import (--template import)
  --description <text>
  --disable <agent>         triage, spec or review; repeatable
  --harness <agent=type>    claude, codex or qwen per agent; repeatable
  --intake <sources>        comma-separated: github, telegram (web is always on)
  --schedule <cron>         add a scheduled automation`;

function fail(message: string): never {
  console.error(`scaffold failed: ${message}`);
  process.exit(1);
}

const { values, positionals } = (() => {
  try {
    return parseArgs({
      allowPositionals: true,
      options: {
        name: { type: "string" },
        repo: { type: "string", multiple: true, default: [] },
        template: { type: "string", default: "nakara" },
        example: { type: "string" },
        from: { type: "string" },
        description: { type: "string" },
        disable: { type: "string", multiple: true, default: [] },
        harness: { type: "string", multiple: true, default: [] },
        intake: { type: "string" },
        schedule: { type: "string" },
      },
    });
  } catch (error) {
    return fail(`${(error as Error).message}\n${USAGE}`);
  }
})();

const [dir] = positionals;
if (!dir || !values.name) {
  console.log(USAGE);
  process.exit(1);
}

const repositories = values.repo.map((r) => {
  const [owner, name, ...rest] = r.split("/");
  if (!owner || !name || rest.length) fail(`--repo ${r} is not owner/name`);
  return { owner, name };
});

const template = ((): Template => {
  switch (values.template) {
    case "nakara":
    case "blank":
      return { kind: values.template };
    case "warp":
      return values.example
        ? { kind: "warp", example: values.example }
        : { kind: "warp" };
    case "import":
      if (!values.from) return fail("--template import needs --from <dir>");
      return { kind: "import", from: values.from };
    default:
      return fail(`unknown template "${values.template}"`);
  }
})();

const agents: NonNullable<ScaffoldChoices["agents"]> = {};
for (const role of values.disable)
  agents[role as AgentRole] = { ...agents[role as AgentRole], enabled: false };
for (const pair of values.harness) {
  const [role, harness] = pair.split("=");
  if (!role || !harness) fail(`--harness ${pair} is not agent=type`);
  if (!["claude", "codex", "qwen"].includes(harness))
    fail(`unknown harness "${harness}"`);
  agents[role as AgentRole] = {
    ...agents[role as AgentRole],
    harness: harness as HarnessChoice,
  };
}

const intake: NonNullable<ScaffoldChoices["intake"]> = {};
if (values.intake !== undefined) {
  const sources = values.intake.split(",").filter(Boolean);
  for (const source of sources)
    if (!["github", "telegram", "web"].includes(source))
      fail(`unknown intake "${source}"`);
  intake.github = sources.includes("github");
  intake.telegram = sources.includes("telegram");
}
if (values.schedule) intake.schedule = { cron: values.schedule };

const result = await scaffold({
  name: values.name,
  repositories,
  template,
  ...(values.description && { description: values.description }),
  ...(Object.keys(agents).length > 0 && { agents }),
  ...(Object.keys(intake).length > 0 && { intake }),
});
for (const w of result.warnings) console.log(`  warn  ${w.path}: ${w.message}`);
if (!result.ok) {
  for (const e of result.errors)
    console.error(`  error ${e.path}: ${e.message}`);
  fail("the definition does not validate; nothing was written");
}
try {
  await writeTree(dir, result.files);
} catch (error) {
  fail((error as Error).message);
}
const { factory } = result;
console.log(
  `✓ ${dir}: ${factory.name} (slug ${factory.slug}, label factory:${factory.name})`,
);
for (const path of [...result.files.keys()].sort()) console.log(`  ${path}`);
