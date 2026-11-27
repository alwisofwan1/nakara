import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  afterTrigger,
  escapeTrigger,
  triggerInGhArgs,
} from "../domain/nakara-trigger.ts";
import { GH_GUARD_REFUSAL, writeGhGuard } from "./gh-guard.ts";

test("the trigger: /nakara at the start, any case, after leading whitespace", () => {
  assert.equal(afterTrigger("/nakara Rename it."), "Rename it.");
  assert.equal(afterTrigger("\n  /NaKaRa\nRename it."), "Rename it.");
  assert.equal(afterTrigger("Please /nakara rename it."), null);
  assert.equal(escapeTrigger("  /Nakara go"), "  \\/Nakara go");
  assert.equal(afterTrigger(escapeTrigger("/nakara go")), null);
  assert.equal(escapeTrigger("/other"), "/other");
});

test("the gh guard finds a /nakara body however gh is given it", () => {
  const files: Record<string, string> = {
    reply: "/nakara Done.",
    note: "Done.",
    "-": " /nakara from stdin",
    "review.json": JSON.stringify({
      event: "COMMENT",
      comments: [{ path: "a.ts", body: "/nakara x" }],
    }),
  };
  const read = (path: string) => files[path] ?? "";
  const refused = [
    ["pr", "comment", "7", "--body", "/nakara Done."],
    ["pr", "comment", "7", "-b", "/NAKARA Done."],
    ["pr", "comment", "7", "--body=/nakara Done."],
    ["issue", "comment", "7", "--body-file", "reply"],
    ["pr", "review", "7", "--comment", "-F", "-"],
    ["api", "repos/o/r/issues/7/comments", "-f", "body=/nakara Done."],
    ["api", "repos/o/r/pulls/7/comments/1/replies", "-F", "body=@reply"],
    ["api", "repos/o/r/pulls/7/reviews", "--input", "review.json"],
    [
      "api",
      "graphql",
      "-f",
      'query=mutation { addComment(input: {subjectId: "x", body: "/nakara hi"}) { clientMutationId } }',
    ],
  ];
  for (const args of refused)
    assert.ok(triggerInGhArgs(args, read), args.join(" "));
  const allowed = [
    ["pr", "comment", "7", "--body", "Done. Use /nakara to ask me."],
    ["issue", "comment", "7", "--body-file", "note"],
    ["api", "repos/o/r/issues/7/comments", "-f", "body=Done."],
    // gh api -F reads a field from a file; outside api, -F is --body-file.
    ["api", "repos/o/r/issues/7", "-F", "title=@reply"],
    ["pr", "view", "7", "--json", "body"],
  ];
  for (const args of allowed)
    assert.equal(triggerInGhArgs(args, read), null, args.join(" "));
});

test("an agent's gh refuses a /nakara reply and passes everything else to the real gh", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-gh-guard-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const guard = join(dir, "guard");
  const real = join(dir, "real");
  const calls = join(dir, "calls");
  await writeGhGuard(guard, process.execPath);
  await mkdir(real);
  await writeFile(
    join(real, "gh"),
    `#!/bin/sh\nprintf '%s|' "$@" >> ${JSON.stringify(calls)}\ncat >> ${JSON.stringify(calls)}\necho >> ${JSON.stringify(calls)}\n`,
    { mode: 0o755 },
  );
  const gh = (args: string[], input = "") =>
    spawnSync("gh", args, {
      env: { ...process.env, PATH: `${guard}:${real}:${process.env.PATH}` },
      input,
      encoding: "utf8",
    });

  const refused = gh(["pr", "comment", "7", "--body", "/nakara Done."]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, new RegExp(GH_GUARD_REFUSAL.slice(0, 40)));
  const piped = gh(["pr", "comment", "7", "--body-file", "-"], "/nakara x");
  assert.equal(piped.status, 1);
  assert.equal(
    await readFile(calls, "utf8").catch(() => ""),
    "",
    "the real gh never ran",
  );

  assert.equal(gh(["pr", "comment", "7", "--body", "Done."]).status, 0);
  // Standard input the guard read reaches the real gh.
  assert.equal(
    gh(["pr", "comment", "7", "--body-file", "-"], "Fixed.").status,
    0,
  );
  assert.deepEqual((await readFile(calls, "utf8")).trim().split("\n"), [
    "pr|comment|7|--body|Done.|",
    "pr|comment|7|--body-file|-|Fixed.",
  ]);
});
