// Turns a run's transcript (claude stream-json, codex exec --json, or raw
// stderr) into display entries and the file changes the agent made.

export interface LogEntry {
  kind: "text" | "tool" | "output" | "error" | "meta" | "raw";
  text: string;
  /** Long tool output, shown collapsed. */
  detail?: string;
}

export interface FileChange {
  path: string;
  /** "edit", "write", or codex's change kind ("add", "update", "delete"). */
  kind: string;
  removed: string;
  added: string;
}

type Json = Record<string, unknown>;
const str = (value: unknown) => (typeof value === "string" ? value : "");
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max)}\n…` : text;

function toolLine(name: string, input: Json): string {
  if (name === "Bash") return `$ ${str(input.command)}`;
  if (typeof input.file_path === "string")
    return `› ${name.toLowerCase()} ${input.file_path}`;
  if (typeof input.pattern === "string") return `› ${name} ${input.pattern}`;
  return `› ${name} ${clip(JSON.stringify(input), 200)}`;
}

function output(body: string, error: boolean): LogEntry {
  const trimmed = body.trim();
  const first = trimmed.split("\n", 1)[0] ?? "";
  return {
    kind: error ? "error" : "output",
    text: clip(first, 200) || (error ? "error" : "(no output)"),
    ...(trimmed.includes("\n") || first.length > 200
      ? { detail: clip(trimmed, 4000) }
      : {}),
  };
}

/** Parse one transcript line. Unknown JSON events are skipped, other text is kept raw. */
export function parseLine(line: string): {
  entries: LogEntry[];
  changes: FileChange[];
} {
  const entries: LogEntry[] = [];
  const changes: FileChange[] = [];
  if (!line.trim()) return { entries, changes };
  let event: Json;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error("not an event");
    event = parsed as Json;
  } catch {
    return { entries: [{ kind: "raw", text: line }], changes };
  }
  const content = Array.isArray((event.message as Json | undefined)?.content)
    ? ((event.message as Json).content as Json[])
    : [];
  const item = (event.item ?? {}) as Json;
  switch (event.type) {
    case "system":
      if (event.subtype === "init")
        entries.push({
          kind: "meta",
          text: `session ${str(event.session_id)}${event.model ? ` · ${str(event.model)}` : ""}`,
        });
      break;
    case "thread.started":
      entries.push({ kind: "meta", text: `session ${str(event.thread_id)}` });
      break;
    case "assistant":
      for (const c of content) {
        if (c.type === "text" && str(c.text).trim())
          entries.push({ kind: "text", text: str(c.text) });
        if (c.type === "tool_use") {
          const input = (c.input ?? {}) as Json;
          const name = str(c.name);
          entries.push({ kind: "tool", text: toolLine(name, input) });
          const path = str(input.file_path);
          if (name === "Edit")
            changes.push({
              path,
              kind: "edit",
              removed: str(input.old_string),
              added: str(input.new_string),
            });
          if (name === "MultiEdit" && Array.isArray(input.edits))
            for (const e of input.edits as Json[])
              changes.push({
                path,
                kind: "edit",
                removed: str(e.old_string),
                added: str(e.new_string),
              });
          if (name === "Write")
            changes.push({
              path,
              kind: "write",
              removed: "",
              added: str(input.content),
            });
        }
      }
      break;
    case "user":
      for (const c of content)
        if (c.type === "tool_result")
          entries.push(
            output(
              Array.isArray(c.content)
                ? (c.content as Json[]).map((x) => str(x.text)).join("\n")
                : str(c.content),
              c.is_error === true,
            ),
          );
      break;
    case "result":
      entries.push({
        kind: event.is_error === true ? "error" : "meta",
        text: `result: ${str(event.subtype)}${typeof event.total_cost_usd === "number" ? ` · $${event.total_cost_usd.toFixed(2)}` : ""}`,
      });
      break;
    case "item.completed":
      if (item.type === "agent_message" && str(item.text).trim())
        entries.push({ kind: "text", text: str(item.text) });
      if (item.type === "command_execution") {
        entries.push({ kind: "tool", text: `$ ${str(item.command)}` });
        const body = str(item.aggregated_output);
        const failed =
          typeof item.exit_code === "number" && item.exit_code !== 0;
        if (body.trim() || failed)
          entries.push(
            output(body || `exit ${String(item.exit_code)}`, failed),
          );
      }
      if (item.type === "file_change" && Array.isArray(item.changes))
        for (const c of item.changes as Json[]) {
          entries.push({
            kind: "tool",
            text: `› ${str(c.kind)} ${str(c.path)}`,
          });
          changes.push({
            path: str(c.path),
            kind: str(c.kind),
            removed: "",
            added: "",
          });
        }
      if (item.type === "error")
        entries.push({ kind: "error", text: str(item.message) });
      break;
    case "turn.failed":
      entries.push({
        kind: "error",
        text: str((event.error as Json | undefined)?.message) || "turn failed",
      });
      break;
    case "error":
      entries.push({ kind: "error", text: str(event.message) });
      break;
  }
  return { entries, changes };
}

export interface LogState {
  /** Entries and changes carry their position as a stable id; the log only appends. */
  entries: (LogEntry & { id: number })[];
  changes: (FileChange & { id: number })[];
  /** An unterminated last line, kept until its newline (or the end of the run) arrives. */
  partial: string;
  ended: boolean;
}

export const emptyLog: LogState = {
  entries: [],
  changes: [],
  partial: "",
  ended: false,
};

/** Add a streamed chunk; `ended` flushes the partial line. */
export function appendLog(
  state: LogState,
  chunk: string,
  ended = false,
): LogState {
  const lines = (state.partial + chunk).split("\n");
  const partial = ended ? "" : (lines.pop() ?? "");
  const parsed = lines.map(parseLine);
  const entries = parsed.flatMap((p) => p.entries);
  const changes = parsed.flatMap((p) => p.changes);
  return {
    entries: [
      ...state.entries,
      ...entries.map((e, i) => ({ ...e, id: state.entries.length + i })),
    ],
    changes: [
      ...state.changes,
      ...changes.map((c, i) => ({ ...c, id: state.changes.length + i })),
    ],
    partial,
    ended: state.ended || ended,
  };
}
