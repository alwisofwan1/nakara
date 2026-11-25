import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";

import { loadConfig } from "./config.ts";

test("under node --test the default data dir is not the real installation's", () => {
  // Starting a factory sweeps the containers labelled with this dir.
  assert.ok(!loadConfig({}).dataDir.startsWith(homedir()));
  assert.equal(loadConfig({ NAKARA_DATA_DIR: "/x" }).dataDir, "/x");
});
