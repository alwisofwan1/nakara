// The secret store: a dotenv file only the Nakara user can read. Agents get
// the names their definition declares, never Nakara's own environment.
import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";

/** Every `NAME=value` in the store; no file is an empty store. */
export async function readSecrets(
  path: string,
): Promise<Record<string, string>> {
  const info = await stat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info) return {};
  if (info.mode & 0o077)
    throw new Error(
      `${path} is open to group or others (mode ${(info.mode & 0o777).toString(8)}); run chmod 600 ${path}`,
    );
  return parseEnv(await readFile(path, "utf8")) as Record<string, string>;
}

/** The values of `names`; throws naming each one the store lacks. */
export async function pickSecrets(
  path: string,
  names: readonly string[],
): Promise<Record<string, string>> {
  const store = await readSecrets(path);
  const missing = names.filter((n) => !store[n]);
  if (missing.length)
    throw new Error(
      `secret${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not in ${path}`,
    );
  return Object.fromEntries(names.map((n) => [n, store[n] as string]));
}
