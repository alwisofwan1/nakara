import type { Config } from "../config.ts";
import { policyState, type Run, type Store, type WorkItem } from "../db.ts";
import type { Definition } from "../definition/load.ts";
import {
  checkRetry,
  decideSpec,
  raiseBudget,
  raiseRunLimit,
} from "../domain/policy.ts";
import { removeWorkspace } from "../runner/workspace.ts";
import type { ActionApplier } from "./action-applier.ts";
import { checkFollowUp } from "./follow-up.ts";
import { quietTelemetry, type Telemetry } from "../telemetry/metrics.ts";
import {
  type RunControl,
  recordRunEnd,
  reportStopped,
  STOPPED,
  stopItemRuns,
} from "./run-support.ts";

/**
 * Applies what the operator does to work items and runs: approvals, messages,
 * follow-ups, stops, retries, budget raises and cancellation.
 */
export class HumanInput {
  private readonly store: Store;
  private readonly config: Config;
  private readonly control: RunControl;
  private readonly actions: ActionApplier;
  /** The applied definition, if one is loaded. */
  private readonly definition: () => Definition | undefined;
  /** Start what the change allows; Factory.pump, which tests replace. */
  private readonly pump: () => void;
  private readonly telemetry: Telemetry;

  constructor(
    store: Store,
    config: Config,
    control: RunControl,
    actions: ActionApplier,
    hooks: {
      definition: () => Definition | undefined;
      pump: () => void;
    },
    telemetry: Telemetry = quietTelemetry(),
  ) {
    this.store = store;
    this.config = config;
    this.control = control;
    this.actions = actions;
    this.definition = hooks.definition;
    this.pump = hooks.pump;
    this.telemetry = telemetry;
  }

  /** Approve or reject a spec, or answer a question, and wake the foreman. */
  answerApproval(
    approvalId: number,
    decision: { approved?: boolean; answer: string },
  ): void {
    const approval = this.store.approval(approvalId);
    if (approval?.status !== "pending")
      throw new Error("This request is no longer pending.");
    // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
    const item = this.store.item(approval.item_id)!;
    if (item.stage === "complete" || item.stage === "cancelled")
      throw new Error("The work item is closed.");
    this.store.transaction(() => {
      if (approval.kind === "spec") {
        const approved = decision.approved === true;
        this.store.resolveApproval(
          approvalId,
          approved ? "approved" : "rejected",
          decision.answer || null,
        );
        this.store.applyPolicyState(
          item.id,
          decideSpec(policyState(item), approved),
        );
        this.store.addEvent(item.id, "human_reply", {
          kind: "spec",
          approved: String(approved),
          refUrl: approval.ref_url ?? undefined,
          answer: decision.answer || undefined,
        });
      } else {
        this.store.resolveApproval(approvalId, "answered", decision.answer);
        this.store.updateItem(item.id, { status: "active" });
        this.store.addEvent(item.id, "human_reply", {
          kind: "question",
          prompt: approval.prompt,
          answer: decision.answer,
        });
      }
      this.store.addMessage(
        item.id,
        "human",
        decision.answer ||
          (decision.approved ? "Approved." : "Changes requested."),
      );
    });
    this.pump();
  }

  /** Add the operator's message to the conversation and wake the foreman. */
  sendMessage(itemId: number, message: string): void {
    const item = this.store.item(itemId);
    if (!item || item.stage === "complete" || item.stage === "cancelled")
      throw new Error("The work item is closed.");
    this.store.transaction(() => {
      this.store.addMessage(itemId, "human", message);
      if (item.status === "paused" || item.status === "waiting_human")
        this.store.updateItem(itemId, { status: "active" });
      this.store.addEvent(itemId, "human_message", { message });
    });
    this.pump();
  }

  /** Queue a human follow-up into an agent run's session through the foreman's follow_up path. */
  followUp(
    runId: number,
    message: string,
  ):
    | { ok: true; run: Run }
    | { ok: false; code: "not_found" | "policy"; reason: string } {
    const run = this.store.runById(runId);
    if (!run) return { ok: false, code: "not_found", reason: "Run not found." };
    const agent = this.definition()?.agents.get(run.agent);
    const verdict = checkFollowUp(this.store, run, agent?.type);
    if (!verdict.ok || !agent)
      return {
        ok: false,
        code: "policy",
        reason: verdict.ok
          ? "No valid factory definition is loaded."
          : verdict.reason,
      };
    // biome-ignore lint/style/noNonNullAssertion: A run always belongs to an existing work item.
    const item = this.store.item(run.item_id)!;
    const queued = this.store.transaction(() => {
      this.store.applyPolicyState(item.id, verdict.next);
      this.actions.effect(item, {
        type: "follow_up",
        agent: agent.name,
        agentType: agent.type,
        message,
      });
      this.store.addMessage(
        item.id,
        "human",
        `Follow-up to ${agent.name}:\n\n${message}`,
      );
      // biome-ignore lint/style/noNonNullAssertion: effect() just created the run.
      return this.store.runs(item.id).at(-1)!;
    });
    this.pump();
    return { ok: true, run: queued };
  }

  /** Stop one running run without cancelling its item; the foreman hears about it. */
  stopRun(
    runId: number,
  ):
    | { ok: true; run: Run }
    | { ok: false; code: "not_found" | "policy"; reason: string } {
    const run = this.store.runById(runId);
    if (!run) return { ok: false, code: "not_found", reason: "Run not found." };
    if (run.status !== "running")
      return {
        ok: false,
        code: "policy",
        reason: `Only a running run can be stopped. This run is ${run.status}.`,
      };
    const controller = this.control.controllers.get(runId);
    if (controller) {
      this.control.stopped.add(runId);
      controller.abort();
    } else {
      // No process of this Nakara runs it, so there is nothing to kill.
      this.store.transaction(() => {
        this.store.finishRun(run.id, {
          status: "cancelled",
          result: run.result,
          error: STOPPED,
          cost_usd: run.cost_usd,
          num_turns: run.num_turns,
          duration_ms: Date.now() - Date.parse(run.started_at),
          session_id: run.session_id,
          log_path: run.log_path,
        });
        reportStopped(this.store, run);
      });
      recordRunEnd(
        this.telemetry,
        this.telemetry.log.child({
          item_id: run.item_id,
          run_id: run.id,
          agent: run.agent,
        }),
        run,
        { status: "cancelled", stopped: true, costUsd: 0, error: STOPPED },
      );
    }
    this.pump();
    return { ok: true, run };
  }

  /** Re-run the last failed agent run in its session; it spends budget but is not a revision. */
  retry(
    itemId: number,
  ):
    | { ok: true; run: Run }
    | { ok: false; code: "not_found" | "policy"; reason: string } {
    const item = this.store.item(itemId);
    if (!item)
      return { ok: false, code: "not_found", reason: "Work item not found." };
    const runs = this.store.runs(itemId);
    const last = runs.findLast((r) => r.role === "agent");
    const refuse = (reason: string) =>
      ({ ok: false, code: "policy", reason }) as const;
    if (runs.some((r) => r.status === "queued" || r.status === "running"))
      return refuse("A run is already in progress. Wait for it to finish.");
    if (last?.status !== "failed")
      return refuse("Only a failed agent run can be retried.");
    const agent = this.definition()?.agents.get(last.agent);
    if (!agent)
      return refuse(
        `Agent "${last.agent}" is no longer in the factory definition.`,
      );
    const verdict = checkRetry(policyState(item));
    if (!verdict.ok) return refuse(verdict.reason);
    const session = this.store.latestAgentSession(itemId, agent.name);
    const queued = this.store.transaction(() => {
      this.store.applyPolicyState(itemId, verdict.next);
      this.store.addMessage(
        itemId,
        "human",
        `Retry of ${agent.name} (run #${last.id}).`,
      );
      return this.store.createRun({
        item_id: itemId,
        role: "agent",
        agent: agent.name,
        agent_type: agent.type,
        harness: agent.harness.kind,
        model: agent.harness.model ?? null,
        session_id: session ?? null,
        status: "queued",
        input: session
          ? `Your previous run failed${last.error ? `: ${last.error}` : ""}. Continue the task where you left off.\n\nThe task was:\n\n${last.input}`
          : last.input,
      });
    });
    this.pump();
    return { ok: true, run: queued };
  }

  /** Add one budget step; an item its budget had stopped wakes the foreman. */
  raiseBudget(
    itemId: number,
  ):
    | { ok: true; item: WorkItem }
    | { ok: false; code: "not_found" | "policy"; reason: string } {
    const item = this.store.item(itemId);
    if (!item)
      return { ok: false, code: "not_found", reason: "Work item not found." };
    const raised = raiseBudget(policyState(item));
    if (!raised.ok) return { ok: false, code: "policy", reason: raised.reason };
    const budgetUsd = raised.next.budgetUsd;
    this.store.transaction(() => {
      this.store.updateItem(itemId, {
        budget_usd: budgetUsd,
        status: raised.next.status,
      });
      this.store.addMessage(
        itemId,
        "human",
        `Raised the budget to $${budgetUsd.toFixed(2)}.`,
      );
      if (raised.unblocked)
        this.store.addEvent(itemId, "budget_raised", {
          budgetUsd: budgetUsd.toFixed(2),
          costUsd: item.cost_usd.toFixed(2),
        });
    });
    this.pump();
    // biome-ignore lint/style/noNonNullAssertion: The item was read above.
    return { ok: true, item: this.store.item(itemId)! };
  }

  /** Add RUN_STEP runs to the item's limit; an item its run limit had stopped wakes the foreman. */
  raiseRunLimit(
    itemId: number,
  ):
    | { ok: true; item: WorkItem }
    | { ok: false; code: "not_found" | "policy"; reason: string } {
    const item = this.store.item(itemId);
    if (!item)
      return { ok: false, code: "not_found", reason: "Work item not found." };
    const raised = raiseRunLimit(policyState(item));
    if (!raised.ok) return { ok: false, code: "policy", reason: raised.reason };
    const maxRuns = raised.next.maxRuns;
    this.store.transaction(() => {
      this.store.updateItem(itemId, {
        max_runs: maxRuns,
        status: raised.next.status,
      });
      this.store.addMessage(
        itemId,
        "human",
        `Raised the run limit to ${maxRuns} runs.`,
      );
      if (raised.unblocked)
        this.store.addEvent(itemId, "run_limit_raised", {
          maxRuns: String(maxRuns),
          runCount: String(item.run_count),
        });
    });
    this.pump();
    // biome-ignore lint/style/noNonNullAssertion: The item was read above.
    return { ok: true, item: this.store.item(itemId)! };
  }

  /** Cancel the work item: its queued and running runs, pending events and workspace. */
  async cancel(itemId: number): Promise<void> {
    stopItemRuns(this.store, this.control, itemId);
    this.store.updateItem(itemId, { stage: "cancelled", status: "done" });
    this.store.addMessage(itemId, "factory", "Cancelled by the operator.");
    this.store.markEventsProcessed(
      this.store.pendingEvents(itemId).map((e) => e.id),
    );
    await removeWorkspace(itemId, this.config);
  }
}
