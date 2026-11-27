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
  // The prefix alone decides: a bare trigger is feedback with no text.
  assert.equal(afterTrigger("/nakara"), "");
  assert.equal(afterTrigger(" /NAKARA \n\t"), "");
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

test("the gh guard decodes GraphQL strings as GitHub does before it judges them", () => {
  const read = (path: string) =>
    ({
      "q.graphql":
        'mutation { addComment(input: {subjectId: "x", body: "\\/nakara hi"}) { clientMutationId } }',
      "vars.json": JSON.stringify({
        query:
          'mutation($t: String!) { addComment(input: {subjectId: "x", body: $t}) { clientMutationId } }',
        variables: { t: "/nakara via input" },
      }),
      "escaped.json": JSON.stringify({
        query:
          'mutation { addComment(input: {subjectId: "x", body: "\\u002fnakara"}) { clientMutationId } }',
      }),
    })[path] ?? "";
  const mutation = (literal: string) =>
    `mutation { addComment(input: {subjectId: "x", body: ${literal}}) { clientMutationId } }`;
  const refused = [
    // An escaped solidus.
    mutation('"\\/nakara hi"'),
    // Unicode escapes, fixed and braced, for the slash and for letters.
    mutation('"\\u002Fnakara hi"'),
    mutation('"\\u{2f}nakara hi"'),
    mutation('"/\\u006Eakara hi"'),
    mutation('"/NAK\\u0041RA hi"'),
    // Escaped whitespace before it.
    mutation('"\\n\\t /nakara hi"'),
    mutation('"\\r\\f/nakara"'),
    // Block strings, indented, with leading blank lines, and with an escaped """.
    mutation('"""/nakara hi"""'),
    mutation('"""\n    /nakara hi\n  """'),
    mutation('"""\n\n  /nakara \\""" hi"""'),
    // The body under any argument name, after another string.
    'mutation { addPullRequestReview(input: {pullRequestId: "p", event: COMMENT, body: "ok", comments: [{path: "a", position: 1, body: "\\/nakara"}]}) { clientMutationId } }',
    // A "#" inside a string is not a comment.
    'mutation { addComment(input: {subjectId: "#x", body: "\\/nakara"}) { clientMutationId } }',
    // A string the guard cannot decode cannot be proved safe.
    mutation('"\\x2fnakara"'),
    mutation('"unterminated'),
    mutation('"""unterminated'),
    mutation('"\\u00"'),
  ];
  for (const query of refused)
    assert.ok(
      triggerInGhArgs(["api", "graphql", "-f", `query=${query}`], read),
      query,
    );
  // Variables, whatever their name, and queries from a file or JSON input.
  for (const args of [
    ["api", "graphql", "-f", `query=${mutation("$t")}`, "-f", "t=/nakara hi"],
    ["api", "graphql", "-F", `query=${mutation("$t")}`, "-F", "t= /NAKARA"],
    ["api", "graphql", "-F", "query=@q.graphql"],
    ["api", "graphql", "--input", "vars.json"],
    ["api", "graphql", "--input", "escaped.json"],
    ["api", "-X", "POST", "graphql", "--field=query=@q.graphql"],
  ])
    assert.ok(triggerInGhArgs(args, read), args.join(" "));

  const allowed = [
    mutation('"Done."'),
    mutation('"Done. \\/nakara is how you ask me."'),
    mutation('"""Done.\n  Use /nakara to ask me."""'),
    // In a comment, a quote and /nakara are not a string.
    `# "/nakara" in a comment\n${mutation('"Done."')}`,
    'query { repository(owner: "o", name: "r") { pullRequest(number: 1) { body } } }',
  ];
  for (const query of allowed)
    assert.equal(
      triggerInGhArgs(["api", "graphql", "-f", `query=${query}`], read),
      null,
      query,
    );
  assert.equal(
    triggerInGhArgs(
      ["api", "graphql", "-f", `query=${mutation("$t")}`, "-f", "t=Done."],
      read,
    ),
    null,
  );
});

test("the shim agents run refuses an escaped /nakara in a GraphQL mutation", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-gh-guard-graphql-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const guard = join(dir, "guard");
  const real = join(dir, "real");
  const calls = join(dir, "calls");
  await writeGhGuard(guard, process.execPath);
  await mkdir(real);
  await writeFile(
    join(real, "gh"),
    `#!/bin/sh\necho ran >> ${JSON.stringify(calls)}\n`,
    { mode: 0o755 },
  );
  const gh = (query: string) =>
    spawnSync("gh", ["api", "graphql", "-f", `query=${query}`], {
      env: { ...process.env, PATH: `${guard}:${real}:${process.env.PATH}` },
      encoding: "utf8",
    });
  for (const body of ['"\\/nakara"', '"\\u002fnakara"', '"""\n  /nakara"""'])
    assert.equal(
      gh(
        `mutation { addComment(input: {subjectId: "x", body: ${body}}) { clientMutationId } }`,
      ).status,
      1,
      body,
    );
  assert.equal(await readFile(calls, "utf8").catch(() => ""), "");
  assert.equal(
    gh(
      'mutation { addComment(input: {subjectId: "x", body: "Done."}) { clientMutationId } }',
    ).status,
    0,
  );
  assert.equal(await readFile(calls, "utf8"), "ran\n");
});
