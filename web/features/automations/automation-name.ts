/**
 * The server's rule for a new automation's folder name (AUTOMATION_NAME in
 * src/definition/write.ts, which web/ may not import at runtime). A test in
 * src/definition/write.test.ts keeps the two equal.
 */
export const AUTOMATION_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

/** The folder name a display name suggests: `Nightly report` → `nightly-report`; "" when none. */
export function slugify(displayName: string): string {
  return displayName
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 63)
    .replace(/-+$/, "");
}
