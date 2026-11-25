import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { test } from "node:test";
import { checkCss } from "./check-css.ts";

// Exercise the actual Biome configuration, not a copy of its rules.
test("web lint rejects non-token styles and server imports", () => {
  const dir = "web/__lint_probe__";
  mkdirSync(dir, { recursive: true });
  try {
    for (const [source, rule] of [
      [
        'export const probe = <div className="bg-red-500" />;',
        "noTailwindRawColors",
      ],
      [
        'export const probe = <div className="bg-[#123456]" />;',
        "noTailwindArbitraryValue",
      ],
      [
        'export const probe = <div className="p-[17px]" />;',
        "noTailwindArbitraryValue",
      ],
      ['export { Store } from "../../src/db.ts";', "noRestrictedImports"],
      [
        'import { Store } from "../../src/db.ts"; export { Store };',
        "noRestrictedImports",
      ],
      [
        'import type { Store } from "../../src/db.ts"; export type { Store };',
        "noRestrictedImports",
      ],
      [
        'import { createApi } from "../../src/web/api.ts"; export { createApi };',
        "only be imported with import type",
      ],
      ['import "../../src/web/api.ts";', "only be imported with import type"],
      [
        'export { createApi } from "../../src/web/api.ts";',
        "only be imported with import type",
      ],
      [
        'export const api = import("../../src/web/api.ts");',
        "only be imported with import type",
      ],
      [
        'export * as api from "../../src/web/api.ts";',
        "only be imported with import type",
      ],
    ]) {
      assert.ok(source && rule);
      writeFileSync(`${dir}/probe.tsx`, source);
      const result = spawnSync(
        "node_modules/.bin/biome",
        ["lint", `${dir}/probe.tsx`],
        { encoding: "utf8" },
      );
      assert.notEqual(result.status, 0, `Expected lint to reject: ${source}`);
      assert.ok(
        (result.stdout + result.stderr).includes(rule),
        result.stdout + result.stderr,
      );
    }
    writeFileSync(
      `${dir}/probe.tsx`,
      'import type { AppType } from "../../src/web/api.ts"; export type { AppType };',
    );
    const result = spawnSync(
      "node_modules/.bin/biome",
      ["lint", `${dir}/probe.tsx`],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("web CSS uses tokens outside theme definitions", () => {
  for (const file of readdirSync("web", {
    recursive: true,
    encoding: "utf8",
  })) {
    if (file.endsWith(".css"))
      assert.deepEqual(
        checkCss(readFileSync(`web/${file}`, "utf8"), `web/${file}`),
        [],
      );
  }
});

test("CSS token enforcement rejects arbitrary apply values and every literal color form", () => {
  for (const source of [
    ".probe { @apply bg-[#123456]; }",
    ".probe { @apply p-[17px]; }",
    ".probe { @apply bg-red-500; }",
    ".probe { color: #ff0000; }",
    ".probe { color: rgb(255 0 0); }",
    ".probe { color: hsl(0 100% 50%); }",
    ".probe { color: rebeccapurple; }",
    ".probe { border: 1px solid RED; }",
    ".probe { --custom: #fff; }",
    ".probe { background: linear-gradient(red, var(--color-bg)); }",
    "@media (width > 700px) { .probe { color: #f00; } }",
  ])
    assert.ok(checkCss(source, "probe.css").length > 0, source);
  assert.deepEqual(
    checkCss(
      '@theme { --color-test: #ff0000; } .probe { @apply bg-bg; color: var(--color-text); background: color-mix(in srgb, var(--color-text) 35%, transparent); content: "red"; background-image: url("red.png"); }',
      "allowed.css",
    ),
    [],
  );
});
