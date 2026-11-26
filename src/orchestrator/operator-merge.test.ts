import assert from "node:assert/strict";
import { test } from "node:test";

import { CODEX_RULES } from "../harness/codex-home.ts";
import { NEVER } from "./run-support.ts";

// The Operator's merge endpoint must not open merging to agents (ADR-0006 rule 6).
test("agents stay unable to merge: the claude deny list and codex rules forbid gh pr merge", () => {
  assert.ok(NEVER.includes("Bash(gh pr merge:*)"));
  assert.match(
    CODEX_RULES,
    /^prefix_rule\(pattern = \["gh", "pr", "merge"\], decision = "forbidden"\)$/m,
  );
});
