// Splits a unified git diff into one entry per file for the run page.

export type DiffLineKind = "add" | "del" | "hunk" | "context";
export interface DiffLine {
  kind: DiffLineKind;
  text: string;
}
export interface FileDiff {
  path: string;
  /** The path before a rename. */
  from: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  binary: boolean;
  lines: DiffLine[];
}

// git quotes unusual paths C-style; JSON covers the common escapes.
const unquote = (path: string) => {
  if (!path.startsWith('"')) return path;
  try {
    return JSON.parse(path) as string;
  } catch {
    return path.slice(1, -1);
  }
};

/**
 * The path on a "--- a/x" or "+++ b/x" line; null for /dev/null. git appends
 * a tab when the path contains a space.
 */
function headerPath(line: string): string | null {
  const value = unquote(line.slice(4).replace(/\t$/, ""));
  return /^[ab]\//.test(value) ? value.slice(2) : null;
}

export function parseDiff(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | undefined;
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      // "diff --git a/x b/x" is ambiguous when a path contains " b/"; the exact
      // paths follow in the ---/+++ or rename lines.
      const path = /^diff --git "?a\/.*?"? "?b\/(.*?)"?$/.exec(line)?.[1] ?? "";
      file = { path, from: null, status: "modified", binary: false, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (line.startsWith("@@")) {
      inHunk = true;
      file.lines.push({ kind: "hunk", text: line });
    } else if (inHunk) {
      if (line.startsWith("+")) file.lines.push({ kind: "add", text: line });
      else if (line.startsWith("-"))
        file.lines.push({ kind: "del", text: line });
      else if (line.startsWith(" "))
        file.lines.push({ kind: "context", text: line });
      // "\ No newline at end of file" and the trailing empty line are dropped.
    } else if (line.startsWith("new file mode")) file.status = "added";
    else if (line.startsWith("deleted file mode")) file.status = "deleted";
    else if (line.startsWith("rename from ")) {
      file.status = "renamed";
      file.from = unquote(line.slice("rename from ".length));
    } else if (line.startsWith("rename to "))
      file.path = unquote(line.slice("rename to ".length));
    else if (line.startsWith("Binary files ")) file.binary = true;
    // A deleted file has only "--- a/"; any other "+++ b/" comes after it.
    else if (line.startsWith("--- ") || line.startsWith("+++ "))
      file.path = headerPath(line) ?? file.path;
  }
  return files;
}
