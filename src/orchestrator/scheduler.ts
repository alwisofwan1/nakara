import type { Config } from "../config.ts";
import type { Run, ScheduledRun, Store } from "../db.ts";
import { quietTelemetry, type Telemetry } from "../telemetry/metrics.ts";
import { failRun, pauseItem, type RunControl } from "./run-support.ts";

const MAX_FOREMAN_TURNS_IN_FLIGHT = 2;

/**
 * What the Scheduler starts work through: a standalone Factory routes each
 * through itself, a FactoryRegistry through the item's own factory.
 */
export interface SchedulerHooks {
  /** The item's factory has a valid definition loaded, so its work may start. */
  ready(itemId: number): boolean;
  /** Pump again: Factory.pump (which tests and the smoke server replace) or FactoryRegistry.pump. */
  pump(): Promise<void>;
  foremanTurn(itemId: number): Promise<void>;
  agentRun(run: ScheduledRun): Promise<void>;
}

/**
 * Decides what runs when: foreman turns for items with pending events and
 * queued agent runs within capacity, one turn per item and one run per agent
 * conversation; tracks them until they settle, and drains them on shutdown.
 * In a FactoryRegistry one Scheduler serves every factory, so the capacity is
 * shared, and an item whose factory has no valid definition waits.
 */
export class Scheduler {
  private readonly foremanInFlight = new Set<number>();
  private timer: NodeJS.Timeout | undefined;
  private pumping = false;
  /** Shutting down: pump() starts nothing new. */
  private draining = false;
  private readonly inFlight = new Set<Promise<void>>();

  private readonly store: Store;
  private readonly config: Config;
  private readonly control: RunControl;
  private readonly hooks: SchedulerHooks;
  private readonly log: Telemetry["log"];

  constructor(
    store: Store,
    config: Config,
    control: RunControl,
    hooks: SchedulerHooks,
    log: Telemetry["log"] = quietTelemetry().log,
  ) {
    this.store = store;
    this.config = config;
    this.control = control;
    this.hooks = hooks;
    this.log = log;
  }

  /** Pump now and then every pumpSeconds; pump() runs after every state change, so the interval is only a safety net. */
  start(): void {
    this.timer = setInterval(
      () => this.repump(),
      this.config.pumpSeconds * 1000,
    );
    this.repump();
  }

  /** Pump through the hook; a failing pump is logged, never an unhandled rejection that ends the process. */
  private repump(): void {
    (async () => this.hooks.pump())().catch((error: unknown) =>
      this.log.error("scheduler.pump_failed", { error }),
    );
  }

  /**
   * Graceful shutdown: start no new foreman turn or agent run, and give the
   * ones in flight up to `ms` to finish. Whatever still runs then is
   * interrupted, and the next start resumes it. Resolves once nothing runs.
   */
  async drain(ms: number): Promise<void> {
    this.draining = true;
    clearInterval(this.timer);
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<true>((resolve) => {
      timer = setTimeout(() => resolve(true), ms);
    });
    const done = await Promise.race([this.settled(), timedOut]);
    clearTimeout(timer);
    if (done === true) this.interrupt();
    await this.settled();
  }

  /** Interrupt every run in flight now; a second shutdown signal skips the rest of the drain. */
  interrupt(): void {
    this.draining = true;
    this.control.interrupting = true;
    clearInterval(this.timer);
    for (const c of this.control.controllers.values()) c.abort();
  }

  /** The number of foreman turns and agent runs in flight. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  private async settled(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  /**
   * Start `work` and track it until it settles. It never rejects: a throw, sync
   * or async, is logged, and its run is failed or its item paused, so one bad
   * item cannot end the process. Resolves true when the work ended without a
   * failure or the failure was recorded; false when recording it failed too.
   */
  private launch(
    work: () => Promise<void>,
    itemId: number,
    runId?: number,
  ): Promise<boolean> {
    // A turn handles the events pending when it starts; later ones are not its to drop.
    const eventIds =
      runId === undefined
        ? this.store.pendingEvents(itemId).map((e) => e.id)
        : [];
    // The async wrapper turns a synchronous throw into a rejection.
    const settled = (async () => work())().then(
      () => true,
      (error: unknown) => this.crashed(error, itemId, runId, eventIds),
    );
    const tracked = settled.then(() => {});
    this.inFlight.add(tracked);
    return settled.finally(() => this.inFlight.delete(tracked));
  }

  /**
   * The hook threw before its own handling could record it (the item has no
   * factory, or the database was busy there). Fail what is still running for
   * it, drop the events the turn was handling so the next pump does not retry
   * the same turn, and pause the item. Never throws.
   */
  private crashed(
    error: unknown,
    itemId: number,
    runId: number | undefined,
    eventIds: number[],
  ): boolean {
    try {
      this.log.error("scheduler.track_failed", {
        item_id: itemId,
        run_id: runId,
        error,
      });
      const message = `Nakara error: ${String(error).slice(0, 1500)}`;
      const stuck = this.store
        .runs(itemId)
        .filter(
          (r) =>
            (runId === undefined ? r.role === "foreman" : r.id === runId) &&
            (r.status === "running" || r.status === "queued"),
        );
      for (const run of stuck) failRun(this.store, this.control, run, message);
      this.store.markEventsProcessed(eventIds);
      pauseItem(
        this.store,
        this.log,
        itemId,
        `${message}. Send a message to retry.`,
      );
      return true;
    } catch (inner) {
      try {
        this.log.error("scheduler.recover_failed", {
          item_id: itemId,
          run_id: runId,
          error: inner,
        });
      } catch {
        // Logging itself failed; there is nowhere left to report to.
      }
      return false;
    }
  }

  /** Start whatever can start: foreman turns for items with pending events, then queued agent runs. */
  async pump(): Promise<void> {
    if (this.pumping || this.draining) return;
    this.pumping = true;
    try {
      for (const itemId of this.store.itemsWithPendingEvents()) {
        if (this.foremanInFlight.size >= MAX_FOREMAN_TURNS_IN_FLIGHT) break;
        if (this.foremanInFlight.has(itemId) || !this.hooks.ready(itemId))
          continue;
        this.foremanInFlight.add(itemId);
        void this.launch(() => this.hooks.foremanTurn(itemId), itemId).then(
          (recorded) => {
            this.foremanInFlight.delete(itemId);
            // After a failure that could not be recorded the events stay pending: leave the retry to the interval, not a hot loop.
            if (recorded) this.repump();
          },
        );
      }
      const running = this.store
        .runningRuns()
        .filter((r) => r.role === "agent");
      const busy = new Set(running.map(conversation));
      let capacity = this.config.concurrency - running.length;
      for (const queued of this.store.queuedRuns()) {
        if (capacity <= 0) break;
        if (!this.hooks.ready(queued.item_id)) continue;
        // A follow-up continues a conversation, so it waits for that agent's current run to end.
        if (queued.session_id && busy.has(conversation(queued))) continue;
        busy.add(conversation(queued));
        capacity--;
        void this.launch(
          () => this.hooks.agentRun(queued),
          queued.item_id,
          queued.id,
        ).then((recorded) => {
          if (recorded) this.repump();
        });
      }
    } finally {
      this.pumping = false;
    }
  }
}

const conversation = (run: Pick<Run, "item_id" | "agent">) =>
  `${run.item_id}:${run.agent}`;
