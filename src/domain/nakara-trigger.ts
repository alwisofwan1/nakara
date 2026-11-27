// The `/nakara` trigger. When Nakara's agents act as the same GitHub login as
// a repository writer (no separate agent token, or a token of a writer's own
// account), a PR comment or review from that login is feedback only when its
// body starts with `/nakara`. Nakara and its agents therefore never post a
// body that starts with it: Nakara escapes its own, and the gh guard
// (runner/gh-guard.ts) refuses an agent's or the foreman's.

/** A body that starts with the trigger: case-insensitive, after leading whitespace. */
export const NAKARA_TRIGGER = /^\s*\/nakara/i;

/**
 * The feedback after the trigger, "" when nothing follows it; null only when
 * the body does not start with it. Test for null, not for a falsy value.
 */
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
 *
 * A GraphQL call (`gh api graphql`) is judged conservatively, since any
 * argument of a mutation can be a body: every string literal in the query is
 * decoded as GitHub would (escapes, `\u` escapes, block strings) and every
 * variable is checked, whatever its name. A query whose strings cannot be
 * decoded is refused, since it cannot be proved safe.
 */
export function triggerInGhArgs(
  args: readonly string[],
  read: (path: string) => string,
): string | null {
  const starts = (text: unknown) =>
    typeof text === "string" && /^\s*\/nakara/i.test(text);
  const api = args[0] === "api";
  const graphql = api && args.includes("graphql");
  /**
   * The first string literal of a GraphQL document that starts with the
   * trigger once decoded; the whole query when a literal is malformed.
   */
  const inQuery = (query: string): string | null => {
    const hex = /^[0-9a-fA-F]{4}$/;
    const simple: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    let i = 0;
    while (i < query.length) {
      const c = query[i];
      if (c === "#") {
        // A comment runs to the end of the line.
        while (i < query.length && query[i] !== "\n" && query[i] !== "\r") i++;
        continue;
      }
      if (c !== '"') {
        i++;
        continue;
      }
      let value = "";
      if (query.startsWith('"""', i)) {
        // A block string: raw text up to """, where only \""" is an escape.
        // Its indentation rules only remove whitespace, which the trigger
        // ignores anyway.
        i += 3;
        for (;;) {
          if (i >= query.length) return query;
          if (query.startsWith('\\"""', i)) {
            value += '"""';
            i += 4;
          } else if (query.startsWith('"""', i)) {
            i += 3;
            break;
          } else value += query[i++];
        }
      } else {
        i++;
        for (;;) {
          const ch = query[i];
          if (ch === undefined || ch === "\n" || ch === "\r") return query;
          if (ch === '"') {
            i++;
            break;
          }
          if (ch !== "\\") {
            value += ch;
            i++;
            continue;
          }
          const esc = query[i + 1] ?? "";
          if (esc in simple) {
            value += simple[esc];
            i += 2;
          } else if (esc === "u" && query[i + 2] === "{") {
            const close = query.indexOf("}", i + 3);
            const code = query.slice(i + 3, close);
            if (close < 0 || !/^[0-9a-fA-F]{1,6}$/.test(code)) return query;
            const point = Number.parseInt(code, 16);
            if (point > 0x10ffff) return query;
            value += String.fromCodePoint(point);
            i = close + 1;
          } else if (esc === "u" && hex.test(query.slice(i + 2, i + 6))) {
            value += String.fromCharCode(
              Number.parseInt(query.slice(i + 2, i + 6), 16),
            );
            i += 6;
          } else return query;
        }
      }
      if (starts(value)) return value;
    }
    return null;
  };
  // A JSON body (gh api --input): a string under a "body" key, a GraphQL
  // query, and in a GraphQL call every variable.
  const inJson = (value: unknown, key = ""): string | null => {
    if (typeof value === "string") {
      if (key === "query") return inQuery(value);
      return (graphql || key === "body") && starts(value) ? value : null;
    }
    if (value && typeof value === "object")
      for (const [k, v] of Object.entries(value)) {
        const found = inJson(v, Array.isArray(value) ? key : k);
        if (found) return found;
      }
    return null;
  };
  const field = (pair: string, fromFile: boolean): string | null => {
    const eq = pair.indexOf("=");
    if (eq < 0) return null;
    const key = pair.slice(0, eq);
    let value = pair.slice(eq + 1);
    if (fromFile && value.startsWith("@")) value = read(value.slice(1));
    if (key === "query") return inQuery(value);
    // A GraphQL variable can be a body under any name.
    return (graphql || /(^|\[)body\]?$/.test(key)) && starts(value)
      ? value
      : null;
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
