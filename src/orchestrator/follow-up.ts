// A human follow-up from the run page is the foreman's follow_up action: the
// same policy check, plus the preconditions the foreman's MCP tool enforces.
import type { Run, Store } from "../db.ts";
import {
  type AgentType,
  check,
  type Limits,
  type Verdict,
} from "../domain/policy.ts";
import { policyFor } from "./pull-request-gate.ts";

export function checkFollowUp(
  store: Store,
  run: Run,
  agentType: AgentType | undefined,
  limits: Limits,
): Verdict {
  const refuse = (reason: string): Verdict => ({ ok: false, reason });
  if (run.role !== "agent")
    return refuse(
      "Foreman turns cannot be followed up. Message the factory from the work item instead.",
    );
  if (!agentType)
    return refuse(
      `Agent "${run.agent}" is no longer in the factory definition.`,
    );
  // biome-ignore lint/style/noNonNullAssertion: A run always belongs to an existing work item.
  const item = store.item(run.item_id)!;
  const runs = store
    .runs(item.id)
    .filter((r) => r.role === "agent" && r.agent === run.agent);
  if (runs.some((r) => r.status === "queued"))
    return refuse(
      `A run of ${run.agent} is already queued. Wait for it to start.`,
    );
  if (!store.latestAgentSession(item.id, run.agent))
    return refuse(
      `${run.agent} has no session to continue yet. Try again once the run has started.`,
    );
  return check(
    policyFor(store, item),
    { type: "follow_up", agent: run.agent, agentType, message: "" },
    limits,
    // A follow-up names no URL.
    [],
  );
}
