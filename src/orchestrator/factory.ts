import { join } from "node:path";

import type { Config } from "../config.ts";
import type { FactoryRecord, ScheduledRun, Store, WorkItem } from "../db.ts";
import type { Definition, LoadResult } from "../definition/load.ts";
import type { Action } from "../domain/policy.ts";
import { scheduledWork } from "../intake/schedule.ts";
import type { RecordedAction } from "../mcp/types.ts";
import { checkAgentToken, type Gh, runGh } from "../runner/agent-token.ts";
import type { RepoProbe } from "../runner/repos.ts";
import { quietTelemetry, type Telemetry } from "../telemetry/metrics.ts";
import {
  DefinitionService,
  type DefinitionWrite,
} from "./definition-service.ts";
import { ActionApplier } from "./action-applier.ts";
import { AgentRunner } from "./agent-runner.ts";
import { ForemanRunner } from "./foreman-runner.ts";
import { HumanInput } from "./human-input.ts";
import { migrateOldLayout } from "./migrate-layout.ts";
import { failRun, RunControl, recoverOrphanedRuns } from "./run-support.ts";
import { Scheduler } from "./scheduler.ts";

export type { DefinitionWrite };

/**
 * What the factories of a FactoryRegistry share: the runs in flight, and the
 * one scheduler with its concurrency limit. Items are dispatched to their own
 * factory's orchestrator.
 */
export interface SharedRuntime {
  control: RunControl;
  scheduler: Scheduler;
  /** The orchestrator of the item's factory. */
  owner(itemId: number): Factory | undefined;
  /** The other factory whose applied definition claims the `owner/name` repository. */
  repoOwner(repo: string, claimant: Factory): Factory | undefined;
}

/**
 * The orchestrator's facade for web/ and intake/: one object that composes the
 * definition, scheduling, runner, action and human-input services. All durable
 * state lives in SQLite, so a restart resumes from pending events and queued runs.
 *
 * Standalone, it schedules every item itself. In a FactoryRegistry it is one
 * factory's orchestrator: it loads that factory's definition, creates work in
 * that factory, and shares the registry's scheduler; an operator action on an
 * item of another factory is passed to that factory's orchestrator.
 */
export class Factory {
  /** The applied definition, its edits, and its repository checks. */
  readonly definitions: DefinitionService;
  /** The aborts, operator stops and shutdown state of the runs in flight. */
  private readonly control: RunControl;
  private readonly foreman: ForemanRunner;
  private readonly agents: AgentRunner;
  private readonly actions: ActionApplier;
  private readonly scheduler: Scheduler;
  private readonly human: HumanInput;

  readonly store: Store;
  /** In a registry, definitionDir is this factory's definition directory. */
  readonly config: Config;
  /** The registered factory this orchestrator runs; none when standalone. */
  readonly record: FactoryRecord | undefined;
  private readonly runtime: SharedRuntime | undefined;
  /** Where the orchestrator and intake log and count; silent by default. */
  readonly telemetry: Telemetry;

  constructor(
    store: Store,
    config: Config,
    telemetry: Telemetry = quietTelemetry(),
    options: { record?: FactoryRecord; runtime?: SharedRuntime } = {},
  ) {
    this.store = store;
    this.config = config;
    this.telemetry = telemetry;
    this.record = options.record;
    this.runtime = options.runtime;
    this.control = options.runtime?.control ?? new RunControl();
    // A write reloads through Factory.reloadDefinition, so a replacement of it
    // (as the smoke server's fixture overrides) applies to saves too.
    this.definitions = new DefinitionService(
      store,
      config,
      () => this.reloadDefinition(),
      (repo) => this.runtime?.repoOwner(repo, this)?.record?.name,
      {
        managed: () => this.record?.definition_mode === "managed",
        failed: (error) =>
          telemetry.log.warn("definition.commit_failed", { error }),
      },
      {
        key: `reach:${options.record?.id ?? "default"}`,
        // Only beside a database that outlives a restart, where the copy is wanted.
        appliedDir:
          options.record && store.db.location() !== null
            ? join(config.dataDir, "applied", String(options.record.id))
            : undefined,
      },
    );
    // The runners read the definition through the Factory, so assigning
    // factory.definition (as tests do) applies to them.
    this.actions = new ActionApplier(
      store,
      config,
      () => this.def(),
      undefined,
      telemetry.log,
      this.control,
    );
    this.foreman = new ForemanRunner(
      store,
      config,
      this.control,
      {
        definition: () => this.def(),
        pause: (item, reason) => this.actions.pause(item, reason),
        slug: options.record?.slug,
      },
      telemetry,
    );
    this.agents = new AgentRunner(
      store,
      config,
      this.control,
      () => this.def(),
      telemetry,
      undefined,
      undefined,
      options.record?.slug,
    );
    // Work starts and re-pumps through the Factory, so replacing pump (as
    // tests and the smoke server do) applies to the scheduler and to input.
    this.scheduler =
      options.runtime?.scheduler ??
      new Scheduler(
        store,
        config,
        this.control,
        {
          ready: () => Boolean(this.definition),
          pump: () => this.pump(),
          foremanTurn: (itemId) => this.foremanTurn(itemId),
          agentRun: (run) => this.agentRun(run),
        },
        telemetry.log,
      );
    this.human = new HumanInput(
      store,
      config,
      this.control,
      this.actions,
      {
        definition: () => this.definition,
        pump: () => void this.pump(),
      },
      telemetry,
    );
  }

  /** The applied definition; undefined until a valid one loads. */
  get definition(): Definition | undefined {
    return this.definitions.definition;
  }
  set definition(definition: Definition | undefined) {
    this.definitions.definition = definition;
  }

  get definitionProblems(): DefinitionService["definitionProblems"] {
    return this.definitions.definitionProblems;
  }

  /** Clones or fetches one repository; replaced in tests to stay offline. */
  get probeRepository(): RepoProbe {
    return this.definitions.probeRepository;
  }
  set probeRepository(probe: RepoProbe) {
    this.definitions.probeRepository = probe;
  }

  // ---------- definition (delegated to DefinitionService) ----------

  /** Load the definition from disk without applying it. */
  validateDefinition(): Promise<LoadResult> {
    return this.definitions.validateDefinition();
  }

  saveAgent(
    ...args: Parameters<DefinitionService["saveAgent"]>
  ): Promise<DefinitionWrite> {
    return this.definitions.saveAgent(...args);
  }

  createAgent(
    ...args: Parameters<DefinitionService["createAgent"]>
  ): Promise<DefinitionWrite> {
    return this.definitions.createAgent(...args);
  }

  deleteAgent(
    ...args: Parameters<DefinitionService["deleteAgent"]>
  ): Promise<DefinitionWrite> {
    return this.definitions.deleteAgent(...args);
  }

  saveAutomation(
    ...args: Parameters<DefinitionService["saveAutomation"]>
  ): Promise<DefinitionWrite> {
    return this.definitions.saveAutomation(...args);
  }

  saveLearning(
    ...args: Parameters<DefinitionService["saveLearning"]>
  ): Promise<DefinitionWrite> {
    return this.definitions.saveLearning(...args);
  }

  /**
   * Run now: create the work item the automation's schedule would, with source
   * manual. Refused for a disabled automation, as New work refuses it, and for
   * an automation without a schedule: its event supplies the request, so the
   * operator starts it from New work instead.
   */
  runAutomation(
    name: string,
    requester: string,
    now = new Date(),
  ):
    | { ok: true; item: WorkItem }
    | { ok: false; code: "not_found" | "policy"; reason: string } {
    if (!this.definition)
      return {
        ok: false,
        code: "policy",
        reason: "No valid factory definition is loaded.",
      };
    const automation = this.definition.automations.find((a) => a.name === name);
    if (!automation)
      return { ok: false, code: "not_found", reason: "Automation not found" };
    if (!automation.frontmatter.enabled)
      return {
        ok: false,
        code: "policy",
        reason: `${name} is not an enabled automation.`,
      };
    const schedule = automation.frontmatter.triggers.find(
      (t) => t.provider === "schedule" && t.event === "cron_fired",
    )?.schedule;
    if (!schedule)
      return {
        ok: false,
        code: "policy",
        reason: `${name} has no schedule; start it from New work with its request.`,
      };
    return {
      ok: true,
      item: this.createWorkItem({
        ...scheduledWork(automation, schedule, now),
        requester,
        source: "manual",
        repo: null,
        automation: automation.name,
      }),
    };
  }

  reloadDefinition(): Promise<LoadResult> {
    return this.definitions.reloadDefinition();
  }

  /** Wider reach a reload waits on; see DefinitionService.pendingReach. */
  pendingReach(): string[] | null {
    return this.definitions.pendingReach();
  }

  approveReach(): Promise<LoadResult> | null {
    return this.definitions.approveReach();
  }

  rejectReach(): boolean {
    return this.definitions.rejectReach();
  }

  /** Runs `gh` for the agent token check; replaced in tests to stay offline. */
  agentTokenGh: Gh = runGh;

  /**
   * Clone or fetch every factory repository (see
   * DefinitionService.checkRepositories), then check that the factory's agent
   * token can push to them.
   */
  async checkRepositories(): Promise<void> {
    await this.definitions.checkRepositories();
    if (this.definition)
      await checkAgentToken(
        this.store,
        this.record?.slug,
        this.definition,
        this.agentTokenGh,
      ).catch((error) =>
        this.telemetry.log.warn("agent_token.check_failed", { error }),
      );
  }

  private def(): Definition {
    if (!this.definition)
      throw new Error("No valid factory definition is loaded.");
    return this.definition;
  }

  // ---------- lifecycle ----------

  /**
   * Load the definition and start scheduling. In a registry this only loads
   * the definition: the registry recovers orphaned runs and starts the
   * shared scheduler once for every factory.
   */
  async start(): Promise<void> {
    await this.reloadDefinition();
    if (this.runtime) return;
    await migrateOldLayout(
      this.store,
      this.config,
      () => this.definition,
      this.telemetry,
    );
    await recoverOrphanedRuns(this.store, this.telemetry, this.config);
    this.scheduler.start();
  }

  /**
   * Graceful shutdown: start no new foreman turn or agent run, and give the
   * ones in flight up to `ms` to finish. Whatever still runs then is
   * interrupted, and the next start resumes it. Resolves once nothing runs.
   */
  drain(ms: number): Promise<void> {
    return this.scheduler.drain(ms);
  }

  /** Interrupt every run in flight now; a second shutdown signal skips the rest of the drain. */
  interrupt(): void {
    this.scheduler.interrupt();
  }

  /** The number of foreman turns and agent runs in flight. */
  get inFlightCount(): number {
    return this.scheduler.inFlightCount;
  }

  /** Start whatever can start; see Scheduler.pump. Replaced in tests and the smoke server. */
  pump(): Promise<void> {
    return this.scheduler.pump();
  }

  // ---------- intake & human input ----------

  /** Create a work item in this factory (the first factory when standalone) and wake the foreman. */
  createWorkItem(input: Parameters<Store["createItem"]>[0]): WorkItem {
    const item = this.store.createItem({
      ...input,
      factoryId: input.factoryId ?? this.record?.id,
    });
    this.store.addEvent(item.id, "work_received", {
      automation: input.automation ?? undefined,
    });
    void this.pump();
    return item;
  }

  /** The orchestrator of the item's factory: this one, unless a registry owns the item elsewhere. */
  private owner(itemId: number | undefined): Factory {
    return (itemId !== undefined && this.runtime?.owner(itemId)) || this;
  }

  /** Approve or reject a spec, or answer a question; see HumanInput. */
  answerApproval(
    approvalId: number,
    decision: Parameters<HumanInput["answerApproval"]>[1],
  ): void {
    this.owner(this.store.approval(approvalId)?.item_id).human.answerApproval(
      approvalId,
      decision,
    );
  }

  sendMessage(itemId: number, message: string): void {
    this.owner(itemId).human.sendMessage(itemId, message);
  }

  followUp(runId: number, message: string) {
    return this.owner(this.store.runById(runId)?.item_id).human.followUp(
      runId,
      message,
    );
  }

  stopRun(runId: number) {
    return this.owner(this.store.runById(runId)?.item_id).human.stopRun(runId);
  }

  retry(itemId: number) {
    return this.owner(itemId).human.retry(itemId);
  }

  raiseBudget(itemId: number) {
    return this.owner(itemId).human.raiseBudget(itemId);
  }

  raiseRunLimit(itemId: number) {
    return this.owner(itemId).human.raiseRunLimit(itemId);
  }

  cancel(itemId: number): Promise<void> {
    return this.owner(itemId).human.cancel(itemId);
  }

  // ---------- foreman ----------

  /** Run one foreman turn for an item of this factory; the scheduler starts it. */
  async foremanTurn(itemId: number): Promise<void> {
    // A crash marks only these handled, so the turn is not retried in a loop.
    const eventIds = this.store.pendingEvents(itemId).map((e) => e.id);
    try {
      await this.foremanTurnOnce(itemId);
    } catch (error) {
      const message = this.failCrashed(itemId, "foreman", error);
      this.store.markEventsProcessed(eventIds);
      const item = this.store.item(itemId);
      if (item)
        this.actions.pause(
          item,
          `The foreman turn crashed: ${message}. Send a message to retry.`,
        );
    }
  }

  private async foremanTurnOnce(itemId: number): Promise<void> {
    const turn = await this.foreman.run(itemId);
    if (!turn) return;
    const accepted = await this.applyActions(itemId, turn.recorded);
    this.store.markEventsProcessed(turn.eventIds);

    // biome-ignore lint/style/noNonNullAssertion: Preserve the existing required-record assumption instead of silently skipping missing data.
    const fresh = this.store.item(itemId)!;
    if (turn.failure !== undefined)
      return this.actions.pause(
        fresh,
        `The foreman turn failed: ${turn.failure}. Send a message to retry.`,
      );
    this.checkStalled(fresh, accepted);
  }

  /** Re-check every action against the current state and apply it; see ActionApplier. */
  private applyActions(
    itemId: number,
    recorded: RecordedAction[],
  ): Promise<Action[]> {
    return this.actions.applyActions(itemId, recorded);
  }

  /** Nothing in motion and nobody asked: surface the item; see ActionApplier. */
  private checkStalled(item: WorkItem, applied: Action[]): void {
    this.actions.checkStalled(item, applied);
  }

  // ---------- agents ----------

  /** Run one queued agent run of an item of this factory; the scheduler starts it. */
  agentRun(scheduled: ScheduledRun): Promise<void> {
    return this.agents.run(scheduled).catch((error: unknown) => {
      this.failCrashed(scheduled.item_id, "agent", error, scheduled.id);
    });
  }

  /**
   * A run whose code threw would stay running and hold its slot, and the
   * rejection would end the process: fail it, tell the foreman, return why.
   */
  private failCrashed(
    itemId: number,
    role: "foreman" | "agent",
    error: unknown,
    runId?: number,
  ): string {
    const message = `Nakara error: ${String(error).slice(0, 1500)}`;
    this.telemetry.log.error("run.crashed", {
      item_id: itemId,
      run_id: runId,
      role,
      error,
    });
    const stuck = this.store
      .runs(itemId)
      .filter(
        (r) =>
          r.role === role &&
          (runId === undefined || r.id === runId) &&
          (r.status === "running" || r.status === "queued"),
      );
    for (const run of stuck) failRun(this.store, this.control, run, message);
    return message;
  }
}
