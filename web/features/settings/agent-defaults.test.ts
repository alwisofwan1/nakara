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

/** factory.yaml on the server: a stale revision is a 409, a save returns the next one. */
function server() {
  const disk = { revision: "r0" };
  const save = async (revision: string) => {
    if (revision !== disk.revision) throw new Error("409 conflict");
    disk.revision = `r${Number(disk.revision.slice(1)) + 1}`;
    return { revision: disk.revision };
  };
  return { disk, save };
}

describe("revision queue", () => {
  it("keeps the revision a save returned when a stale refetch arrives after it", async () => {
    const { save } = server();
    const queue = revisionQueue("r0");
    // The settings GET started before the save and answers after it.
    expect((await queue.run(save)).revision).toBe("r1");
    queue.seen("r0");
    expect(queue.revision).toBe("r1");
    expect((await queue.run(save)).revision).toBe("r2");
  });

  it("ignores a refetch that answers while a save runs", async () => {
    const { save } = server();
    const queue = revisionQueue("r0");
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async (revision) => {
      await gate;
      return save(revision);
    });
    queue.seen("r0");
    release();
    expect((await first).revision).toBe("r1");
    expect((await queue.run(save)).revision).toBe("r2");
  });

  it("shared by two editors: a stale refetch after one's save does not break the other's", async () => {
    const { save } = server();
    const queue = revisionQueue("r0");
    // The description saves, then a refetch from before it lands, then agent defaults save.
    await queue.run(save);
    queue.seen("r0");
    await expect(queue.run(save)).resolves.toEqual({ revision: "r2" });
  });

  it("takes a revision written elsewhere, and one a save wrote back to", async () => {
    const queue = revisionQueue("r0");
    queue.seen("x9");
    expect(queue.revision).toBe("x9");
    // Saving the original text back: r0 is current again, so a GET of it is not stale.
    await queue.run(async () => ({ revision: "r0" }));
    queue.seen("r0");
    expect(queue.revision).toBe("r0");
  });

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
