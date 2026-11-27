// The `/nakara` trigger. When Nakara's agents act as the same GitHub login as
// a repository writer (no separate agent token, or a token of a writer's own
// account), a PR comment or review from that login is feedback only when its
// body starts with `/nakara`. Nakara and its agents therefore never post a
// body that starts with it: Nakara escapes its own, and the gh guard
// (runner/gh-guard.ts) refuses an agent's or the foreman's.

/** A body that starts with the trigger: case-insensitive, after leading whitespace. */
export const NAKARA_TRIGGER = /^\s*\/nakara/i;

/** The feedback after the trigger; null when the body does not start with it. */
export function afterTrigger(body: string): string | null {
  return NAKARA_TRIGGER.test(body)
    ? body.replace(NAKARA_TRIGGER, "").trim()
    : null;
}

/**
 * A body Nakara posts, made safe: a leading `/nakara` becomes `\/nakara`,
 * which Markdown renders the same but which no longer starts with the trigger.
 */
export const escapeTrigger = (body: string): string =>
  NAKARA_TRIGGER.test(body) ? body.replace(/^(\s*)\//, "$1\\/") : body;

/**
 * The text in a `gh` command line that would post a comment, review or other
 * body starting with `/nakara`, or null when there is none. `read` returns a
 * file's text, `-` being standard input. Self-contained (no imports, no outer
 * names): the gh guard embeds its source in the shim agents run.
 */
export function triggerInGhArgs(
  args: readonly string[],
  read: (path: string) => string,
): string | null {
  const starts = (text: unknown) =>
    typeof text === "string" && /^\s*\/nakara/i.test(text);
  const api = args[0] === "api";
  // A JSON body (gh api --input): any string under a "body" key, or a GraphQL query.
  const inJson = (value: unknown, key = ""): string | null => {
    if (typeof value === "string")
      return (key === "body" && starts(value)) ||
        (key === "query" && graphql(value))
        ? value
        : null;
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        const found = inJson(v, Array.isArray(value) ? key : k);
        if (found) return found;
      }
    return null;
  };
  // A body written inline in a GraphQL mutation: body: "/nakara …".
  const graphql = (query: string) =>
    /\bbody\s*:\s*"(\s|\\[nrt])*\/nakara/i.test(query);
  const field = (pair: string, fromFile: boolean): string | null => {
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const key = pair.slice(0, eq);
    let value = pair.slice(eq + 1);
    if (fromFile && value.startsWith("@")) value = read(value.slice(1));
    if (key === "query") return graphql(value) ? value : null;
    return /(^|\[)body\]?$/.test(key) && starts(value) ? value : null;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    const [flag, inline] = arg.startsWith("--")
      ? [
          arg.split("=")[0],
          arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : undefined,
        ]
      : arg.length > 2 && arg.startsWith("-") && !arg.startsWith("--")
        ? [arg.slice(0, 2), arg.slice(2)]
        : [arg, undefined];
    const value = () => inline ?? args[++i] ?? "";
    let found: string | null = null;
    if (api) {
      if (flag === "-f" || flag === "--raw-field")
        found = field(value(), false);
      else if (flag === "-F" || flag === "--field")
        found = field(value(), true);
      else if (flag === "--input") {
        const text = read(value());
        try {
          found = inJson(JSON.parse(text));
        } catch {
          found = starts(text) ? text : null;
        }
      }
    } else if (flag === "-b" || flag === "--body") {
      const text = value();
      found = starts(text) ? text : null;
    } else if (flag === "-F" || flag === "--body-file") {
      const text = read(value());
      found = starts(text) ? text : null;
    }
    if (found) return found;
  }
  return null;
}
