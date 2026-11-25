import { tmpdir } from "node:os";
import { join } from "node:path";

/** The definition directory of the smoke server listening on `port`. */
export const smokeDefinitionDir = (port: number) =>
  join(tmpdir(), `nakara-smoke-${port}`, "factory");

/** The definition directory of the smoke server's third factory, Lighthouse, which never loads. */
export const smokeLighthouseDir = (port: number) =>
  join(tmpdir(), `nakara-smoke-${port}`, "lighthouse");

/** The definition directory of the smoke server's second factory, Harbor. */
export const smokeHarborDir = (port: number) =>
  join(tmpdir(), `nakara-smoke-${port}`, "harbor");
