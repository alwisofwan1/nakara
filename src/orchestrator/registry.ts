import { resolve } from "node:path";

import type { Config } from "../config.ts";
import type { FactoryRecord, Store } from "../db.ts";
import { repoClaims } from "../definition/load.ts";
import { quietTelemetry, type Telemetry } from "../telemetry/metrics.ts";
import { Factory, type SharedRuntime } from "./factory.ts";
import { migrateOldLayout } from "./migrate-layout.ts";
import { RunControl, recoverOrphanedRuns } from "./run-support.ts";
import { Scheduler } from "./scheduler.ts";

/** The startup log and /healthz warning of FactoryRegistry.definitionDirMismatch(). */
export const definitionDirWarning = (mismatch: {
  configured: string;
  registered: string;
}) =>
  `NAKARA_DEFINITION_DIR (${mismatch.configured}) differs from the first factory's registered definition directory (${mismatch.registered}); the registry value is used.`;

/**
 * One Factory orchestrator per registered factory, each loading, validating
 * and reloading its own definition from its registry record's directory. The
 * store, the run queue with its concurrency limit, and the configured
 * defaults are shared: one scheduler starts the work of every factory, and
 * an item whose factory has no valid definition waits without holding up the
 * other factories.
 */
export class FactoryRegistry {
  readonly store: Store;
  readonly config: Config;
  readonly telemetry: Telemetry;
  private readonly control = new RunControl();
  private readonly scheduler: Scheduler;
  private readonly runtime: SharedRuntime;
  /** By slug, in registry order: the first is the default factory. */
  private readonly bySlug = new Map<string, Factory>();
  private readonly byId = new Map<number, Factory>();
  /** Item id → factory id; an item never changes factory. */
  private readonly itemFactory = new Map<number, number>();
  /** Factory ids without an orchestrator that were already logged. */
  private readonly unknownFactories = new Set<number>();
  /** Called with each factory registered after startup, once it has started. */
  private readonly added: ((factory: Factory) => void)[] = [];
  /** Called with each factory unregister() removes. */
  private readonly removed: ((factory: Factory) => void)[] = [];

  constructor(
    store: Store,
    config: Config,
    telemetry: Telemetry = quietTelemetry(),
  ) {
    this.store = store;
    this.config = config;
    this.telemetry = telemetry;
    this.scheduler = new Scheduler(
      store,
      config,
      this.control,
      {
        ready: (itemId) => Boolean(this.forItem(itemId)?.definition),
        pump: () => this.pump(),
        foremanTurn: (itemId) => this.dispatch(itemId).foremanTurn(itemId),
        agentRun: (run) => this.dispatch(run.item_id).agentRun(run),
      },
      telemetry.log,
    );
    this.runtime = {
      control: this.control,
      scheduler: this.scheduler,
      owner: (itemId) => this.forItem(itemId),
      repoOwner: (repo, claimant) => this.repoOwner(repo, claimant),
    };
    for (const record of store.repos.factories.factories()) this.add(record);
  }

  /** Create the orchestrator of a registered factory; it loads its definition on start(). */
  private add(record: FactoryRecord): Factory {
    const factory = new Factory(
      this.store,
      { ...this.config, definitionDir: resolve(record.definition_dir) },
      {
        ...this.telemetry,
        log: this.telemetry.log.child({ factory: record.slug }),
      },
      { record, runtime: this.runtime },
    );
    this.bySlug.set(record.slug, factory);
    this.byId.set(record.id, factory);
    return factory;
  }

  /** Every factory's orchestrator, the default first. */
  get factories(): Factory[] {
    return [...this.bySlug.values()];
  }

  /** The first factory: intake without a factory of its own creates work here. */
  get default(): Factory {
    // biome-ignore lint/style/noNonNullAssertion: Migration 005 seeds a factory.
    return this.factories[0]!;
  }

  /**
   * NAKARA_DEFINITION_DIR only names the first factory's directory when
   * migration 005 registers it; afterwards the registry's directory is used.
   * When the variable is set to another directory, returns both resolved paths;
   * otherwise undefined.
   */
  definitionDirMismatch():
    | { configured: string; registered: string }
    | undefined {
    if (!this.config.definitionDirSet) return undefined;
    const configured = this.config.definitionDir;
    const registered = resolve(
      this.store.repos.factories.defaultFactory().definition_dir,
    );
    return configured === registered ? undefined : { configured, registered };
  }

  get(slug: string): Factory | undefined {
    return this.bySlug.get(slug);
  }

  /**
   * The factory addressed by `@handle`: its foreman's handle, else its slug,
   * compared case-insensitively.
   */
  byHandle(handle: string): Factory | undefined {
    const wanted = handle.toLowerCase();
    const factories = this.factories;
    return (
      factories.find(
        (f) => f.record?.foreman_handle.toLowerCase() === wanted,
      ) ?? factories.find((f) => f.record?.slug.toLowerCase() === wanted)
    );
  }

  /**
   * Start the orchestrator of a factory registered while Nakara runs: it
   * loads its definition (a broken one records its errors, as at startup),
   * then the onAdded listeners start its intake.
   */
  async register(record: FactoryRecord): Promise<Factory> {
    const existing = this.bySlug.get(record.slug);
    if (existing) return existing;
    const factory = this.add(record);
    this.unknownFactories.delete(record.id);
    await factory.start();
    for (const listener of this.added) listener(factory);
    return factory;
  }

  /** Call `listener` with each factory register() starts, e.g. to poll its intake. */
  onAdded(listener: (factory: Factory) => void): void {
    this.added.push(listener);
  }

  /** Call `listener` with each factory unregister() removes, e.g. to stop its intake. */
  onRemoved(listener: (factory: Factory) => void): void {
    this.removed.push(listener);
  }

  /**
   * Stop running a deleted factory: it gets no new work, its repositories
   * are free to claim, and the onRemoved listeners stop its intake.
   */
  unregister(factory: Factory): void {
    const record = factory.record;
    if (!record || this.bySlug.get(record.slug) !== factory) return;
    this.bySlug.delete(record.slug);
    this.byId.delete(record.id);
    for (const [item, id] of this.itemFactory)
      if (id === record.id) this.itemFactory.delete(item);
    for (const listener of this.removed) listener(factory);
  }

  /** The factory whose applied definition claims the `owner/name` repository. */
  claimedBy(repo: string): Factory | undefined {
    return this.repoOwner(repo, undefined);
  }

  /**
   * The orchestrator of the item's factory; undefined for an unknown item, and
   * for a factory added to the database after startup other than through
   * register() (logged once), whose work waits for a restart.
   */
  forItem(itemId: number): Factory | undefined {
    let factoryId = this.itemFactory.get(itemId);
    if (factoryId === undefined) {
      factoryId = this.store.item(itemId)?.factory_id;
      if (factoryId === undefined) return undefined;
      this.itemFactory.set(itemId, factoryId);
    }
    const factory = this.byId.get(factoryId);
    if (!factory && !this.unknownFactories.has(factoryId)) {
      this.unknownFactories.add(factoryId);
      this.telemetry.log.warn("registry.unknown_factory", {
        factory_id: factoryId,
        item_id: itemId,
        message:
          "The item's factory has no orchestrator; its work waits until Nakara restarts.",
      });
    }
    return factory;
  }

  /**
   * The other factory whose applied definition claims the `owner/name`
   * repository (see repoClaims); GitHub names compare case-insensitively.
   * Ownership follows the running definitions: a repository whose owner has
   * no valid definition can be claimed by another factory.
   */
  private repoOwner(
    repo: string,
    claimant: Factory | undefined,
  ): Factory | undefined {
    const wanted = repo.toLowerCase();
    return this.factories.find(
      (factory) =>
        factory !== claimant &&
        factory.definition !== undefined &&
        repoClaims(factory.definition).some(
          (claim) => claim.repo.toLowerCase() === wanted,
        ),
    );
  }

  private dispatch(itemId: number): Factory {
    const factory = this.forItem(itemId);
    if (!factory) throw new Error(`Work item ${itemId} has no factory.`);
    return factory;
  }

  /**
   * Load every factory's definition, each on its own: a broken one records
   * its errors and the others load. They load in registry order, so of two
   * factories claiming a repository the earlier one owns it. Then recover
   * the runs of dead instances and start the shared scheduler.
   */
  async start(): Promise<void> {
    const mismatch = this.definitionDirMismatch();
    if (mismatch)
      this.telemetry.log.warn("startup.definition_dir_ignored", {
        ...mismatch,
        message: definitionDirWarning(mismatch),
      });
    for (const factory of this.factories)
      await factory
        .start()
        .catch((error: unknown) =>
          factory.telemetry.log.error("definition.load_failed", { error }),
        );
    await migrateOldLayout(
      this.store,
      this.config,
      (itemId) => this.forItem(itemId)?.definition,
      this.telemetry,
    );
    await recoverOrphanedRuns(this.store, this.telemetry, this.config);
    this.scheduler.start();
  }

  /** Start whatever can start, in every factory, within the shared concurrency limit. */
  pump(): Promise<void> {
    return this.scheduler.pump();
  }

  /** Graceful shutdown of every factory's runs; see Scheduler.drain. */
  drain(ms: number): Promise<void> {
    return this.scheduler.drain(ms);
  }

  /** Interrupt every run in flight now; a second shutdown signal skips the rest of the drain. */
  interrupt(): void {
    this.scheduler.interrupt();
  }

  /** The number of foreman turns and agent runs in flight across factories. */
  get inFlightCount(): number {
    return this.scheduler.inFlightCount;
  }

  /** Clone or fetch the repositories of every factory with a valid definition. */
  async checkRepositories(): Promise<void> {
    await Promise.all(this.factories.map((f) => f.checkRepositories()));
  }
}
