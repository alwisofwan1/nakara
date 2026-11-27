// Guardrails enforced in code, not in the foreman's prompt. The foreman (an LLM)
// chooses the route; this module decides whether a requested action is allowed
// and how it moves the work item. Pure: no I/O, so the MCP server and the
// orchestrator apply the exact same rules.

export const STAGES = [
  "intake",
  "triage",
  "planning",
  "building",
  "reviewing",
  "handoff",
  "complete",
  "cancelled",
] as const;
export type Stage = (typeof STAGES)[number];

export type SpecState = "none" | "drafting" | "awaiting_approval" | "approved";
export type ItemStatus = "active" | "waiting_human" | "paused" | "done";

/**
 * Whether a factory writes a Spec before code (ADR-0006 rule 3): always,
 * never, or when the Work Item asks for one, the Foreman deciding otherwise.
 */
export const SPEC_RULES = ["always", "when_asked", "never"] as const;
export type SpecRule = (typeof SPEC_RULES)[number];

/** Why a Work Item may not ask for a Spec: only `when_asked` lets it. */
export const specRequestRefused = (rule: SpecRule): string =>
  rule === "always"
    ? "This factory always writes a Spec first, so a Work Item does not ask for one."
    : "This factory does not write Specs, so a Work Item cannot ask for one.";

/** A Work Item asked for a Spec its factory's rule does not allow. */
export class SpecRequestRefused extends Error {
  readonly rule: SpecRule;
  constructor(rule: SpecRule) {
    super(specRequestRefused(rule));
    this.name = "SpecRequestRefused";
    this.rule = rule;
  }
}

/**
 * The checks a factory may add to its Handoff Gate (ADR-0006 rules 1 and 2):
 * an accepted Review, a passed Verification. The fixed part, the work pushed
 * to the Pull Request and its CI passing, is not among them: it cannot be
 * turned off.
 */
export const GATE_CHECKS = ["review", "verification"] as const;
export type GateCheck = (typeof GATE_CHECKS)[number];

/** How the Operator and the Foreman read each gate check. */
export const GATE_CHECK_LABEL: Record<GateCheck, string> = {
  review: "Review accepted",
  verification: "Verification passed",
};

/** The gate checks a Work Item snapshotted, parsed from its JSON column; unknown entries are dropped. */
export const parseGateChecks = (json: string): GateCheck[] => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? GATE_CHECKS.filter((check) => parsed.includes(check))
    : [];
};

/** Whether each of the item's gate checks is met by the evidence its runs left. */
export const gateCheckMet = (
  state: Pick<PolicyState, "reviewAccepted" | "verificationPassed">,
  check: GateCheck,
): boolean =>
  check === "review" ? state.reviewAccepted : state.verificationPassed;

/**
 * Whether an unmet gate check can no longer be met with the item's own limits
 * and the definition's agents: review cannot run again once the review limit
 * is used up, and no Verification runs without a verify agent. Only a human
 * moves such an item forward.
 */
export const gateCheckUnreachable = (
  state: Pick<PolicyState, "reviewCount" | "maxReviews" | "verifyAgent">,
  check: GateCheck,
): boolean =>
  check === "review"
    ? state.reviewCount >= state.maxReviews
    : state.verifyAgent === false;

/**
 * Why the checks the item's factory added to its Handoff Gate are not met;
 * null when they are (or it added none). A check that cannot be met any more
 * sends the Foreman to the human, not to an agent it may not dispatch: the
 * gate never lifts the review limit the item copied at creation.
 */
const gateCheckMissing = (state: PolicyState): string | null => {
  const missing = state.gateChecks.find((check) => !gateCheckMet(state, check));
  if (!missing) return null;
  if (gateCheckUnreachable(state, missing))
    return missing === "review"
      ? `This factory's Handoff Gate needs an accepted Review, but the latest review did not accept the change and the review limit (${state.reviewCount} of ${state.maxReviews}) is used up, so review cannot run again. Do not dispatch review: ask_human to review and merge the pull request themselves, or to cancel this Work Item. The item copied its review limit when it was created, so changing the factory's limit does not free it.`
      : "This factory's Handoff Gate needs a passed Verification, but the definition has no verify agent, so no Verification can run. Do not dispatch one: ask_human to add a VERIFY agent to the definition, or to review and merge the pull request themselves. Changing the factory's Handoff Gate only affects new Work Items, not this one.";
  return missing === "review"
    ? "This factory's Handoff Gate also needs an accepted Review. Dispatch review first."
    : "This factory's Handoff Gate also needs a passed Verification. Dispatch verification first.";
};

export const AGENT_TYPES = [
  "FOREMAN",
  "TRIAGE",
  "SPEC",
  "IMPLEMENT",
  "REVIEW",
  "VERIFY",
  "CUSTOM",
  // Started by Nakara after a correction (#162), never by the foreman.
  "REFLECT",
] as const;
export type AgentType = (typeof AGENT_TYPES)[number];

export interface PolicyState {
  stage: Stage;
  status: ItemStatus;
  specState: SpecState;
  reviewCount: number;
  revisionCount: number;
  costUsd: number;
  /** The work item's own budget cap, failed runs included. */
  budgetUsd: number;
  /** The runs the item started: foreman turns and agent runs, failed ones included. */
  runCount: number;
  /** The work item's own cap on runCount. */
  maxRuns: number;
  /** The work item's own cap on reviewCount. */
  maxReviews: number;
  /** The work item's own cap on revisionCount. */
  maxRevisions: number;
  /** The Spec rule the work item snapshotted from its factory. */
  specRule: SpecRule;
  /** Whether the work item asked for a Spec; only possible under `when_asked`. */
  specRequested: boolean;
  /**
   * Whether the factory's definition has a SPEC agent the Foreman may
   * dispatch. Absent counts as present: only the loaded definition can tell.
   */
  specAgent?: boolean;
  /**
   * Whether the factory's definition has a VERIFY agent the Foreman may
   * dispatch. Absent counts as present: only the loaded definition can tell.
   */
  verifyAgent?: boolean;
  /** The checks the work item's factory added to its Handoff Gate, snapshotted at creation. */
  gateChecks: readonly GateCheck[];
  /** Whether the item's latest REVIEW run reported the verdict accepted; filled by the caller. */
  reviewAccepted: boolean;
  /** Whether the item's latest VERIFY run succeeded; filled by the caller. */
  verificationPassed: boolean;
  prUrl: string | null;
  prMerged: boolean;
  ciFailed?: boolean;
  /**
   * The PR branch while a push-only follow_up is available: once, after a
   * handoff was refused because the work is not on the PR.
   */
  pushOnlyBranch?: string | null;
  /**
   * Whether the poller turned human feedback on the PR into a pr_feedback
   * event that no human_feedback follow_up has answered yet.
   */
  prFeedback?: boolean;
}

/** The review and revision caps a work item snapshotted from its factory. */
export type Limits = Pick<PolicyState, "maxReviews" | "maxRevisions">;

export type Action =
  | {
      type: "dispatch_agent";
      agent: string;
      agentType: AgentType;
      brief: string;
    }
  | {
      type: "follow_up";
      agent: string;
      agentType: AgentType;
      message: string;
      /** Only push the committed work; exempt from the revision cap once. */
      pushOnly?: boolean;
      /** Answers human feedback on the PR; exempt from the revision cap. */
      humanFeedback?: boolean;
    }
  | { type: "post_update"; message: string }
  | { type: "ask_human"; question: string; options?: string[] }
  | { type: "request_spec_approval"; specPrUrl: string; summary: string }
  | { type: "record_refs"; issueUrl?: string; prUrl?: string }
  | { type: "handoff"; prUrl: string; summary: string }
  | { type: "complete_task"; summary: string };

export type Verdict =
  | { ok: true; next: PolicyState }
  | { ok: false; reason: string };

const refuse = (reason: string): Verdict => ({ ok: false, reason });

// Agent types whose work changes code and therefore must wait for an approved spec.
const BUILDS_CODE: ReadonlySet<AgentType> = new Set(["IMPLEMENT", "CUSTOM"]);

/** Whether the work item must have an approved Spec before code is built. */
export const specRequired = (
  state: Pick<PolicyState, "specRule" | "specRequested">,
): boolean =>
  state.specRule === "always" ||
  (state.specRule === "when_asked" && state.specRequested);

/**
 * The refusal when a Spec is required but the definition has no spec agent.
 * The item copied its rule when it was created (ADR-0006), so changing the
 * factory's rule in Settings does not free it.
 */
const noSpecAgent = (rule: SpecRule): string =>
  `${rule === "always" ? "This factory writes a Spec first" : "This Work Item asked for a Spec first"}, but the definition has no spec agent, so no Spec can be written. Do not dispatch one: ask_human to add a SPEC agent to the definition, or to cancel this Work Item. Changing the factory's Spec rule only affects new Work Items, not this one.`;

/**
 * Why code cannot be built or handed off yet for want of the approved Spec the
 * item or its factory asks for; null when nothing is missing. Without a spec
 * agent the Foreman cannot write one, so it is told so plainly.
 */
const specMissing = (state: PolicyState): string | null => {
  if (!specRequired(state) || state.specState === "approved") return null;
  if (state.specAgent === false) return noSpecAgent(state.specRule);
  return "This factory writes a Spec first. Dispatch the spec agent.";
};

const specGate = (state: PolicyState): string | null => {
  if (state.specState === "drafting")
    return "A spec is being drafted. Call request_spec_approval with the spec PR, then wait for the human.";
  if (state.specState === "awaiting_approval")
    return "The spec is awaiting human approval. End your turn; you will be woken when the human decides.";
  return null;
};

/**
 * `repositories` are the `owner/name` repositories of the item's Factory: every
 * URL the Foreman names must point at one of them.
 */
export function check(
  state: PolicyState,
  action: Action,
  repositories: readonly string[],
): Verdict {
  if (state.stage === "complete" || state.stage === "cancelled")
    return refuse(
      `The work item is ${state.stage}; no further actions are accepted.`,
    );

  const spends =
    action.type === "dispatch_agent" || action.type === "follow_up";
  if (spends && budgetSpent(state))
    return refuse(
      `Budget cap reached ($${state.costUsd.toFixed(2)} of $${state.budgetUsd.toFixed(2)}, failed runs included). Tell the user the work waits until they press Raise budget on the work item, or cancel it.`,
    );
  if (spends && runsUsed(state))
    return refuse(
      `${runLimitReached(state)} Tell the user the work waits until they press Raise run limit on the work item, or cancel it.`,
    );

  const foreign = foreignUrl(action, repositories);
  if (foreign)
    return refuse(
      `${foreign.field} ${JSON.stringify(foreign.url.slice(0, 200))} is not on one of this factory's repositories (${repositories.join(", ")}). Use https://github.com/<repository>/${foreign.shape}/<number>.`,
    );

  switch (action.type) {
    case "dispatch_agent":
    case "follow_up": {
      const verdict = checkAgentWork(state, action);
      // The run it queues counts at once, so one turn cannot queue past the limit.
      return verdict.ok
        ? {
            ok: true,
            next: { ...verdict.next, runCount: state.runCount + 1 },
          }
        : verdict;
    }

    case "post_update":
      return { ok: true, next: state };

    case "ask_human":
      return { ok: true, next: { ...state, status: "waiting_human" } };

    case "request_spec_approval":
      if (state.specState !== "drafting")
        return refuse(
          "There is no spec draft to approve. Dispatch the spec agent first.",
        );
      if (!action.specPrUrl) return refuse("specPrUrl is required.");
      return {
        ok: true,
        next: {
          ...state,
          specState: "awaiting_approval",
          status: "waiting_human",
        },
      };

    case "record_refs":
      return {
        ok: true,
        next: action.prUrl ? withPr(state, action.prUrl) : state,
      };

    case "handoff": {
      const gate = specGate(state);
      if (gate) return refuse(gate);
      // Code built without the Spec the rule asks for is not handed off either.
      const missing = specMissing(state);
      if (missing) return refuse(missing);
      // The factory's own checks come on top of the fixed part (pushed + CI),
      // which the Pull Request gate evaluates whatever they are.
      const added = gateCheckMissing(state);
      if (added) return refuse(added);
      if (!action.prUrl)
        return refuse("handoff requires the pull request URL.");
      return {
        ok: true,
        next: {
          ...withPr(state, action.prUrl),
          stage: "handoff",
          status: "waiting_human",
        },
      };
    }

    case "complete_task":
      if (state.prUrl && !state.prMerged)
        return refuse(
          "The pull request is not merged. A human merges; completion follows the merge notification.",
        );
      return {
        ok: true,
        next: { ...state, stage: "complete", status: "done" },
      };
  }
}

const GITHUB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/(issues|pull)\/([1-9][0-9]{0,9})\/?$/;

/**
 * Whether `url` is exactly `https://github.com/<repository>/<kind>/<number>`
 * for one of the repositories. Matched whole, never by prefix or substring, so
 * userinfo, look-alike hosts, ports, queries and extra path never pass.
 * GitHub names are case-insensitive, so the repository compares that way.
 */
function onRepository(
  url: string,
  kinds: readonly string[],
  repositories: readonly string[],
): boolean {
  const m = GITHUB_URL.exec(url);
  if (!m || !kinds.includes(m[3] ?? "")) return false;
  const repo = `${m[1]}/${m[2]}`.toLowerCase();
  return repositories.some((r) => r.toLowerCase() === repo);
}

/** The first URL in the action that is not on the factory's repositories. */
function foreignUrl(
  action: Action,
  repositories: readonly string[],
): { field: string; url: string; shape: string } | null {
  const urls: { field: string; url?: string; kinds: string[] }[] = [];
  if (action.type === "request_spec_approval")
    urls.push({
      field: "specPrUrl",
      url: action.specPrUrl,
      kinds: ["pull", "issues"],
    });
  else if (action.type === "handoff")
    urls.push({ field: "prUrl", url: action.prUrl, kinds: ["pull"] });
  else if (action.type === "record_refs")
    urls.push(
      { field: "issueUrl", url: action.issueUrl, kinds: ["issues"] },
      { field: "prUrl", url: action.prUrl, kinds: ["pull"] },
    );
  // An empty URL is the existing required-field check's to refuse.
  for (const { field, url, kinds } of urls)
    if (url && !onRepository(url, kinds, repositories))
      return { field, url, shape: kinds.join("|") };
  return null;
}

/** A different PR starts unmerged; re-recording the same PR keeps its state. */
function withPr(state: PolicyState, prUrl: string): PolicyState {
  return prUrl === state.prUrl ? state : { ...state, prUrl, prMerged: false };
}

function checkAgentWork(
  state: PolicyState,
  action: Extract<Action, { type: "dispatch_agent" | "follow_up" }>,
): Verdict {
  const active = { ...state, status: "active" as const };
  const isFollowUp = action.type === "follow_up";

  // Pushing work already committed is not a revision, but it is offered only
  // once per refused handoff; after that a human decides.
  if (action.type === "follow_up" && action.pushOnly) {
    if (action.agentType !== "IMPLEMENT")
      return refuse("A push-only follow_up goes to the implementation agent.");
    if (!state.pushOnlyBranch)
      return refuse(
        "No push-only follow_up is available: Nakara offers one, once, after a handoff is refused because the work is not on the PR. Use a regular follow_up (it counts toward the revision cap) or ask_human.",
      );
    return {
      ok: true,
      next: { ...active, stage: "building", pushOnlyBranch: null },
    };
  }

  // Human feedback on the PR is not the agent-review loop the revision cap
  // limits; the budget and the run limit still apply (see check).
  if (action.type === "follow_up" && action.humanFeedback) {
    if (action.agentType !== "IMPLEMENT")
      return refuse(
        "A human_feedback follow_up goes to the implementation agent.",
      );
    if (!state.prFeedback)
      return refuse(
        "No pull request feedback is waiting for an answer: human_feedback is accepted only while a pr_feedback event is unanswered, and one human_feedback follow_up answers it. Use a regular follow_up (it counts toward the revision cap) or ask_human.",
      );
    return {
      ok: true,
      next: { ...active, stage: "building", prFeedback: false },
    };
  }

  switch (action.agentType) {
    case "FOREMAN":
      return refuse("The foreman cannot dispatch itself.");

    case "TRIAGE":
      return { ok: true, next: { ...active, stage: "triage" } };

    case "SPEC":
      if (state.specRule === "never")
        return refuse(
          "This factory does not write Specs. Dispatch implement directly.",
        );
      // A new draft or a revision after feedback both need a fresh approval.
      return {
        ok: true,
        next: { ...active, stage: "planning", specState: "drafting" },
      };

    case "REVIEW":
      // A re-review uses one review, dispatched or sent as a follow_up.
      if (state.reviewCount >= state.maxReviews)
        return refuse(
          `Review already ran ${state.reviewCount} time(s); the limit is ${state.maxReviews}. A re-review, dispatched or sent as a follow_up, uses one review. Hand the PR to the human.`,
        );
      if (!isFollowUp && !state.prUrl)
        return refuse(
          "Review needs a pull request. Record it with record_refs first.",
        );
      return {
        ok: true,
        next: {
          ...active,
          stage: "reviewing",
          reviewCount: state.reviewCount + 1,
        },
      };

    case "VERIFY":
      return { ok: true, next: active };

    case "REFLECT":
      return refuse(
        "Nakara starts reflect runs itself after a correction; the foreman does not dispatch them.",
      );

    case "IMPLEMENT":
    case "CUSTOM": {
      const gate = specGate(state);
      if (gate) return refuse(gate);
      // Code needs the approved Spec the item or its factory asks for.
      const missing = isFollowUp ? null : specMissing(state);
      if (missing) return refuse(missing);
      if (state.reviewCount === 0 && !state.ciFailed)
        return { ok: true, next: { ...active, stage: "building" } };
      if (!isFollowUp && BUILDS_CODE.has(action.agentType))
        return refuse(
          "Review findings and CI failures go back to the agent that built the change: use follow_up, not a new dispatch.",
        );
      if (state.revisionCount >= state.maxRevisions)
        return refuse(
          `Revision limit reached (${state.maxRevisions}). Ask the human how to proceed; failing CI still blocks handoff.`,
        );
      return {
        ok: true,
        next: {
          ...active,
          stage: "building",
          revisionCount: state.revisionCount + 1,
        },
      };
    }
  }
}

const budgetSpent = (state: PolicyState) => state.costUsd >= state.budgetUsd;
/** No run is left: neither a foreman turn nor an agent run may start. */
export const runsUsed = (state: Pick<PolicyState, "runCount" | "maxRuns">) =>
  state.runCount >= state.maxRuns;

/** Why the item stopped at its run limit, for the foreman and the operator. */
export const runLimitReached = (
  state: Pick<PolicyState, "runCount" | "maxRuns">,
) =>
  `Run limit reached (${state.runCount} of ${state.maxRuns} runs, foreman turns and failed runs included).`;

/** The run limit of a work item when NAKARA_MAX_RUNS is not set. */
export const DEFAULT_MAX_RUNS = 50;
/** The review limit of a work item when NAKARA_MAX_REVIEWS is not set. */
export const DEFAULT_MAX_REVIEWS = 1;
/** The revision limit of a work item when NAKARA_MAX_REVISIONS is not set. */
export const DEFAULT_MAX_REVISIONS = 2;
/** How many runs one Raise run limit adds to the work item's limit. */
export const RUN_STEP = 10;
const closed = (state: PolicyState) =>
  state.stage === "complete" || state.stage === "cancelled";

/** How much one Raise budget adds to the work item's budget. */
export const BUDGET_STEP_USD = 10;

/**
 * The operator retries a failed agent run. It spends budget but is not a
 * revision, so the review and revision counts stay as they are.
 */
export function checkRetry(state: PolicyState): Verdict {
  if (closed(state))
    return refuse(`The work item is ${state.stage}; it cannot be retried.`);
  if (budgetSpent(state))
    return refuse(
      `The budget is spent ($${state.costUsd.toFixed(2)} of $${state.budgetUsd.toFixed(2)}). Raise the budget before retrying.`,
    );
  if (runsUsed(state))
    return refuse(
      `${runLimitReached(state)} Raise the run limit before retrying.`,
    );
  return { ok: true, next: { ...state, status: "active" } };
}

/** The operator adds BUDGET_STEP_USD; `unblocked` says the item was stopped by its budget and no longer is. */
export function raiseBudget(
  state: PolicyState,
):
  | { ok: true; next: PolicyState; unblocked: boolean }
  | { ok: false; reason: string } {
  if (closed(state))
    return {
      ok: false,
      reason: `The work item is ${state.stage}; its budget is final.`,
    };
  const next = { ...state, budgetUsd: state.budgetUsd + BUDGET_STEP_USD };
  // Still held by its run limit, the item stays as it is.
  const unblocked =
    budgetSpent(state) && !budgetSpent(next) && !runsUsed(state);
  return {
    ok: true,
    next: unblocked ? { ...next, status: "active" } : next,
    unblocked,
  };
}

/** The operator adds RUN_STEP runs; `unblocked` says the item was stopped by its run limit and no longer is. */
export function raiseRunLimit(
  state: PolicyState,
):
  | { ok: true; next: PolicyState; unblocked: boolean }
  | { ok: false; reason: string } {
  if (closed(state))
    return {
      ok: false,
      reason: `The work item is ${state.stage}; its run limit is final.`,
    };
  const next = { ...state, maxRuns: state.maxRuns + RUN_STEP };
  // Still held by its budget, the item stays as it is.
  const unblocked = runsUsed(state) && !budgetSpent(state);
  return {
    ok: true,
    next: unblocked ? { ...next, status: "active" } : next,
    unblocked,
  };
}

/** A human decided on a spec in the inbox. */
export function decideSpec(state: PolicyState, approved: boolean): PolicyState {
  if (state.specState !== "awaiting_approval") return state;
  return approved
    ? { ...state, specState: "approved", status: "active" }
    : { ...state, specState: "drafting", status: "active" };
}

/**
 * The evidence for the Handoff Gate checks a factory can add, from the item's
 * runs in start order. Review accepted: the latest REVIEW run reported the
 * verdict accepted. Verification passed: the latest VERIFY run succeeded; a
 * verify run reports no pass/fail verdict of its own, so finishing without an
 * error is the only signal there is.
 */
export function gateEvidence(
  runs: readonly {
    role: string;
    agent_type: string;
    status: string;
    review_verdict: string | null;
  }[],
): Pick<PolicyState, "reviewAccepted" | "verificationPassed"> {
  const latest = (type: AgentType) =>
    runs.findLast((r) => r.role === "agent" && r.agent_type === type);
  return {
    reviewAccepted: latest("REVIEW")?.review_verdict === "accepted",
    verificationPassed: latest("VERIFY")?.status === "succeeded",
  };
}
