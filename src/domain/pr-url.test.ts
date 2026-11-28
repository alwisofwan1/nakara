import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePrUrl, samePr } from "./pr-url.ts";

const PR = "https://github.com/acme/widgets/pull/7";

test("a PR URL parses to owner, repository and number; anything else does not", () => {
  assert.deepEqual(parsePrUrl(PR), {
    owner: "acme",
    name: "widgets",
    number: "7",
  });
  for (const spelling of [
    `${PR}/`,
    `${PR}?w=1`,
    `${PR}#discussion_r1`,
    `${PR}/#top`,
    "https://github.com/acme/widgets/pull/007",
  ])
    assert.equal(parsePrUrl(spelling)?.number, "7", spelling);
  for (const other of [
    "https://github.com/acme/widgets/issues/7",
    "https://github.com/acme/widgets/pull/7/files",
    "https://github.com.evil.io/acme/widgets/pull/7",
    "http://github.com/acme/widgets/pull/7",
    "not a url",
  ])
    assert.equal(parsePrUrl(other), null, other);
});

test("two spellings of one PR are the same PR; another number, repository or owner is not", () => {
  for (const spelling of [
    PR,
    `${PR}/`,
    "https://github.com/ACME/Widgets/pull/7",
    "https://github.com/Acme/widgets/pull/7/",
    `${PR}?w=1`,
    `${PR}#issuecomment-1`,
  ])
    assert.ok(samePr(PR, spelling), spelling);
  for (const other of [
    "https://github.com/acme/widgets/pull/8",
    "https://github.com/acme/gadgets/pull/7",
    "https://github.com/other/widgets/pull/7",
  ])
    assert.equal(samePr(PR, other), false, other);
  assert.ok(samePr(null, undefined) === false);
  assert.ok(samePr(null, null));
  assert.equal(samePr(PR, null), false);
});
