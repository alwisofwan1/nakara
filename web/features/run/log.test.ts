import { describe, expect, it } from "vitest";
import { appendLog, emptyLog, parseLine } from "./log";

const line = (event: unknown) => JSON.stringify(event);

describe("transcript parsing", () => {
  it("reads claude stream-json steps and file edits", () => {
    const assistant = parseLine(
      line({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Fixing the counter." },
            { type: "tool_use", name: "Bash", input: { command: "npm test" } },
            {
              type: "tool_use",
              name: "Edit",
              input: {
                file_path: "src/a.ts",
                old_string: "a",
                new_string: "b",
              },
            },
            {
              type: "tool_use",
              name: "Write",
              input: { file_path: "src/b.ts", content: "new\n" },
            },
          ],
        },
      }),
    );
    expect(assistant.entries).toEqual([
      { kind: "text", text: "Fixing the counter." },
      { kind: "tool", text: "$ npm test" },
      { kind: "tool", text: "› edit src/a.ts" },
      { kind: "tool", text: "› write src/b.ts" },
    ]);
    expect(assistant.changes).toEqual([
      { path: "src/a.ts", kind: "edit", removed: "a", added: "b" },
      { path: "src/b.ts", kind: "write", removed: "", added: "new\n" },
    ]);
    expect(
      parseLine(
        line({
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: "✗ 1 failed\ndetails",
                is_error: true,
              },
            ],
          },
        }),
      ).entries,
    ).toEqual([
      { kind: "error", text: "✗ 1 failed", detail: "✗ 1 failed\ndetails" },
    ]);
    expect(
      parseLine(
        line({
          type: "system",
          subtype: "init",
          session_id: "s1",
          model: "opus",
        }),
      ).entries,
    ).toEqual([{ kind: "meta", text: "session s1 · opus" }]);
  });

  it("reads codex exec --json items", () => {
    expect(
      parseLine(
        line({
          type: "item.completed",
          item: {
            type: "command_execution",
            command: "npm test",
            aggregated_output: "",
            exit_code: 1,
          },
        }),
      ).entries,
    ).toEqual([
      { kind: "tool", text: "$ npm test" },
      { kind: "error", text: "exit 1" },
    ]);
    const change = parseLine(
      line({
        type: "item.completed",
        item: {
          type: "file_change",
          changes: [{ path: "src/a.ts", kind: "update" }],
        },
      }),
    );
    expect(change.entries).toEqual([
      { kind: "tool", text: "› update src/a.ts" },
    ]);
    expect(change.changes).toEqual([
      { path: "src/a.ts", kind: "update", removed: "", added: "" },
    ]);
    expect(
      parseLine(
        line({ type: "turn.failed", error: { message: "usage limit" } }),
      ).entries,
    ).toEqual([{ kind: "error", text: "usage limit" }]);
  });

  it("keeps non-JSON output raw and skips unknown events", () => {
    expect(parseLine("docker: pulling image").entries).toEqual([
      { kind: "raw", text: "docker: pulling image" },
    ]);
    expect(parseLine("[1, 2]").entries).toEqual([
      { kind: "raw", text: "[1, 2]" },
    ]);
    expect(parseLine(line({ type: "future" })).entries).toEqual([]);
    expect(parseLine("").entries).toEqual([]);
  });
});

describe("streamed log state", () => {
  it("holds a partial line until its newline or the end of the run", () => {
    let state = appendLog(emptyLog, "first\nsec");
    expect(state.entries).toEqual([{ id: 0, kind: "raw", text: "first" }]);
    expect(state.partial).toBe("sec");
    state = appendLog(state, "ond\nthi");
    expect(state.entries.map((e) => [e.id, e.text])).toEqual([
      [0, "first"],
      [1, "second"],
    ]);
    state = appendLog(state, "", true);
    expect(state.entries.at(-1)).toEqual({ id: 2, kind: "raw", text: "thi" });
    expect(state).toMatchObject({ partial: "", ended: true });
  });
});
