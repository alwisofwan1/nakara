import { describe, expect, it } from "vitest";
import {
  backupStale,
  formatDuration,
  plural,
  problemKey,
  problemLocation,
  relativeTime,
  runDuration,
} from "./format";

describe("format", () => {
  it("flags a backup older than twice the interval, or none", () => {
    const now = Date.parse("2026-10-23T12:00:00Z");
    const backup = (at: string | null) => ({ at, intervalHours: 24 });
    expect(backupStale(backup("2026-10-22T00:00:00Z"), now)).toBe(false);
    expect(backupStale(backup("2026-10-21T11:59:00Z"), now)).toBe(true);
    expect(backupStale(backup(null), now)).toBe(true);
  });
  it("locates problems by file and line", () => {
    expect(problemLocation({ path: "agents/a/agent.md", line: 3 })).toBe(
      "agents/a/agent.md:3",
    );
    expect(problemLocation({ path: "agents/", line: null })).toBe("agents/");
    const same = { path: "factory.yaml", line: 2, message: "bad" };
    expect(problemKey(same, 0)).not.toBe(problemKey(same, 1));
  });
  it("pluralizes counts", () => {
    expect(plural(1, "error")).toBe("1 error");
    expect(plural(2, "error")).toBe("2 errors");
  });
});

describe("run formatting", () => {
  it.each([
    [0, "0s"],
    [59_999, "59s"],
    [372_000, "6m 12s"],
    [3_780_000, "1h 3m"],
    [-5, "0s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
  it("formats relative times", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(relativeTime("2026-10-22T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-10-22T11:15:00Z", now)).toBe("45m ago");
    expect(relativeTime("2026-10-22T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-10-20T12:00:00Z", now)).toBe("2d ago");
    expect(relativeTime("", now)).toBe("at an unknown time");
  });
  it("counts running runs up from their start and keeps stored durations", () => {
    const startedAt = "2026-10-22T12:00:00Z";
    const now = Date.parse(startedAt) + 90_000;
    expect(
      runDuration({ status: "running", startedAt, durationMs: null }, now),
    ).toBe(90_000);
    expect(
      runDuration({ status: "succeeded", startedAt, durationMs: 5000 }, now),
    ).toBe(5000);
    expect(
      runDuration({ status: "queued", startedAt, durationMs: null }, now),
    ).toBeNull();
  });
});
