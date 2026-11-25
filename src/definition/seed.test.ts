import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { factorySeed, slugify } from "./seed.ts";

test("the first factory is named after the definition's label", async () => {
  const dir = resolve("factory");
  assert.deepEqual(
    await factorySeed({ definitionDir: dir, dataDir: "/srv/data" }),
    {
      slug: "nakara",
      name: "Nakara",
      description:
        "Default SDLC factory: triage, optional spec with human approval, implementation, one adversarial review, and a human merge.",
      avatar_color: "#6d4aff",
      foreman_handle: "nakara",
      definition_dir: dir,
      definition_mode: "repo",
    },
  );
  assert.equal(slugify("Nakara Web  2"), "nakara-web-2");
  assert.equal(slugify("—"), "factory");
});

test("a definition under the data directory is managed", async (t) => {
  const data = await mkdtemp(join(tmpdir(), "nakara-seed-"));
  t.after(() => rm(data, { recursive: true, force: true }));
  const dir = join(data, "factories", "nakara");
  await cp("factory", dir, { recursive: true });
  const seed = await factorySeed({ definitionDir: dir, dataDir: data });
  assert.equal(seed.definition_mode, "managed");
});
