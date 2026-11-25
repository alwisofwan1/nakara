import assert from "node:assert/strict";
import { test } from "node:test";

import { Store } from "../db.ts";
import { Logger } from "../telemetry/log.ts";
import {
  type EvidenceGitHub,
  EvidencePublisher,
  evidenceComment,
  MARKER,
} from "./evidence-publisher.ts";

function setup(t: { after: (fn: () => void) => void }) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const itemId = store.createItem({
    title: "T",
    request: "R",
    source: "manual",
  }).id;
  const implement = () =>
    store.createRun({
      item_id: itemId,
      role: "agent",
      agent: "implement",
      agent_type: "IMPLEMENT",
      harness: "claude",
      model: null,
      input: "go",
      session_id: null,
      status: "succeeded",
    }).id;
  const calls: string[] = [];
  const comments = new Map<number, string>();
  let failUploads = false;
  const gh: EvidenceGitHub = {
    repoId: async (slug) => {
      calls.push(`repoId ${slug}`);
      return 42;
    },
    upload: async (repoId, file) => {
      calls.push(`upload ${repoId} ${file}`);
      if (failUploads) throw new Error("HTTP 502");
      return `https://github.com/user-attachments/assets/${file.slice(1)}`;
    },
    findComment: async (_slug, _n, marker) =>
      [...comments].find(([, body]) => body.includes(marker))?.[0] ?? null,
    createComment: async (slug, n, body) => {
      calls.push(`create ${slug}#${n}`);
      comments.set(comments.size + 1, body);
    },
    editComment: async (slug, id, body) => {
      calls.push(`edit ${slug} ${id}`);
      comments.set(id, body);
    },
  };
  const publisher = new EvidencePublisher(
    store,
    new Logger({ level: "error", write: () => {} }),
    gh,
  );
  return {
    store,
    itemId,
    implement,
    calls,
    comments,
    publisher,
    failUploads: (v: boolean) => {
      failUploads = v;
    },
  };
}

test("proof waits for a PR, then is uploaded and posted in one marked comment", async (t) => {
  const { store, itemId, implement, calls, comments, publisher } = setup(t);
  store.addEvidence(itemId, implement(), [
    { criterion: "Home lists the tools", file: "/a.png" },
    { criterion: "Errors show inline", file: "/b.png" },
  ]);
  await publisher.sweep();
  assert.deepEqual(calls, []);

  store.updateItem(itemId, { pr_url: "https://github.com/o/r/pull/7" });
  await publisher.sweep();
  assert.deepEqual(calls, [
    "repoId o/r",
    "upload 42 /a.png",
    "upload 42 /b.png",
    "create o/r#7",
  ]);
  const body = comments.get(1) ?? "";
  assert.ok(body.startsWith(MARKER));
  assert.match(
    body,
    /\*\*1\. Home lists the tools\*\*\n\n<img src="https:\/\/github\.com\/user-attachments\/assets\/a\.png"/,
  );
  assert.match(body, /\*\*2\. Errors show inline\*\*/);
  assert.deepEqual(store.itemsWithUnpostedEvidence(), []);

  // Nothing new: nothing posted again.
  await publisher.sweep();
  assert.equal(calls.length, 4);
});

test("a later run's proof replaces the comment's content", async (t) => {
  const { store, itemId, implement, calls, comments, publisher } = setup(t);
  store.updateItem(itemId, { pr_url: "https://github.com/o/r/pull/7" });
  store.addEvidence(itemId, implement(), [
    { criterion: "Old", file: "/old.png" },
  ]);
  await publisher.sweep();
  store.addEvidence(itemId, implement(), [
    { criterion: "New", file: "/new.png" },
  ]);
  await publisher.sweep();
  assert.deepEqual(calls.slice(-3), [
    "repoId o/r",
    "upload 42 /new.png",
    "edit o/r 1",
  ]);
  assert.equal(comments.size, 1);
  assert.match(comments.get(1) ?? "", /New/);
  assert.doesNotMatch(comments.get(1) ?? "", /Old/);
});

test("a failed upload waits before the next try, and resumes where it stopped", async (t) => {
  const { store, itemId, implement, calls, publisher, failUploads } = setup(t);
  store.updateItem(itemId, { pr_url: "https://github.com/o/r/pull/7" });
  store.addEvidence(itemId, implement(), [{ criterion: "c", file: "/a.png" }]);
  failUploads(true);
  const now = Date.now();
  await publisher.sweep(now);
  failUploads(false);
  await publisher.sweep(now + 60_000);
  assert.equal(calls.filter((c) => c.startsWith("upload")).length, 1);
  await publisher.sweep(now + 11 * 60_000);
  assert.deepEqual(calls.slice(-2), ["upload 42 /a.png", "create o/r#7"]);
});

test("criteria are text in the comment, not Markdown or HTML", () => {
  const body = evidenceComment([
    {
      id: 1,
      item_id: 1,
      run_id: 3,
      criterion: "<img src=x> **bold** [link](http://x)",
      file: "/a.png",
      github_url: "https://github.com/user-attachments/assets/a",
      created_at: "",
    },
  ]);
  assert.match(
    body,
    /\\<img src=x\\> \\\*\\\*bold\\\*\\\* \\\[link\\\]\(http:\/\/x\)/,
  );
  assert.match(body, /run #3/);
});
