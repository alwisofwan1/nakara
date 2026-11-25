import assert from "node:assert/strict";
import { type TestContext, test } from "node:test";

import { Store } from "../db.ts";
import type { PrCheck } from "../domain/checks.ts";
import { Logger } from "../telemetry/log.ts";
import { PullRequestGate } from "./pull-request-gate.ts";

// GitHub is an in-memory fake; the gate under test has no workspaces, so
// handoff only reads checks (unpushed work is covered by the applier tests).
const PR1 = "https://github.com/o/r/pull/1";
const PR2 = "https://github.com/o/r/pull/2";

interface FakePr {
  state: string;
  checks: PrCheck["bucket"] | Error;
  /** Hold `readPrState` until the returned release is called. */
  hold?: boolean;
}

function setup(t: TestContext) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const prs: Record<string, FakePr> = {};
  const lines: string[] = [];
  let held: (() => void) | null = null;
  const gate = new PullRequestGate(
    store,
    {
      readPrHead: async () => ({ sha: "abc1234", branch: "nakara/1-x" }),
      onPr: async () => true,
      readPrState: async (url) => {
        const pr = prs[url];
        if (!pr) throw new Error(`no PR ${url}`);
        if (pr.hold) await new Promise<void>((r) => (held = r));
        return pr.state;
      },
      readPrChecks: async (url) => {
        const checks = prs[url]?.checks ?? new Error(`no PR ${url}`);
        if (checks instanceof Error) throw checks;
        return [{ name: "CI", bucket: checks }];
      },
    },
    new Logger({ write: (l) => lines.push(l), secrets: [] }),
  );
  const item = store.createItem({
    title: "PR",
    request: "Ship",
    source: "manual",
  });
  /** The pending events as [kind, prUrl or message], marked processed. */
  const drain = () => {
    const events = store.pendingEvents(item.id);
    store.markEventsProcessed(events.map((e) => e.id));
    return events.map((e) => {
      const p = JSON.parse(e.payload);
      return [e.kind, p.message ?? p.prUrl];
    });
  };
  const current = () => store.item(item.id) ?? item;
  const release = () => held?.();
  return { store, gate, prs, lines, item, drain, current, release };
}

test("recording a different PR starts fresh; re-recording the same one changes nothing", (t) => {
  const { store, gate, item, current } = setup(t);
  gate.record(item.id, PR1);
  store.updateItem(item.id, { pr_merged: 1 });
  store.setKv(`ci-failed:${item.id}`, "1");
  gate.record(item.id, PR1);
  assert.equal(current().pr_merged, 1);
  assert.equal(store.getKv(`ci-failed:${item.id}`), "1");

  store.setKv(`ci-wait:${item.id}`, PR1);
  store.setKv(`push-only:${item.id}`, "used");
  gate.record(item.id, PR2);
  assert.equal(current().pr_url, PR2);
  assert.equal(current().pr_merged, 0);
  for (const key of ["ci-wait", "ci-failed", "push-only"])
    assert.equal(store.getKv(`${key}:${item.id}`), "");
});

test("a handoff on pending checks waits; the poll reports once when they finish", async (t) => {
  const { store, gate, prs, item, drain, current } = setup(t);
  prs[PR1] = { state: "OPEN", checks: "pending" };
  gate.record(item.id, PR1);
  assert.deepEqual(await gate.handoff(item.id, PR1), { ok: false });
  assert.ok(gate.waitingOnCi(current()));
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [`Waiting for CI on ${PR1}`],
  );
  await gate.poll(item.id);
  assert.deepEqual(drain(), []);

  prs[PR1] = { state: "OPEN", checks: "fail" };
  await gate.poll(item.id);
  await gate.poll(item.id);
  const events = drain();
  assert.equal(events.length, 1);
  assert.equal(events[0]?.[0], "checks_updated");
  assert.match(events[0]?.[1], /^Checks failed: CI\./);
  assert.equal(store.getKv(`ci-failed:${item.id}`), "1");
  assert.ok(!gate.waitingOnCi(current()));

  // The fix's checks pass: the failure clears and the foreman retries.
  prs[PR1] = { state: "OPEN", checks: "pending" };
  await gate.handoff(item.id, PR1);
  prs[PR1] = { state: "OPEN", checks: "pass" };
  await gate.poll(item.id);
  assert.deepEqual(drain(), [
    ["checks_updated", "Checks passed. Retry handoff."],
  ]);
  assert.equal(store.getKv(`ci-failed:${item.id}`), "");
  assert.deepEqual(await gate.handoff(item.id, PR1), {
    ok: true,
    headSha: "abc1234",
  });
});

test("checks the poll cannot read wait for the operator, once", async (t) => {
  const { store, gate, prs, lines, item, drain, current } = setup(t);
  prs[PR1] = { state: "OPEN", checks: "pending" };
  gate.record(item.id, PR1);
  await gate.handoff(item.id, PR1);
  prs[PR1] = { state: "OPEN", checks: new Error("HTTP 403") };
  await gate.poll(item.id);
  await gate.poll(item.id);
  assert.equal(current().status, "waiting_human");
  assert.ok(!gate.waitingOnCi(current()));
  assert.deepEqual(drain(), []);
  const bodies = store.messages(item.id).map((m) => m.body);
  assert.equal(bodies.length, 2);
  assert.match(bodies[1] ?? "", /HTTP 403[\s\S]*Checks\/Actions read access/);
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0] ?? "{}").event, "pr_checks.read_failed");
});

test("a merge is reported once and ends the wait", async (t) => {
  const { store, gate, prs, item, drain, current } = setup(t);
  gate.record(item.id, PR1);
  store.setKv(`ci-wait:${item.id}`, PR1);
  prs[PR1] = { state: "MERGED", checks: "pass" };
  await gate.poll(item.id);
  await gate.poll(item.id);
  assert.deepEqual(drain(), [["pr_merged", PR1]]);
  assert.equal(current().pr_merged, 1);
  assert.ok(!gate.waitingOnCi(current()));
});

test("a close is reported once and ends the wait", async (t) => {
  const { store, gate, prs, item, drain, current } = setup(t);
  gate.record(item.id, PR1);
  store.setKv(`ci-wait:${item.id}`, PR1);
  prs[PR1] = { state: "CLOSED", checks: "pass" };
  await gate.poll(item.id);
  await gate.poll(item.id);
  assert.deepEqual(drain(), [["pr_closed", PR1]]);
  assert.equal(current().pr_merged, 0);
  assert.ok(!gate.waitingOnCi(current()));
});

test("a wait left on a replaced PR is dropped without reading its checks", async (t) => {
  const { store, gate, prs, item, drain, current } = setup(t);
  gate.record(item.id, PR2);
  store.setKv(`ci-wait:${item.id}`, PR1);
  prs[PR2] = { state: "OPEN", checks: new Error("not read") };
  await gate.poll(item.id);
  assert.equal(store.getKv(`ci-wait:${item.id}`), "");
  assert.equal(current().status, "active");
  assert.deepEqual(drain(), []);
});

test("a PR recorded while the poll reads the previous one is still tracked", async (t) => {
  const { store, gate, prs, item, drain, current, release } = setup(t);
  gate.record(item.id, PR1);
  prs[PR1] = { state: "MERGED", checks: "pass", hold: true };
  prs[PR2] = { state: "OPEN", checks: "pending" };
  const polling = gate.poll(item.id);
  await new Promise((r) => setImmediate(r));
  gate.record(item.id, PR2);
  await gate.handoff(item.id, PR2);
  release();
  await polling;
  assert.deepEqual(drain(), []);
  assert.equal(current().pr_merged, 0);
  assert.equal(store.getKv(`ci-wait:${item.id}`), PR2);

  prs[PR2] = { state: "OPEN", checks: "fail" };
  await gate.poll(item.id);
  assert.equal(drain()[0]?.[0], "checks_updated");
});
