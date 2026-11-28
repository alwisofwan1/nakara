import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BUDGET_STEP_USD,
  check,
  checkRetry,
  decideSpec,
  GATE_CHECKS,
  gateEvidence,
  parseGateChecks,
  raiseBudget,
  raiseRunLimit,
  RUN_STEP,
  type Action,
  type AgentType,
  type PolicyState,
  type SpecRule,
} from "./policy.ts";

const repos = ["o/r"];
const fresh: PolicyState = {
  stage: "intake",
  status: "active",
  specState: "none",
  reviewCount: 0,
  revisionCount: 0,
  costUsd: 0,
  budgetUsd: 10,
  runCount: 0,
  maxRuns: 30,
  maxReviews: 1,
  maxRevisions: 2,
  specRule: "when_asked",
  specRequested: false,
  gateChecks: [],
  reviewAccepted: false,
  verificationPassed: false,
  prUrl: null,
  prMerged: false,
};

const dispatch = (agentType: AgentType, agent = "x"): Action => ({
  type: "dispatch_agent",
  agent,
  agentType,
  brief: "b",
});
const followUp = (agentType: AgentType, agent = "x"): Action => ({
  type: "follow_up",
  agent,
  agentType,
  message: "m",
});

const apply = (state: PolicyState, ...actions: Action[]): PolicyState =>
  actions.reduce((s, a) => {
    const v = check(s, a, repos);
    assert.ok(
      v.ok,
      `expected ${a.type} to be allowed: ${v.ok ? "" : v.reason}`,
    );
    return v.next;
  }, state);

test("implementation waits for an approved spec", () => {
  const drafting = apply(fresh, dispatch("SPEC"));
  assert.equal(check(drafting, dispatch("IMPLEMENT"), repos).ok, false);

  const awaiting = apply(drafting, {
    type: "request_spec_approval",
    specPrUrl: "https://github.com/o/r/pull/1",
    summary: "s",
  });
  assert.equal(awaiting.status, "waiting_human");
  assert.equal(check(awaiting, dispatch("IMPLEMENT"), repos).ok, false);

  const approved = decideSpec(awaiting, true);
  assert.equal(apply(approved, dispatch("IMPLEMENT")).stage, "building");
});

test("rejected spec returns to drafting", () => {
  const awaiting = apply(fresh, dispatch("SPEC"), {
    type: "request_spec_approval",
    specPrUrl: "https://github.com/o/r/pull/9",
    summary: "s",
  });
  assert.equal(decideSpec(awaiting, false).specState, "drafting");
});

const SPEC_FIRST = "This factory writes a Spec first. Dispatch the spec agent.";
const NO_SPECS =
  "This factory does not write Specs. Dispatch implement directly.";

test("the item's Spec rule decides whether implement waits for a Spec and whether a Spec may be written", () => {
  const cases: [SpecRule, boolean, string | null, string | null][] = [
    // rule, requested, IMPLEMENT refusal, SPEC refusal
    ["always", false, SPEC_FIRST, null],
    ["always", true, SPEC_FIRST, null],
    ["when_asked", true, SPEC_FIRST, null],
    // Today's behaviour: the Foreman decides.
    ["when_asked", false, null, null],
    ["never", false, null, NO_SPECS],
    ["never", true, null, NO_SPECS],
  ];
  for (const [specRule, specRequested, implement, spec] of cases) {
    const state = { ...fresh, specRule, specRequested };
    const label = `${specRule}, requested: ${specRequested}`;
    for (const [agentType, reason] of [
      ["IMPLEMENT", implement],
      ["SPEC", spec],
    ] as const) {
      const verdict = check(state, dispatch(agentType), repos);
      assert.deepEqual(
        verdict.ok ? null : verdict.reason,
        reason,
        `${label}: ${agentType}`,
      );
    }
  }
});

test("a Spec the rule asks for, once approved, lets implement start", () => {
  for (const [specRule, specRequested] of [
    ["always", false],
    ["when_asked", true],
  ] as const) {
    const awaiting = apply(
      { ...fresh, specRule, specRequested },
      dispatch("SPEC"),
      {
        type: "request_spec_approval",
        specPrUrl: "https://github.com/o/r/pull/1",
        summary: "s",
      },
    );
    assert.equal(
      apply(decideSpec(awaiting, true), dispatch("IMPLEMENT")).stage,
      "building",
    );
  }
  // A custom agent builds code too, so it cannot skip the Spec either.
  assert.deepEqual(
    check({ ...fresh, specRule: "always" }, dispatch("CUSTOM"), repos),
    { ok: false, reason: SPEC_FIRST },
  );
});

const NO_SPEC_AGENT =
  "This factory writes a Spec first, but the definition has no spec agent, so no Spec can be written. Do not dispatch one: ask_human to add a SPEC agent to the definition, or to cancel this Work Item. Changing the factory's Spec rule only affects new Work Items, not this one.";

test("under always without a spec agent, implement is refused with a reason that does not ask for the spec agent", () => {
  const state: PolicyState = { ...fresh, specRule: "always", specAgent: false };
  for (const agentType of ["IMPLEMENT", "CUSTOM"] as const)
    assert.deepEqual(check(state, dispatch(agentType), repos), {
      ok: false,
      reason: NO_SPEC_AGENT,
    });
  // A factory with a spec agent keeps its reason, and the other rules ignore the agent.
  assert.deepEqual(
    check({ ...state, specAgent: true }, dispatch("IMPLEMENT"), repos),
    { ok: false, reason: SPEC_FIRST },
  );
  for (const specRule of ["when_asked", "never"] as const)
    assert.equal(
      apply({ ...state, specRule }, dispatch("IMPLEMENT")).stage,
      "building",
    );
  // An item that asked for a Spec is told it asked, not that the factory always does.
  assert.deepEqual(
    check(
      { ...state, specRule: "when_asked", specRequested: true },
      dispatch("IMPLEMENT"),
      repos,
    ),
    {
      ok: false,
      reason: NO_SPEC_AGENT.replace(
        "This factory writes a Spec first",
        "This Work Item asked for a Spec first",
      ),
    },
  );
});

test("handoff waits for the Spec the rule asks for", () => {
  const handoff: Action = {
    type: "handoff",
    prUrl: "https://github.com/o/r/pull/2",
    summary: "s",
  };
  const always: PolicyState = { ...fresh, specRule: "always" };
  assert.deepEqual(check(always, handoff, repos), {
    ok: false,
    reason: SPEC_FIRST,
  });
  assert.deepEqual(check({ ...always, specAgent: false }, handoff, repos), {
    ok: false,
    reason: NO_SPEC_AGENT,
  });
  const approved = decideSpec(
    apply(always, dispatch("SPEC"), {
      type: "request_spec_approval",
      specPrUrl: "https://github.com/o/r/pull/2",
      summary: "s",
    }),
    true,
  );
  assert.equal(
    apply(approved, dispatch("IMPLEMENT"), handoff).stage,
    "handoff",
  );
  // An item that asked for a Spec waits too; one that did not hands off as before.
  assert.equal(
    check({ ...fresh, specRequested: true }, handoff, repos).ok,
    false,
  );
  assert.equal(apply(fresh, handoff).stage, "handoff");
});

test("handoff needs the checks the factory added to its Handoff Gate, judged on the latest runs", () => {
  const handoff: Action = {
    type: "handoff",
    prUrl: "https://github.com/o/r/pull/2",
    summary: "s",
  };
  const review = (verdict: string | null, status = "succeeded") => ({
    role: "agent",
    agent_type: "REVIEW",
    status,
    review_verdict: verdict,
  });
  const verify = (status: string) => ({
    role: "agent",
    agent_type: "VERIFY",
    status,
    review_verdict: null,
  });
  const gated = (
    gateChecks: PolicyState["gateChecks"],
    runs: Parameters<typeof gateEvidence>[0],
  ): PolicyState => ({ ...fresh, gateChecks, ...gateEvidence(runs) });

  // Review accepted: refused on "revision needed", allowed on "accepted".
  assert.deepEqual(
    check(gated(["review"], [review("revision_needed")]), handoff, repos),
    {
      ok: false,
      reason:
        "This factory's Handoff Gate also needs an accepted Review. Dispatch review first.",
    },
  );
  assert.equal(check(gated(["review"], []), handoff, repos).ok, false);
  assert.equal(
    apply(gated(["review"], [review("accepted")]), handoff).stage,
    "handoff",
  );
  // Only the latest review counts: a later one asking for revision undoes the acceptance.
  assert.equal(
    check(
      gated(["review"], [review("accepted"), review("revision_needed")]),
      handoff,
      repos,
    ).ok,
    false,
  );

  // Verification passed: refused when the latest verify run failed, allowed when it succeeded.
  assert.deepEqual(
    check(gated(["verification"], [verify("failed")]), handoff, repos),
    {
      ok: false,
      reason:
        "This factory's Handoff Gate also needs a passed Verification. Dispatch verification first.",
    },
  );
  assert.equal(check(gated(["verification"], []), handoff, repos).ok, false);
  assert.equal(
    check(
      gated(["verification"], [verify("succeeded"), verify("running")]),
      handoff,
      repos,
    ).ok,
    false,
  );
  assert.equal(
    apply(gated(["verification"], [verify("succeeded")]), handoff).stage,
    "handoff",
  );

  // Both checks: each one is needed.
  assert.equal(
    check(
      gated(["review", "verification"], [review("accepted")]),
      handoff,
      repos,
    ).ok,
    false,
  );
  assert.equal(
    apply(
      gated(
        ["review", "verification"],
        [review("accepted"), verify("succeeded")],
      ),
      handoff,
    ).stage,
    "handoff",
  );
  // A factory that added none hands off as before, whatever the runs,
  // the review limit or the agents.
  assert.equal(
    apply(
      {
        ...gated([], [review("revision_needed"), verify("failed")]),
        reviewCount: 1,
        verifyAgent: false,
      },
      handoff,
    ).stage,
    "handoff",
  );
});

test("a gate check the item's limits or agents cannot meet sends the Foreman to ask_human", () => {
  const prUrl = "https://github.com/o/r/pull/2";
  const handoff: Action = { type: "handoff", prUrl, summary: "s" };
  const run = (agent_type: string, review_verdict: string | null) => ({
    role: "agent",
    agent_type,
    status: "succeeded",
    review_verdict,
  });

  // Review accepted, and the only review asked for changes; implement fixed
  // them, but review cannot run again under the limit.
  const reviewed: PolicyState = {
    ...apply(
      { ...fresh, gateChecks: ["review"], prUrl },
      dispatch("IMPLEMENT"),
      dispatch("REVIEW"),
      followUp("IMPLEMENT"),
    ),
    ...gateEvidence([run("REVIEW", "revision_needed")]),
  };
  assert.equal(reviewed.reviewCount, 1);
  assert.deepEqual(check(reviewed, handoff, repos), {
    ok: false,
    reason:
      "This factory's Handoff Gate needs an accepted Review, but the latest review did not accept the change and the review limit (1 of 1) is used up, so review cannot run again. Do not dispatch review: ask_human to review and merge the pull request themselves, or to cancel this Work Item. The item copied its review limit when it was created, so changing the factory's limit does not free it.",
  });
  // The gate does not lift the review limit.
  assert.deepEqual(check(reviewed, dispatch("REVIEW"), repos), {
    ok: false,
    reason:
      "Review already ran 1 time(s); the limit is 1. A re-review, dispatched or sent as a follow_up, uses one review. Hand the PR to the human.",
  });
  // Nor does a follow-up to the review agent get around it.
  assert.deepEqual(
    check(reviewed, followUp("REVIEW"), repos),
    check(reviewed, dispatch("REVIEW"), repos),
  );
  // With a review left, the Foreman is still told to dispatch review.
  assert.match(
    (
      check({ ...reviewed, maxReviews: 2 }, handoff, repos) as {
        reason: string;
      }
    ).reason,
    /Dispatch review first\.$/,
  );
  // An accepted latest review hands off at the limit.
  assert.equal(
    apply({ ...reviewed, reviewAccepted: true }, handoff).stage,
    "handoff",
  );

  // Verification passed, and the definition has no verify agent.
  const unverified: PolicyState = {
    ...fresh,
    gateChecks: ["verification"],
    verifyAgent: false,
  };
  assert.deepEqual(check(unverified, handoff, repos), {
    ok: false,
    reason:
      "This factory's Handoff Gate needs a passed Verification, but the definition has no verify agent, so no Verification can run. Do not dispatch one: ask_human to add a VERIFY agent to the definition, or to review and merge the pull request themselves. Changing the factory's Handoff Gate only affects new Work Items, not this one.",
  });
  // With a verify agent, or when the definition is unknown, it says dispatch.
  for (const verifyAgent of [true, undefined])
    assert.match(
      (
        check({ ...unverified, verifyAgent }, handoff, repos) as {
          reason: string;
        }
      ).reason,
      /Dispatch verification first\.$/,
    );
});

test("an item's gate checks are read from its snapshot; CI is never one of them", () => {
  assert.deepEqual(parseGateChecks("[]"), []);
  assert.deepEqual(parseGateChecks('["verification","review"]'), [
    "review",
    "verification",
  ]);
  // CI and pushed are fixed: a snapshot naming them adds nothing and removes nothing.
  assert.deepEqual(parseGateChecks('["ci","pushed","review"]'), ["review"]);
  assert.deepEqual(parseGateChecks("not json"), []);
  assert.deepEqual([...GATE_CHECKS], ["review", "verification"]);
});

test("review runs once and needs a PR", () => {
  assert.equal(check(fresh, dispatch("REVIEW"), repos).ok, false);
  const reviewed = apply(
    fresh,
    dispatch("IMPLEMENT"),
    { type: "record_refs", prUrl: "https://github.com/o/r/pull/2" },
    dispatch("REVIEW"),
  );
  assert.equal(reviewed.reviewCount, 1);
  assert.equal(check(reviewed, dispatch("REVIEW"), repos).ok, false);
});

test("revisions after review go through follow_up and are capped", () => {
  const reviewed = apply(
    fresh,
    dispatch("IMPLEMENT"),
    { type: "record_refs", prUrl: "https://github.com/o/r/pull/1" },
    dispatch("REVIEW"),
  );
  assert.equal(check(reviewed, dispatch("IMPLEMENT"), repos).ok, false);
  const twice = apply(reviewed, followUp("IMPLEMENT"), followUp("IMPLEMENT"));
  assert.equal(twice.revisionCount, 2);
  assert.equal(check(twice, followUp("IMPLEMENT"), repos).ok, false);
});

test("the review cap is the item's own", () => {
  const reviewed = apply(
    { ...fresh, maxReviews: 2 },
    dispatch("IMPLEMENT"),
    { type: "record_refs", prUrl: "https://github.com/o/r/pull/2" },
    dispatch("REVIEW"),
    dispatch("REVIEW"),
  );
  assert.equal(reviewed.reviewCount, 2);
  const third = check(reviewed, dispatch("REVIEW"), repos);
  assert.equal(third.ok, false);
  assert.match(third.ok ? "" : third.reason, /the limit is 2/);
});

test("a follow-up review counts toward the review cap like a dispatch", () => {
  const reviewed = apply(
    { ...fresh, maxReviews: 2 },
    dispatch("IMPLEMENT"),
    { type: "record_refs", prUrl: "https://github.com/o/r/pull/2" },
    dispatch("REVIEW"),
    followUp("IMPLEMENT"),
    followUp("REVIEW"),
  );
  assert.equal(reviewed.reviewCount, 2);
  assert.equal(reviewed.stage, "reviewing");
  for (const third of [dispatch("REVIEW"), followUp("REVIEW")]) {
    const verdict = check(reviewed, third, repos);
    assert.equal(verdict.ok, false);
    assert.match(
      verdict.ok ? "" : verdict.reason,
      /Review already ran 2 time\(s\); the limit is 2\. A re-review, dispatched or sent as a follow_up, uses one review\./,
    );
  }
});

test("the revision cap is the item's own", () => {
  const reviewed = apply(
    { ...fresh, maxRevisions: 0 },
    dispatch("IMPLEMENT"),
    { type: "record_refs", prUrl: "https://github.com/o/r/pull/1" },
    dispatch("REVIEW"),
  );
  const refused = check(reviewed, followUp("IMPLEMENT"), repos);
  assert.equal(refused.ok, false);
  assert.match(
    refused.ok ? "" : refused.reason,
    /Revision limit reached \(0\)/,
  );
  const raised = apply(
    { ...reviewed, maxRevisions: 3 },
    followUp("IMPLEMENT"),
    followUp("IMPLEMENT"),
    followUp("IMPLEMENT"),
  );
  assert.equal(raised.revisionCount, 3);
  assert.equal(check(raised, followUp("IMPLEMENT"), repos).ok, false);
});

test("budget cap blocks new agent work but not communication", () => {
  const broke = { ...fresh, costUsd: 10 };
  assert.equal(check(broke, dispatch("TRIAGE"), repos).ok, false);
  assert.equal(
    check(broke, { type: "post_update", message: "m" }, repos).ok,
    true,
  );
  assert.equal(
    check(broke, { type: "ask_human", question: "q" }, repos).ok,
    true,
  );
});

test("budget checks use the work item's own budget", () => {
  const spent = { ...fresh, costUsd: 12 };
  assert.equal(
    check({ ...spent, budgetUsd: 20 }, dispatch("TRIAGE"), repos).ok,
    true,
  );
  const capped = check({ ...spent, budgetUsd: 12 }, followUp("TRIAGE"), repos);
  assert.equal(capped.ok, false);
  assert.match(capped.ok ? "" : capped.reason, /\$12\.00 of \$12\.00/);
});

test("the run limit refuses dispatches and follow-ups with a reason for the foreman", () => {
  const used = { ...fresh, stage: "building" as const, runCount: 30 };
  for (const action of [dispatch("TRIAGE"), followUp("IMPLEMENT")]) {
    const refused = check(used, action, repos);
    assert.equal(refused.ok, false);
    assert.equal(
      refused.ok ? "" : refused.reason,
      "Run limit reached (30 of 30 runs, foreman turns and failed runs included). Tell the user the work waits until they press Raise run limit on the work item, or cancel it.",
    );
  }
  // The push-only follow_up is a run too.
  const pushOnly = check(
    { ...used, pushOnlyBranch: "b" },
    { ...followUp("IMPLEMENT"), pushOnly: true } as Action,
    repos,
  );
  assert.equal(pushOnly.ok, false);
  // Telling the user is not a run.
  assert.equal(
    check(used, { type: "post_update", message: "m" }, repos).ok,
    true,
  );
});

test("each run a turn queues counts, so one turn cannot queue past the limit", () => {
  const last = { ...fresh, runCount: 28 };
  const once = apply(last, dispatch("TRIAGE"));
  assert.equal(once.runCount, 29);
  const twice = apply(once, dispatch("SPEC"));
  assert.equal(twice.runCount, 30);
  assert.equal(check(twice, dispatch("TRIAGE"), repos).ok, false);
});

test("retry is refused at the run limit", () => {
  const used = checkRetry({ ...fresh, runCount: 30 });
  assert.equal(used.ok, false);
  assert.match(used.ok ? "" : used.reason, /Raise the run limit/);
});

test("raise run limit adds one step and unblocks a run-stopped item", () => {
  const used = { ...fresh, status: "paused" as const, runCount: 30 };
  const raised = raiseRunLimit(used);
  assert.ok(raised.ok);
  assert.equal(raised.next.maxRuns, 30 + RUN_STEP);
  assert.equal(raised.unblocked, true);
  assert.equal(raised.next.status, "active");
  assert.equal(check(raised.next, dispatch("TRIAGE"), repos).ok, true);
  assert.equal(raiseRunLimit({ ...used, stage: "cancelled" }).ok, false);
});

test("one limit raised does not wake an item the other still holds", () => {
  const both = {
    ...fresh,
    status: "paused" as const,
    runCount: 30,
    costUsd: 10,
  };
  const runs = raiseRunLimit(both);
  assert.ok(runs.ok);
  assert.equal(runs.unblocked, false);
  assert.equal(runs.next.status, "paused");
  const budget = raiseBudget(both);
  assert.ok(budget.ok);
  assert.equal(budget.unblocked, false);
  assert.equal(budget.next.status, "paused");
  // With the budget raised, raising the run limit wakes it.
  const woken = raiseRunLimit(budget.next);
  assert.ok(woken.ok);
  assert.equal(woken.unblocked, true);
  assert.equal(woken.next.status, "active");
});

test("completion requires the PR to be merged", () => {
  const handed = apply(fresh, dispatch("IMPLEMENT"), {
    type: "handoff",
    prUrl: "https://github.com/o/r/pull/1",
    summary: "s",
  });
  assert.equal(handed.stage, "handoff");
  assert.equal(
    check(handed, { type: "complete_task", summary: "s" }, repos).ok,
    false,
  );
  const merged = { ...handed, prMerged: true };
  assert.equal(
    apply(merged, { type: "complete_task", summary: "s" }).stage,
    "complete",
  );
});

test("informational work without a PR can complete", () => {
  assert.equal(
    apply(fresh, { type: "complete_task", summary: "answered" }).status,
    "done",
  );
});

test("terminal items accept nothing", () => {
  const done = { ...fresh, stage: "complete" as const };
  assert.equal(
    check(done, { type: "post_update", message: "m" }, repos).ok,
    false,
  );
});

test("CI fixes before review use follow_up and consume the revision cap", () => {
  const failed = { ...fresh, ciFailed: true };
  assert.equal(check(failed, dispatch("IMPLEMENT"), repos).ok, false);
  const twice = apply(failed, followUp("IMPLEMENT"), followUp("IMPLEMENT"));
  assert.equal(twice.revisionCount, 2);
  assert.equal(check(twice, followUp("IMPLEMENT"), repos).ok, false);
});

test("retry spends budget but leaves the review and revision counts alone", () => {
  const failed = {
    ...fresh,
    stage: "building" as const,
    status: "waiting_human" as const,
    reviewCount: 1,
    revisionCount: 2,
    costUsd: 4,
  };
  const retry = checkRetry(failed);
  assert.ok(retry.ok);
  assert.deepEqual(retry.next, { ...failed, status: "active" });
});

test("retry is refused when the budget is spent or the item is closed", () => {
  const broke = checkRetry({ ...fresh, costUsd: 10 });
  assert.equal(broke.ok, false);
  assert.match(broke.ok ? "" : broke.reason, /Raise the budget/);
  assert.equal(checkRetry({ ...fresh, stage: "cancelled" }).ok, false);
});

test("raise budget adds one step and unblocks a budget-stopped item", () => {
  const blocked = { ...fresh, status: "waiting_human" as const, costUsd: 12 };
  const raised = raiseBudget(blocked);
  assert.ok(raised.ok);
  assert.equal(raised.next.budgetUsd, 10 + BUDGET_STEP_USD);
  assert.equal(raised.unblocked, true);
  assert.equal(raised.next.status, "active");
  assert.equal(check(raised.next, dispatch("TRIAGE"), repos).ok, true);
});

test("raise budget does not wake an item its budget was not stopping", () => {
  const roomy = raiseBudget({ ...fresh, status: "waiting_human", costUsd: 2 });
  assert.ok(roomy.ok);
  assert.equal(roomy.unblocked, false);
  assert.equal(roomy.next.status, "waiting_human");
  // Still short of the cap after one step: not unblocked either.
  const deep = raiseBudget({ ...fresh, costUsd: 25 });
  assert.ok(deep.ok);
  assert.equal(deep.unblocked, false);
  assert.equal(raiseBudget({ ...fresh, stage: "complete" }).ok, false);
});

test("a different PR starts unmerged; the same PR keeps its merge", () => {
  const merged = {
    ...apply(fresh, {
      type: "record_refs",
      prUrl: "https://github.com/o/r/pull/1",
    }),
    prMerged: true,
  };
  assert.equal(
    apply(merged, {
      type: "record_refs",
      prUrl: "https://github.com/o/r/pull/1",
    }).prMerged,
    true,
  );
  assert.equal(
    apply(merged, {
      type: "record_refs",
      prUrl: "https://github.com/o/r/pull/2",
    }).prMerged,
    false,
  );
  const next = apply(merged, {
    type: "handoff",
    prUrl: "https://github.com/o/r/pull/2",
    summary: "s",
  });
  assert.equal(next.prUrl, "https://github.com/o/r/pull/2");
  assert.equal(next.prMerged, false);
});

const drafting: PolicyState = { ...fresh, specState: "drafting" };
const urlActions = (url: string): [string, PolicyState, Action][] => [
  [
    "request_spec_approval",
    drafting,
    { type: "request_spec_approval", specPrUrl: url, summary: "s" },
  ],
  ["handoff", fresh, { type: "handoff", prUrl: url, summary: "s" }],
  ["record_refs prUrl", fresh, { type: "record_refs", prUrl: url }],
  ["record_refs issueUrl", fresh, { type: "record_refs", issueUrl: url }],
];

const pick = (list: [string, PolicyState, Action][], i: number): Action => {
  const entry = list[i];
  assert.ok(entry);
  return entry[2];
};

test("URLs of the factory's own repositories are accepted", () => {
  const accepted = [
    ...urlActions("https://github.com/o/r/pull/12").slice(0, 3),
    ...urlActions("https://github.com/o/r/issues/12").slice(3),
    // GitHub names are case-insensitive; a trailing slash is the same page.
    ...urlActions("https://github.com/O/R/pull/12/").slice(2, 3),
  ];
  for (const [name, state, action] of accepted)
    assert.equal(check(state, action, repos).ok, true, name);
});

for (const url of [
  "https://github.com/evil/r/pull/1", // other owner
  "https://github.com/o/other/pull/1", // other repository
  "https://github.com/o/r2/pull/1", // repository prefix
  "https://github.com/o/r/pull/1/../../../../evil/r/pull/1", // traversal
  "https://github.com/o/r/pull/../../evil/r/pull/1",
  "https://github.com/o/r/pull/%2e%2e/1",
  "https://github.com/o/r/pull/1?x=1",
  "https://github.com/o/r/pull/1#frag",
  "https://github.com/o/r/pull/1 ",
  "https://github.com/o/r/pull/1\n",
  "https://github.com/o/r/pull/-1",
  "https://github.com/o/r/pull/abc",
  "https://github.com/o/r/pull/",
  "https://github.com/o/r/commit/1",
  "https://github.com/o/r/pulls/1",
  "https://github.com/o/r/pull/1/files",
  "https://githuh.com/o/r/pull/1", // look-alike host
  "https://github.com.evil.com/o/r/pull/1",
  "https://github.com.evil/o/r/pull/1",
  "https://evil.com/github.com/o/r/pull/1",
  "https://evil.com/?u=https://github.com/o/r/pull/1",
  "https://github.com@evil.com/o/r/pull/1", // userinfo
  "https://o:r@github.com/o/r/pull/1",
  "https://evil.com@github.com/o/r/pull/1",
  "https://github.com:8443/o/r/pull/1",
  "https://GITHUB.com/o/r/pull/1", // host case is not canonical
  "http://github.com/o/r/pull/1",
  "git@github.com:o/r.git",
  "-https://github.com/o/r/pull/1", // leading dash
  "--output=/etc/passwd",
  "//github.com/o/r/pull/1",
  "github.com/o/r/pull/1",
  "https://example.com/o/r/pull/1",
  "p",
]) {
  test(`Policy refuses the Foreman URL ${JSON.stringify(url)}`, () => {
    for (const [name, state, action] of urlActions(url)) {
      const v = check(state, action, repos);
      assert.equal(v.ok, false, name);
      if (!v.ok) assert.match(v.reason, /not on one of this factory/, name);
    }
  });
}

test("an issue URL is not a pull request URL, and the reverse", () => {
  const issue = urlActions("https://github.com/o/r/issues/1");
  assert.equal(check(fresh, pick(issue, 1), repos).ok, false);
  const pull = urlActions("https://github.com/o/r/pull/1");
  assert.equal(check(fresh, pick(pull, 3), repos).ok, false);
});

test("a factory with no repositories accepts no Foreman URL", () => {
  const pull = urlActions("https://github.com/o/r/pull/1");
  assert.equal(check(fresh, pick(pull, 1), []).ok, false);
});

test("the foreman cannot dispatch or follow up a reflect agent", () => {
  assert.equal(check(fresh, dispatch("REFLECT"), repos).ok, false);
  assert.equal(check(fresh, followUp("REFLECT"), repos).ok, false);
});

test("a human_feedback follow-up answers PR feedback outside the revision cap, within the budget and run limit", () => {
  const humanFeedback = {
    ...followUp("IMPLEMENT"),
    humanFeedback: true,
  } as Action;
  // Handed off after review, with every revision used.
  const handedOff: PolicyState = {
    ...fresh,
    stage: "handoff",
    status: "waiting_human",
    reviewCount: 1,
    revisionCount: 2,
    prUrl: "https://github.com/o/r/pull/1",
    prFeedback: true,
  };
  assert.equal(check(handedOff, followUp("IMPLEMENT"), repos).ok, false);
  const accepted = check(handedOff, humanFeedback, repos);
  assert.ok(accepted.ok, accepted.ok ? "" : accepted.reason);
  assert.equal(accepted.next.revisionCount, 2);
  assert.equal(accepted.next.runCount, handedOff.runCount + 1);
  assert.equal(accepted.next.stage, "building");
  assert.equal(accepted.next.status, "active");
  // It answered the feedback: a second one waits for new feedback.
  assert.equal(accepted.next.prFeedback, false);
  const again = check(accepted.next, humanFeedback, repos);
  assert.equal(again.ok, false);
  assert.match(again.ok ? "" : again.reason, /No pull request feedback/);

  // Without an unanswered pr_feedback event it is refused.
  for (const prFeedback of [false, undefined]) {
    const refused = check({ ...handedOff, prFeedback }, humanFeedback, repos);
    assert.equal(refused.ok, false);
    assert.match(refused.ok ? "" : refused.reason, /No pull request feedback/);
  }
  // It goes to the implementation agent only.
  assert.equal(
    check(
      handedOff,
      { ...followUp("REVIEW"), humanFeedback: true } as Action,
      repos,
    ).ok,
    false,
  );
  // The budget and the run limit still apply.
  const broke = check(
    { ...handedOff, costUsd: 10, budgetUsd: 10 },
    humanFeedback,
    repos,
  );
  assert.equal(broke.ok, false);
  assert.match(broke.ok ? "" : broke.reason, /Budget cap reached/);
  const used = check({ ...handedOff, runCount: 30 }, humanFeedback, repos);
  assert.equal(used.ok, false);
  assert.match(used.ok ? "" : used.reason, /Run limit reached/);
  // A closed item takes no revision.
  assert.equal(
    check({ ...handedOff, stage: "complete" }, humanFeedback, repos).ok,
    false,
  );
});

test("recording the same PR in another spelling keeps its URL and merge state; a different PR starts unmerged", () => {
  const recorded = apply(fresh, {
    type: "record_refs",
    prUrl: "https://github.com/o/r/pull/1",
  });
  const merged = { ...recorded, prMerged: true };
  for (const spelling of [
    "https://github.com/o/r/pull/1/",
    "https://github.com/O/R/pull/1",
  ]) {
    const again = check(
      merged,
      { type: "record_refs", prUrl: spelling },
      repos,
    );
    assert.ok(again.ok, spelling);
    assert.equal(again.ok && again.next.prUrl, "https://github.com/o/r/pull/1");
    assert.equal(again.ok && again.next.prMerged, true, spelling);
  }
  const other = check(
    merged,
    { type: "record_refs", prUrl: "https://github.com/o/r/pull/2" },
    repos,
  );
  assert.equal(other.ok && other.next.prUrl, "https://github.com/o/r/pull/2");
  assert.equal(other.ok && other.next.prMerged, false);
});
