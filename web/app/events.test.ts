import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateChange, revalidateLive } from "./events";

describe("event invalidation", () => {
  it("invalidates only the matching resource", () => {
    const client = new QueryClient();
    client.setQueryData(["status"], { slots: 1 });
    client.setQueryData(["items"], []);
    client.setQueryData(["new-work"], {});
    client.setQueryData(["automations"], []);
    client.setQueryData(["agents", "foreman"], {});
    invalidateChange(client, JSON.stringify({ type: "status", id: "global" }));
    expect(client.getQueryState(["status"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["new-work"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["automations"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["items"])?.isInvalidated).toBe(false);
    client.setQueryData(["inbox"], {});
    invalidateChange(client, JSON.stringify({ type: "items", id: "global" }));
    expect(client.getQueryState(["items"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["inbox"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["agents", "foreman"])?.isInvalidated).toBe(
      true,
    );
    client.clear();
  });
  it("invalidates every runs query on a runs change", () => {
    const client = new QueryClient();
    client.setQueryData(["status"], { slots: 1 });
    client.setQueryData(["runs", { status: "running" }], { runs: [] });
    invalidateChange(client, JSON.stringify({ type: "runs", id: "global" }));
    expect(
      client.getQueryState(["runs", { status: "running" }])?.isInvalidated,
    ).toBe(true);
    expect(client.getQueryState(["status"])?.isInvalidated).toBe(false);
    client.clear();
  });
  it("revalidates status, runs, items, the inbox and creation jobs on (re)connect", () => {
    const client = new QueryClient();
    const keys = [
      ["status"],
      ["runs", 3],
      ["items", 2],
      ["inbox"],
      ["creation", "7"],
    ];
    for (const key of keys) client.setQueryData(key, {});
    revalidateLive(client);
    for (const key of keys)
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    client.clear();
  });
  it("refreshes a creation job's progress", () => {
    const client = new QueryClient();
    client.setQueryData(["creation", "7"], {});
    client.setQueryData(["status"], {});
    invalidateChange(client, JSON.stringify({ type: "creation", id: "7" }));
    expect(client.getQueryState(["creation", "7"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["status"])?.isInvalidated).toBe(false);
    client.clear();
  });
  it.each(["run", "item"])("refreshes run pages on %s changes", (type) => {
    const client = new QueryClient();
    client.setQueryData(["runs", 3], {});
    client.setQueryData(["status"], {});
    invalidateChange(client, JSON.stringify({ type, id: "7" }));
    expect(client.getQueryState(["runs", 3])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["status"])?.isInvalidated).toBe(false);
    client.clear();
  });
  it("refreshes the definition page on a definition change", () => {
    const client = new QueryClient();
    client.setQueryData(["definition"], {});
    client.setQueryData(["status"], {});
    invalidateChange(
      client,
      JSON.stringify({ type: "definition", id: "global" }),
    );
    expect(client.getQueryState(["definition"])?.isInvalidated).toBe(true);
    expect(client.getQueryState(["status"])?.isInvalidated).toBe(false);
    client.clear();
  });
  it("refreshes a work item's PR summary on item changes only", () => {
    const client = new QueryClient();
    client.setQueryData(["pr", 7], {});
    invalidateChange(client, JSON.stringify({ type: "items", id: "global" }));
    expect(client.getQueryState(["pr", 7])?.isInvalidated).toBe(false);
    invalidateChange(client, JSON.stringify({ type: "item", id: "7" }));
    expect(client.getQueryState(["pr", 7])?.isInvalidated).toBe(true);
    client.clear();
  });
  it.each([
    "invalid",
    "null",
    "{}",
    '{"type":"future","id":"1"}',
    '{"type":"toString","id":"1"}',
    '{"type":"status"}',
    '{"type":"toString","id":"1"}',
  ])("ignores malformed or unknown notifications: %s", (data) => {
    const client = new QueryClient();
    client.setQueryData(["status"], {});
    expect(() => invalidateChange(client, data)).not.toThrow();
    expect(client.getQueryState(["status"])?.isInvalidated).toBe(false);
    client.clear();
  });
});
