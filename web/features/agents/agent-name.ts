/**
 * The server's rule for a new agent's folder name (AGENT_NAME in
 * src/definition/write.ts, which web/ may not import at runtime). A test in
 * src/definition/write.test.ts keeps the two equal.
 */
export const AGENT_NAME = /^(?!new$)[a-z0-9][a-z0-9_-]{0,62}$/;
