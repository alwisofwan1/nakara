import { describe, expect, it } from "vitest";
import {
  type AgentDefaultsForm,
  agentDefaultsEdit,
  harnessOf,
  revisionQueue,
  runnerFor,
} from "./agent-defaults";

const saved: AgentDefaultsForm = {
  harness: "claude",
  model: "sonnet",
  effort: null,
  runner: "docker",
  idleTimeoutMinutes: null,
};
const runners = [
  { name: "docker-browser", sandbox: true },
  { name: "docker", sandbox: true },
  { name: "local", sandbox: false },
];

describe("agent defaults edit", () => {
  it("sends nothing for the saved values", () => {
    expect(agentDefaultsEdit(saved, { ...saved })).toBeNull();
  });

  it("sends harness, model and effort together, and only what changed", () => {
    expect(
      agentDefaultsEdit(saved, { ...saved, harness: "codex", model: null }),
    ).toEqual({ harness: "codex", model: null, effort: null });
    expect(agentDefaultsEdit(saved, { ...saved, runner: "local" })).toEqual({
      runner: "local",
    });
    expect(
      agentDefaultsEdit(saved, { ...saved, idleTimeoutMinutes: 20 }),
    ).toEqual({ idleTimeoutMinutes: 20 });
  });

  it("keeps the model shorthand for a Claude Code model", () => {
    const shorthand = { ...saved, harness: null, model: "sonnet" };
    expect(harnessOf(shorthand)).toBe("claude");
    // The picker answers with an explicit harness; the file stays shorthand.
    expect(
      agentDefaultsEdit(shorthand, { ...shorthand, harness: "claude" }),
    ).toBeNull();
    expect(
      agentDefaultsEdit(shorthand, {
        ...shorthand,
        harness: "claude",
        model: "opus",
      }),
    ).toEqual({ harness: null, model: "opus", effort: null });
    // An effort needs the harness form.
    expect(
      agentDefaultsEdit(shorthand, {
        ...shorthand,
        harness: "claude",
        effort: "high",
      }),
    ).toEqual({ harness: "claude", model: "sonnet", effort: "high" });
  });

  it("resolves the harness the way the loader does", () => {
    expect(harnessOf({ ...saved, harness: "claude-code" })).toBe("claude");
    expect(harnessOf({ ...saved, harness: null, model: "qwen3-coder" })).toBe(
      "qwen",
    );
    expect(harnessOf({ ...saved, harness: "codex" })).toBe("codex");
  });
});

describe("runner for a kind", () => {
  it("keeps the current runner of that kind, else takes the first", () => {
    expect(runnerFor(true, "docker", runners)).toBe("docker");
    expect(runnerFor(false, "docker", runners)).toBe("local");
    expect(runnerFor(true, "local", runners)).toBe("docker-browser");
  });

  it("is no runner for the host when no runner file is one", () => {
    expect(runnerFor(false, "docker", runners.slice(0, 2))).toBeNull();
  });
});

describe("revision queue", () => {
  it("saves twice in a row without waiting for a refetch, with no conflict", async () => {
    // The server: a stale revision is a 409, a save returns the new one.
    let onDisk = "r0";
    const server = async (revision: string) => {
      if (revision !== onDisk) throw new Error("409 conflict");
      onDisk = `r${Number(onDisk.slice(1)) + 1}`;
      return { revision: onDisk };
    };
    const queue = revisionQueue("r0");
    const [first, second] = await Promise.all([
      queue.run(server),
      queue.run(server),
    ]);
    expect(first.revision).toBe("r1");
    expect(second.revision).toBe("r2");
    // A later save after the first two resolved still sends the latest one.
    expect((await queue.run(server)).revision).toBe("r3");
  });

  it("takes a revision the page loaded after another editor saved", async () => {
    const sent: string[] = [];
    const queue = revisionQueue("r0");
    queue.seen("r5");
    await queue.run(async (revision) => {
      sent.push(revision);
      return { revision: "r6" };
    });
    expect(sent).toEqual(["r5"]);
  });

  it("a refused save leaves the revision for the next one", async () => {
    const queue = revisionQueue("r0");
    await expect(
      queue.run(async () => {
        throw new Error("422");
      }),
    ).rejects.toThrow("422");
    const sent: string[] = [];
    await queue.run(async (revision) => {
      sent.push(revision);
      return { revision: "r1" };
    });
    expect(sent).toEqual(["r0"]);
  });
});
