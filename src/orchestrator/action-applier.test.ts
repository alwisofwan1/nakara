import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TestContext, test } from "node:test";

import { loadConfig } from "../config.ts";
import { Store } from "../db.ts";
import { HARNESS_FALLBACK, loadDefinition } from "../definition/load.ts";
import type { PrCheck } from "../domain/checks.ts";
import type { Action } from "../domain/policy.ts";
import type { PrIO } from "../domain/pushed.ts";
import { ActionApplier, type ActionIO, mirrorBody } from "./action-applier.ts";
import { RunControl } from "./run-support.ts";

const item0 = (s: Store) => s.items()[0]?.id ?? 0;

// No harness, gh or timers: GitHub and the workspace are an in-memory fake.
const loaded = await loadDefinition("factory", HARNESS_FALLBACK);
assert.ok(loaded.ok);
// The factory's repository: Policy refuses URLs anywhere else.
const definition = {
  ...loaded.definition,
  factory: {
    ...loaded.definition.factory,
    repositories: [
      { owner: "o", name: "r" },
      { owner: "alwisofwan1", name: "nakara" },
    ],
  },
};

const PR = "https://github.com/o/r/pull/1";
const handoff = { type: "handoff", prUrl: PR, summary: "Implemented" } as const;
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567";

function setup(
  t: { after: (fn: () => void) => void },
  io: {
    checks?: PrCheck[] | Error;
    readyFails?: boolean;
    removeFails?: boolean;
    mirror?: boolean;
    /** GitHub's view of the PR; by default its head is HEAD_SHA. */
    pr?: Partial<PrIO>;
    dataDir?: string;
    /** Runs while the gate reads the PR's checks, as a human acting meanwhile. */
    duringChecks?: (store: Store) => void;
  } = {},
) {
  const store = new Store(":memory:", { defaultBudgetUsd: 15 });
  t.after(() => store.close());
  const calls: string[][] = [];
  const fake: ActionIO = {
    readPrHead: async () => ({ sha: HEAD_SHA, branch: "nakara/1-x" }),
    onPr: async () => true,
    readPrState: async () => "OPEN",
    ...io.pr,
    readPrChecks: async (prUrl) => {
      calls.push(["checks", prUrl]);
      io.duringChecks?.(store);
      if (io.checks instanceof Error) throw io.checks;
      return io.checks ?? [{ name: "CI", bucket: "pass" }];
    },
    markReady: async (prUrl) => {
      calls.push(["ready", prUrl]);
      if (io.readyFails) throw new Error("authentication failed");
    },
    comment: async (url, body) => {
      calls.push(["comment", url, body]);
    },
    removeWorkspace: async (itemId) => {
      calls.push(["remove", String(itemId)]);
      if (io.removeFails) throw new Error("EACCES: permission denied");
    },
  };
  const control = new RunControl();
  const applier = new ActionApplier(
    store,
    loadConfig({
      NAKARA_GITHUB_MIRROR: String(io.mirror ?? false),
      ...(io.dataDir ? { NAKARA_DATA_DIR: io.dataDir } : {}),
    }),
    () => definition,
    fake,
    undefined,
    control,
  );
  const item = store.createItem({
    title: "T",
    request: "R",
    source: "manual",
    issueUrl: "https://github.com/o/r/issues/3",
  });
  const apply = (...actions: Action[]) =>
    applier.applyActions(
      item.id,
      actions.map((action) => ({ action, accepted: true })),
    );
  return { store, applier, item, calls, apply, control };
}

test("an action the foreman's tool refused, or the policy now refuses, is not applied", async (t) => {
  const { store, applier, item, calls } = setup(t);
  const refused = await applier.applyActions(item.id, [
    { action: { type: "post_update", message: "Hidden" }, accepted: false },
  ]);
  assert.deepEqual(refused, []);
  // No spec draft exists, so the policy refuses its approval request.
  const action = {
    type: "request_spec_approval",
    specPrUrl: "https://github.com/o/r/pull/2",
    summary: "Spec",
  } as const;
  assert.deepEqual(
    await applier.applyActions(item.id, [{ action, accepted: true }]),
    [],
  );
  assert.deepEqual(store.messages(item.id), []);
  assert.deepEqual(store.approvals(item.id), []);
  assert.deepEqual(calls, []);
});

test("accepted actions move the policy state and record their effects", async (t) => {
  const { store, item, apply, calls } = setup(t);
  const dispatch = {
    type: "dispatch_agent",
    agent: "triage",
    agentType: "TRIAGE",
    brief: "Look into it.",
  } as const;
  const ask: Action = {
    type: "ask_human",
    question: "Which one?",
    options: ["a", "b"],
  };
  const refs = {
    type: "record_refs",
    issueUrl: "https://github.com/o/r/issues/9",
  } as const;
  assert.deepEqual(await apply(dispatch, ask, refs), [dispatch, ask, refs]);
  const after = store.item(item.id);
  assert.equal(after?.stage, "triage");
  assert.equal(after?.status, "waiting_human");
  assert.equal(after?.issue_url, refs.issueUrl);
  const [run] = store.runs(item.id);
  assert.equal(run?.agent, "triage");
  assert.equal(run?.status, "queued");
  assert.equal(run?.input, dispatch.brief);
  const [approval] = store.approvals(item.id);
  assert.equal(approval?.kind, "question");
  assert.equal(approval?.options, JSON.stringify(["a", "b"]));
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    ["Which one?"],
  );
  // The mirror is off.
  assert.deepEqual(calls, []);
});

test("complete_task closes the item and removes its workspace", async (t) => {
  const { store, item, apply, calls } = setup(t);
  const done = { type: "complete_task", summary: "All done." } as const;
  assert.deepEqual(await apply(done), [done]);
  assert.equal(store.item(item.id)?.stage, "complete");
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [done.summary],
  );
  assert.deepEqual(calls, [["remove", String(item.id)]]);
});

test("complete_task stops the item's runs before deleting its workspace", async (t) => {
  const { store, item, apply, control } = setup(t);
  const run = (role: "agent" | "foreman", status: "queued" | "running") =>
    store.createRun({
      item_id: item.id,
      role,
      agent: role === "agent" ? "triage" : "foreman",
      agent_type: role === "agent" ? "TRIAGE" : "FOREMAN",
      harness: "none",
      model: null,
      session_id: null,
      status,
      input: "x",
    });
  const queued = run("agent", "queued");
  const running = run("agent", "running");
  const foreman = run("foreman", "running");
  const aborts = new Map(
    [running, foreman].map((r) => [r.id, new AbortController()]),
  );
  for (const [id, c] of aborts) control.controllers.set(id, c);
  await apply({ type: "complete_task", summary: "All done." });
  assert.equal(store.runById(queued.id)?.status, "cancelled");
  assert.equal(aborts.get(running.id)?.signal.aborted, true);
  // The foreman's own run is still ending the turn that completed the task.
  assert.equal(aborts.get(foreman.id)?.signal.aborted, false);
});

test("a handoff the policy refuses after the gate's GitHub calls is not applied", async (t) => {
  const { store, item, apply, calls } = setup(t, {
    // A human cancels the item while the checks are being read.
    duringChecks: (s) =>
      s.updateItem(item0(s), { stage: "cancelled", status: "done" }),
  });
  assert.deepEqual(await apply(handoff), []);
  assert.equal(store.item(item.id)?.stage, "cancelled");
  assert.equal(
    calls.some((c) => c[0] === "ready"),
    false,
  );
  assert.deepEqual(store.messages(item.id), []);
});

test("a handoff with passing checks marks the PR ready, then announces and mirrors it", async (t) => {
  const { store, item, apply, calls } = setup(t, { mirror: true });
  assert.deepEqual(await apply(handoff), [handoff]);
  const after = store.item(item.id);
  assert.equal(after?.stage, "handoff");
  assert.equal(after?.pr_url, PR);
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [
      `Ready for your review and merge: ${PR} (checks passed on 0123456)\n\nImplemented`,
    ],
  );
  assert.equal(store.getKv(`ci-failed:${item.id}`), "");
  assert.equal(store.getKv(`ci-wait:${item.id}`), "");
  assert.deepEqual(calls, [
    ["checks", PR],
    ["ready", PR],
    // biome-ignore lint/style/noNonNullAssertion: A handoff always has a mirror body.
    ["comment", "https://github.com/o/r/issues/3", mirrorBody(handoff)!],
  ]);
});

test("a handoff with failed checks is refused and tells the foreman", async (t) => {
  const { store, item, apply, calls } = setup(t, {
    checks: [{ name: "CI", bucket: "fail" }],
  });
  assert.deepEqual(await apply(handoff), []);
  const after = store.item(item.id);
  assert.equal(after?.stage, "intake");
  assert.equal(after?.pr_url, PR);
  assert.equal(store.getKv(`ci-failed:${item.id}`), "1");
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [`CI failed on ${PR}: CI`],
  );
  const [event] = store.pendingEvents(item.id).slice(-1);
  assert.equal(event?.kind, "checks_updated");
  assert.match(event?.payload ?? "", /Checks failed: CI/);
  assert.deepEqual(calls, [["checks", PR]]);
});

test("a handoff with pending checks waits for them without waking the foreman", async (t) => {
  const { store, item, apply } = setup(t, {
    checks: [{ name: "CI", bucket: "pending" }],
  });
  const before = store.pendingEvents(item.id).length;
  assert.deepEqual(await apply(handoff), []);
  assert.equal(store.getKv(`ci-wait:${item.id}`), PR);
  assert.equal(store.pendingEvents(item.id).length, before);
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [`Waiting for CI on ${PR}`],
  );
});

test("a handoff whose checks cannot be read waits for the operator", async (t) => {
  const { store, item, apply } = setup(t, { checks: new Error("forbidden") });
  assert.deepEqual(await apply(handoff), []);
  const after = store.item(item.id);
  assert.equal(after?.status, "waiting_human");
  assert.equal(after?.pr_url, PR);
  assert.match(
    store.messages(item.id)[0]?.body ?? "",
    /^Could not read PR checks: Error: forbidden/,
  );
});

test("a handoff whose PR head cannot be looked up names the lookup, not the checks", async (t) => {
  const { store, item, apply, calls } = setup(t, {
    pr: {
      readPrHead: async () => {
        throw new Error("gh: Not Found (HTTP 404)");
      },
    },
  });
  assert.deepEqual(await apply(handoff), []);
  assert.equal(store.item(item.id)?.status, "waiting_human");
  assert.deepEqual(store.pendingEvents(item.id), []);
  const [message] = store.messages(item.id);
  assert.match(
    message?.body ?? "",
    new RegExp(
      `^Could not look up ${PR} on GitHub to check that the work is on it: Error: gh: Not Found`,
    ),
  );
  assert.ok(!message?.body.includes("Checks/Actions"));
  assert.deepEqual(calls, []);
});

test("a handoff whose PR cannot be marked ready is reported, not announced", async (t) => {
  const { store, item, apply, calls } = setup(t, {
    readyFails: true,
    mirror: true,
  });
  assert.deepEqual(await apply(handoff), []);
  const [message] = store.messages(item.id);
  assert.match(message?.body ?? "", /^Could not mark PR ready for review/);
  assert.deepEqual(calls.at(-1), [
    "comment",
    "https://github.com/o/r/issues/3",
    message?.body,
  ]);
});

test("an active item with nothing in motion is surfaced to the operator", async (t) => {
  const { store, applier, item } = setup(t);
  applier.checkStalled(store.item(item.id) ?? item, []);
  assert.equal(store.item(item.id)?.status, "waiting_human");
  assert.match(
    store.messages(item.id)[0]?.body ?? "",
    /^Nothing is in progress/,
  );
});

test("an item with pending events or queued work is not stalled", async (t) => {
  const { store, applier, item, apply } = setup(t);
  const event = store.addEvent(item.id, "human_message", { message: "Hi" });
  applier.checkStalled(item, []);
  assert.equal(store.item(item.id)?.status, "active");
  store.markEventsProcessed([event]);
  const dispatch = {
    type: "dispatch_agent",
    agent: "triage",
    agentType: "TRIAGE",
    brief: "Go.",
  } as const;
  const applied = await apply(dispatch);
  applier.checkStalled(store.item(item.id) ?? item, applied);
  assert.equal(store.item(item.id)?.status, "active");
  assert.deepEqual(store.messages(item.id), []);
});

test("pause records why the item stopped", (t) => {
  const { store, applier, item } = setup(t);
  applier.pause(item, "Out of turns.");
  assert.equal(store.item(item.id)?.status, "paused");
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    ["Out of turns."],
  );
});

test("only conversation and handoff actions are mirrored to the issue", () => {
  assert.equal(mirrorBody({ type: "post_update", message: "Hi" }), "Hi");
  assert.equal(mirrorBody({ type: "ask_human", question: "Q?" }), "Q?");
  assert.equal(
    mirrorBody({
      type: "request_spec_approval",
      specPrUrl: "https://github.com/o/r/pull/2",
      summary: "Spec",
    }),
    "Spec ready for approval: https://github.com/o/r/pull/2\n\nSpec",
  );
  assert.equal(
    mirrorBody(handoff),
    `Ready for review and merge: ${PR}\n\nImplemented`,
  );
  assert.equal(mirrorBody({ type: "complete_task", summary: "Done" }), null);
  assert.equal(mirrorBody({ type: "record_refs", prUrl: PR }), null);
});

const BRANCH = "nakara/7-fix";
const REPO_PR = "https://github.com/alwisofwan1/nakara/pull/7";

/**
 * The PR branch on a local bare repository standing in for GitHub, and the
 * item's worktree of a bare clone of it, as prepareWorkspace makes them.
 */
function pushed(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "nakara-pushed-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), `${file}\n`);
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      file,
    );
    return git(cwd, "rev-parse", "HEAD");
  };
  const seed = join(dataDir, "seed");
  mkdirSync(seed);
  git(seed, "init", "--quiet", "--initial-branch=main");
  commit(seed, "README.md");
  git(seed, "checkout", "-q", "-b", BRANCH);
  commit(seed, "fix.txt");
  const github = join(dataDir, "github.git");
  git(dataDir, "clone", "--bare", "--quiet", seed, github);
  const bare = join(dataDir, "cache.git");
  git(dataDir, "clone", "--bare", "--quiet", github, bare);
  const pr: PrIO = {
    readPrHead: async () => ({
      sha: git(github, "rev-parse", BRANCH),
      branch: BRANCH,
    }),
    // GitHub's compare: a commit it does not have is not on the PR either.
    onPr: async (_url, sha, head) => {
      try {
        execFileSync("git", ["merge-base", "--is-ancestor", sha, head.sha], {
          cwd: github,
          stdio: "ignore",
        });
        return true;
      } catch {
        return false;
      }
    },
  };
  const worktree = (itemId: number) => {
    const path = join(
      loadConfig({ NAKARA_DATA_DIR: dataDir }).workDir,
      `item-${itemId}`,
      "nakara",
    );
    git(bare, "worktree", "add", "--quiet", path, BRANCH);
    return path;
  };
  return { dataDir, pr, git, commit, worktree, github };
}

const handoffTo = {
  type: "handoff",
  prUrl: REPO_PR,
  summary: "Implemented",
} as const;

test("a handoff whose worktree HEAD is the PR head goes ahead and names that head", async (t) => {
  const { dataDir, pr, git, worktree } = pushed(t);
  const { store, item, apply } = setup(t, { pr, dataDir });
  const head = git(worktree(item.id), "rev-parse", "HEAD");
  assert.deepEqual(await apply(handoffTo), [handoffTo]);
  assert.equal(store.item(item.id)?.stage, "handoff");
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [
      `Ready for your review and merge: ${REPO_PR} (checks passed on ${head.slice(0, 7)})\n\nImplemented`,
    ],
  );
});

test("a handoff with an unpushed commit is refused until it is pushed", async (t) => {
  const { dataDir, pr, git, commit, worktree, github } = pushed(t);
  const { store, item, apply, calls } = setup(t, { pr, dataDir });
  const path = worktree(item.id);
  const prHead = git(github, "rev-parse", BRANCH);
  const local = commit(path, "review-fix.txt");
  assert.deepEqual(await apply(handoffTo), []);
  assert.equal(store.item(item.id)?.stage, "intake");
  // The checks of a stale head are not read at all.
  assert.deepEqual(calls, []);
  const [event] = store.pendingEvents(item.id).slice(-1);
  assert.equal(event?.kind, "checks_updated");
  const { message } = JSON.parse(event?.payload ?? "{}");
  assert.match(message, new RegExp(`worktree is at ${local}`));
  assert.match(message, new RegExp(`is at ${prHead} \\(branch ${BRANCH}\\)`));
  assert.match(message, new RegExp(`git push origin HEAD:${BRANCH}`));
  assert.deepEqual(
    store.messages(item.id).map((m) => m.body),
    [
      `The work is not on ${REPO_PR} yet: the alwisofwan1/nakara worktree is at ${local.slice(0, 7)}, the PR at ${prHead.slice(0, 7)}. Waiting for it to be pushed.`,
    ],
  );

  git(path, "push", "-q", "origin", `HEAD:${BRANCH}`);
  assert.deepEqual(await apply(handoffTo), [handoffTo]);
  assert.equal(store.item(item.id)?.stage, "handoff");
  assert.match(
    store.messages(item.id).at(-1)?.body ?? "",
    new RegExp(`checks passed on ${local.slice(0, 7)}`),
  );
});

test("a handoff from a local branch without an upstream is refused", async (t) => {
  const { dataDir, pr, git, commit, worktree } = pushed(t);
  const { store, item, apply } = setup(t, { pr, dataDir });
  const path = worktree(item.id);
  git(path, "checkout", "-q", "-b", "pr99");
  const local = commit(path, "review-fix.txt");
  // What the agent ran: git refuses, and the agent reported "pushed".
  assert.throws(() =>
    execFileSync("git", ["push", "-q"], { cwd: path, stdio: "ignore" }),
  );
  assert.deepEqual(await apply(handoffTo), []);
  assert.equal(store.item(item.id)?.stage, "intake");
  const [event] = store.pendingEvents(item.id).slice(-1);
  assert.match(event?.payload ?? "", new RegExp(local));
});

const pushOnly = {
  type: "follow_up",
  agent: "implement",
  agentType: "IMPLEMENT",
  message: "Push your commits.",
  pushOnly: true,
} as const;
const fixes = { ...pushOnly, message: "Fix the tests.", pushOnly: undefined };
const { maxRevisions } = loadConfig({}).limits;

test("after an unpushed refusal, one push-only follow_up is allowed past the revision cap and does not count", async (t) => {
  const { dataDir, pr, git, commit, worktree } = pushed(t);
  const { store, item, apply } = setup(t, { pr, dataDir });
  store.updateItem(item.id, {
    stage: "reviewing",
    review_count: 1,
    revision_count: maxRevisions,
  });
  const path = worktree(item.id);
  commit(path, "review-fix.txt");
  // At the cap, neither kind of follow_up goes before a refused handoff.
  assert.deepEqual(await apply(pushOnly), []);
  assert.deepEqual(await apply(fixes), []);

  assert.deepEqual(await apply(handoffTo), []);
  const [event] = store.pendingEvents(item.id).slice(-1);
  assert.match(event?.payload ?? "", /follow_up with push_only: true/);
  assert.deepEqual(await apply(pushOnly), [pushOnly]);
  assert.equal(store.item(item.id)?.revision_count, maxRevisions);
  assert.equal(store.item(item.id)?.stage, "building");
  // Nakara writes the prompt: push only, no code changes.
  const [run] = store.runs(item.id);
  assert.match(run?.input ?? "", /^Push only\./);
  assert.match(run?.input ?? "", new RegExp(`git push origin HEAD:${BRANCH}`));
  assert.match(run?.input ?? "", /Make no code changes/);
  assert.doesNotMatch(run?.input ?? "", /Push your commits\./);
  // Once per refusal: a second one in a row is refused.
  assert.deepEqual(await apply(pushOnly), []);

  // The agent pushed: the handoff goes ahead.
  git(path, "push", "-q", "origin", `HEAD:${BRANCH}`);
  assert.deepEqual(await apply(handoffTo), [handoffTo]);
  assert.equal(store.item(item.id)?.revision_count, maxRevisions);
  assert.equal(store.getKv(`push-only:${item.id}`), "");
});

test("when the work is still not on the PR after the push-only follow_up, the next refusal waits for a human", async (t) => {
  const { dataDir, pr, commit, worktree } = pushed(t);
  const { store, item, apply } = setup(t, { pr, dataDir });
  store.updateItem(item.id, {
    stage: "reviewing",
    review_count: 1,
    revision_count: maxRevisions - 1,
  });
  const local = commit(worktree(item.id), "review-fix.txt");
  assert.deepEqual(await apply(handoffTo), []);
  assert.deepEqual(await apply(pushOnly), [pushOnly]);
  assert.equal(store.item(item.id)?.revision_count, maxRevisions - 1);
  const events = store.pendingEvents(item.id).length;

  // The agent did not push.
  assert.deepEqual(await apply(handoffTo), []);
  const after = store.item(item.id);
  assert.equal(after?.status, "waiting_human");
  assert.equal(after?.stage, "building");
  assert.equal(store.pendingEvents(item.id).length, events);
  assert.match(
    store.messages(item.id).at(-1)?.body ?? "",
    new RegExp(
      `^The work is still not on ${REPO_PR} after a push-only follow-up: the alwisofwan1/nakara worktree is at ${local.slice(0, 7)}`,
    ),
  );
  // No further exempt follow_up: a regular one counts toward the cap.
  assert.deepEqual(await apply(pushOnly), []);
  assert.deepEqual(await apply(fixes), [fixes]);
  assert.equal(store.item(item.id)?.revision_count, maxRevisions);
  assert.deepEqual(await apply(fixes), []);
});

test("complete_task survives a workspace that cannot be deleted", async (t) => {
  const { store, item, apply } = setup(t, { removeFails: true });
  const done = { type: "complete_task", summary: "All done." } as const;
  // Without the catch, the rejection is unhandled and ends the process.
  assert.deepEqual(await apply(done), [done]);
  await new Promise((r) => setImmediate(r));
  assert.equal(store.item(item.id)?.stage, "complete");
});

test("a record_refs naming another repository's issue or PR is not applied", async (t) => {
  const { store, item, apply } = setup(t);
  for (const action of [
    { type: "record_refs", prUrl: "https://github.com/evil/r/pull/1" },
    { type: "record_refs", issueUrl: "https://github.com/evil/r/issues/1" },
  ] as const)
    assert.deepEqual(await apply(action), []);
  assert.equal(store.item(item.id)?.pr_url ?? null, null);
  assert.equal(
    store.item(item.id)?.issue_url,
    "https://github.com/o/r/issues/3",
  );
});

test("a mirrored update is posted with token-shaped strings redacted", async (t) => {
  const { calls, apply } = setup(t, { mirror: true });
  const token = `ghp_${"a1B2".repeat(6)}`;
  await apply({ type: "post_update", message: `Found ${token} in the log` });
  for (let i = 0; i < 20 && !calls.some((c) => c[0] === "comment"); i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  const comment = calls.find((c) => c[0] === "comment");
  assert.equal(comment?.[2], "Found [redacted] in the log");
});
