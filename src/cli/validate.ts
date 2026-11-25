// Usage: npm run validate -- <definition-dir> [...]
import { resolve } from "node:path";

import { loadDefinition } from "../definition/load.ts";

let failed = false;
for (const dir of process.argv.slice(2)) {
  const result = await loadDefinition(resolve(dir), {
    kind: "claude",
    model: undefined,
  });
  console.log(`${result.ok ? "✓" : "✗"} ${dir}`);
  if (result.ok) {
    const d = result.definition;
    const agents = [...d.agents.values()].map(
      (a) =>
        `${a.name}(${a.type}, ${a.harness.kind}${a.harness.model ? `:${a.harness.model}` : ""})`,
    );
    console.log(
      `  alias=${d.alias} repos=${d.factory.repositories.map((r) => `${r.owner}/${r.name}`).join(",")}`,
    );
    console.log(`  agents: ${agents.join(" ")}`);
    console.log(
      `  automations: ${d.automations.map((a) => a.name).join(" ") || "-"}`,
    );
  } else {
    failed = true;
    for (const e of result.errors)
      console.log(`  error ${e.path}: ${e.message}`);
  }
  for (const w of result.warnings)
    console.log(`  warn  ${w.path}: ${w.message}`);
}
process.exitCode = failed ? 1 : 0;
