// The gh an agent or the foreman runs: a shim first on its PATH that refuses
// to post a comment, review or other body starting with `/nakara` (see
// domain/nakara-trigger.ts), so a reply of Nakara's cannot pass for the
// Operator's feedback, and hands every other call to the real gh.
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { triggerInGhArgs } from "../domain/nakara-trigger.ts";

export const GH_GUARD_REFUSAL =
  "Nakara refused this gh call: its body starts with /nakara, the trigger that marks the Operator's feedback on a pull request. Nakara and its agents never start a comment or review with /nakara; reword it.";

/** The guard's script: CommonJS, so no package.json around it changes how node loads it. */
const guardScript = () => `"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const triggerInGhArgs = ${triggerInGhArgs.toString()};
const here = path.dirname(fs.realpathSync(__filename));
let stdin;
const read = (p) =>
  p === "-" ? (stdin ??= fs.readFileSync(0, "utf8")) : fs.readFileSync(p, "utf8");
const args = process.argv.slice(2);
let found = null;
try {
  found = triggerInGhArgs(args, read);
} catch {
  // A file gh cannot read either: gh reports it.
}
if (found) {
  process.stderr.write(${JSON.stringify(`${GH_GUARD_REFUSAL}\n`)});
  process.exit(1);
}
const real = (process.env.PATH || "")
  .split(":")
  .filter((dir) => dir && path.resolve(dir) !== here)
  .map((dir) => path.join(dir, "gh"))
  .find((file) => {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return path.dirname(fs.realpathSync(file)) !== here;
    } catch {
      return false;
    }
  });
if (!real) {
  process.stderr.write("gh: command not found\\n");
  process.exit(127);
}
const result = spawnSync(real, args, {
  stdio: [stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  input: stdin,
});
process.exit(result.status ?? 1);
`;

/**
 * Write the guard into `dir`: `gh`, a shell script that runs the guard with
 * `node` (a path on the host; the image's node in a container).
 */
export async function writeGhGuard(dir: string, node: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "gh-guard.cjs"), guardScript());
  const gh = join(dir, "gh");
  await writeFile(
    gh,
    `#!/bin/sh\nexec ${JSON.stringify(node)} "$(dirname "$0")/gh-guard.cjs" "$@"\n`,
  );
  await chmod(gh, 0o755);
}
