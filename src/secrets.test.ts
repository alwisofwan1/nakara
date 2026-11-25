import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pickSecrets, readSecrets } from "./secrets.ts";

test("the store is a mode 600 dotenv file; anything looser is refused", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "nakara-secrets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "secrets.env");
  assert.deepEqual(await readSecrets(path), {});
  await writeFile(path, "# Linear\nLINEAR_KEY=lin-1\nSENTRY_TOKEN='s 2'\n", {
    mode: 0o640,
  });
  await assert.rejects(
    readSecrets(path),
    /group or others \(mode 640\).*chmod 600/,
  );
  await chmod(path, 0o600);
  assert.deepEqual(await pickSecrets(path, ["SENTRY_TOKEN"]), {
    SENTRY_TOKEN: "s 2",
  });
  await assert.rejects(
    pickSecrets(path, ["LINEAR_KEY", "SLACK_TOKEN", "PAGER_KEY"]),
    /secrets SLACK_TOKEN, PAGER_KEY not in/,
  );
});
