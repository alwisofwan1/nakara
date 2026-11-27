import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  DEFAULT_MAX_REVIEWS,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_MAX_RUNS,
  type PolicyState,
} from "./domain/policy.ts";
import { ApprovalRepository } from "./db/approvals.ts";
import { EventRepository } from "./db/events.ts";
import { EvidenceRepository } from "./db/evidence.ts";
import { FactoryRepository, type FactorySeed } from "./db/factories.ts";
import { FactorySettingsRepository } from "./db/factory-settings.ts";
import {
  INSTANCE_KEY,
  type Instance,
  lockDatabase,
  newInstance,
  unlockDatabase,
} from "./db/instance.ts";
import { ItemRepository, policyState, type WorkItem } from "./db/items.ts";
import { KvRepository } from "./db/kv.ts";
import { LearningRepository } from "./db/learnings.ts";
import { MessageRepository } from "./db/messages.ts";
import { migrate } from "./db/migrate.ts";
import { type ChangeEvent, type NeedsYou, Notifier } from "./db/notifier.ts";
import { transaction } from "./db/repository.ts";
import { RunRepository } from "./db/runs.ts";

export type { Approval } from "./db/approvals.ts";
export type { Learning } from "./db/learnings.ts";
export type { EventKind, ItemEvent } from "./db/events.ts";
export type { Evidence } from "./db/evidence.ts";
export type {
  FactoryLimitSettings,
  FactoryLimits,
  LimitsEdit,
} from "./db/factory-settings.ts";
export type {
  DefinitionMode,
  FactoryRecord,
  FactorySeed,
} from "./db/factories.ts";
export { policyState, type WorkItem } from "./db/items.ts";

export type { Message } from "./db/messages.ts";
export type { ChangeEvent, ChangeType, NeedsYou } from "./db/notifier.ts";
export {
  RESUME_INPUT,
  type Run,
  type RunStatus,
  type ScheduledRun,
} from "./db/runs.ts";

/** The repositories of one database, sharing its connection and notifier. */
export interface Repositories {
  factories: FactoryRepository;
  factorySettings: FactorySettingsRepository;
  items: ItemRepository;
  events: EventRepository;
  runs: RunRepository;
  messages: MessageRepository;
  approvals: ApprovalRepository;
  evidence: EvidenceRepository;
  learnings: LearningRepository;
  kv: KvRepository;
}

/** The first factory of an in-memory database; databases on disk need a seed from the definition. */
const MEMORY_FACTORY: FactorySeed = {
  slug: "default",
  name: "Default",
  description: "",
  avatar_color: "#6366f1",
  foreman_handle: "foreman",
  definition_dir: "factory",
  definition_mode: "repo",
};

/** A stub seed for databases on disk in tests and tools; Nakara itself seeds from the definition. */
export const stubFactorySeed = (): FactorySeed => MEMORY_FACTORY;

/** Opens, locks, and migrates the database, and fronts its repositories. */
export class Store {
  readonly db: DatabaseSync;
  /** The budget of items created without one, and of items that predate per-item budgets. */
  readonly defaultBudgetUsd: number;
  /** The run limit of new items, and of items that predate per-item run limits. */
  readonly defaultMaxRuns: number;
  /** The review limit of new items in a factory without its own, and of items that predate per-item review limits. */
  readonly defaultMaxReviews: number;
  /** The revision limit of new items in a factory without its own, and of items that predate per-item revision limits. */
  readonly defaultMaxRevisions: number;
  /** `PRAGMA user_version` after migrating. */
  readonly schemaVersion: number;
  /** This process; the runs it starts carry its id. */
  readonly instance: Instance = newInstance();
  /** Holds the database's exclusive lock until close; none for `:memory:`. */
  private readonly lock: DatabaseSync | undefined;
  private readonly notifier = new Notifier();
  readonly changes = this.notifier.changes;
  /** Work Items that need the Operator, for the Slack bridge's notifications. */
  readonly attention = this.notifier.attention;
  readonly repos: Repositories;

  /** Tell live clients that a resource changed. */
  notify(event: ChangeEvent): void {
    this.notifier.notify(event);
  }

  /** Tell the Operator's channels that a Work Item needs them; never throws. */
  needsYou(event: NeedsYou): void {
    this.notifier.needsYou(event);
  }

  /**
   * Takes the database's exclusive lock, failing at once when another Nakara
   * holds it (see db/instance.ts), then migrates the database to the latest
   * schema; with `backup`, an existing database is snapshotted before a
   * pending migration runs. close() releases the lock.
   */
  constructor(
    path: string,
    options: {
      defaultBudgetUsd: number;
      /** The run limit of new items and of items that predate run limits; DEFAULT_MAX_RUNS when omitted. */
      defaultMaxRuns?: number;
      /** The default review limit; DEFAULT_MAX_REVIEWS when omitted. */
      defaultMaxReviews?: number;
      /** The default revision limit; DEFAULT_MAX_REVISIONS when omitted. */
      defaultMaxRevisions?: number;
      backup?: { dir: string; keep: number };
      /** The database's lock, already taken with lockDatabase(); close() releases it. */
      lock?: DatabaseSync;
      /**
       * Names the first factory when migration 005 runs (see
       * definition/seed.ts); it may throw to refuse the migration. Without it,
       * an in-memory database gets a stub factory and a file cannot migrate.
       */
      factory?: () => FactorySeed;
    },
  ) {
    if (!(options.defaultBudgetUsd > 0))
      throw new Error("The default budget must be a positive number.");
    this.defaultBudgetUsd = options.defaultBudgetUsd;
    this.defaultMaxRuns = options.defaultMaxRuns ?? DEFAULT_MAX_RUNS;
    if (!(Number.isInteger(this.defaultMaxRuns) && this.defaultMaxRuns > 0))
      throw new Error("The default run limit must be a positive integer.");
    this.defaultMaxReviews = options.defaultMaxReviews ?? DEFAULT_MAX_REVIEWS;
    this.defaultMaxRevisions =
      options.defaultMaxRevisions ?? DEFAULT_MAX_REVISIONS;
    const memory = path === ":memory:";
    if (!memory) mkdirSync(dirname(path), { recursive: true });
    this.lock = memory ? undefined : (options.lock ?? lockDatabase(path));
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      this.db = db;
      this.db.exec(
        "PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;",
      );
      this.schemaVersion = migrate(this.db, {
        defaultBudgetUsd: this.defaultBudgetUsd,
        defaultMaxRuns: this.defaultMaxRuns,
        defaultMaxReviews: this.defaultMaxReviews,
        defaultMaxRevisions: this.defaultMaxRevisions,
        backup: options.backup,
        factory: options.factory ?? (memory ? () => MEMORY_FACTORY : undefined),
      });
      // Not setKv: recording the holder is no change for live clients.
      this.db
        .prepare(
          "INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .run(INSTANCE_KEY, JSON.stringify(this.instance));
    } catch (error) {
      if (db?.isOpen) db.close();
      if (this.lock) unlockDatabase(this.lock);
      throw error;
    }
    const factorySettings = new FactorySettingsRepository(db, this.notifier, {
      budgetUsd: this.defaultBudgetUsd,
      maxReviews: this.defaultMaxReviews,
      maxRevisions: this.defaultMaxRevisions,
      maxRuns: this.defaultMaxRuns,
    });
    const items = new ItemRepository(db, this.notifier, factorySettings);
    this.repos = {
      factories: new FactoryRepository(db, this.notifier),
      factorySettings,
      items,
      events: new EventRepository(db, this.notifier),
      runs: new RunRepository(db, this.notifier, this.instance.id, items),
      messages: new MessageRepository(db, this.notifier),
      approvals: new ApprovalRepository(db, this.notifier),
      evidence: new EvidenceRepository(db, this.notifier),
      learnings: new LearningRepository(db, this.notifier),
      kv: new KvRepository(db, this.notifier),
    };
  }

  /** Close the database and release its lock. */
  close(): void {
    this.db.close();
    if (this.lock) unlockDatabase(this.lock);
  }

  transaction<T>(fn: () => T): T {
    return transaction(this.db, fn);
  }

  // Delegates to the repositories, so callers need not know which one owns a table.

  // --- work items ---

  createItem(...args: Parameters<ItemRepository["createItem"]>) {
    return this.repos.items.createItem(...args);
  }
  item(...args: Parameters<ItemRepository["item"]>) {
    return this.repos.items.item(...args);
  }
  itemByIssueUrl(...args: Parameters<ItemRepository["itemByIssueUrl"]>) {
    return this.repos.items.itemByIssueUrl(...args);
  }
  itemBySourceRef(...args: Parameters<ItemRepository["itemBySourceRef"]>) {
    return this.repos.items.itemBySourceRef(...args);
  }
  items(...args: Parameters<ItemRepository["items"]>) {
    return this.repos.items.items(...args);
  }
  closedItems(...args: Parameters<ItemRepository["closedItems"]>) {
    return this.repos.items.closedItems(...args);
  }
  totalCost(...args: Parameters<ItemRepository["totalCost"]>) {
    return this.repos.items.totalCost(...args);
  }
  outcomes(...args: Parameters<ItemRepository["outcomes"]>) {
    return this.repos.items.outcomes(...args);
  }
  stageFlow(...args: Parameters<ItemRepository["stageFlow"]>) {
    return this.repos.items.stageFlow(...args);
  }
  requesters(...args: Parameters<ItemRepository["requesters"]>) {
    return this.repos.items.requesters(...args);
  }
  automationHistory(...args: Parameters<ItemRepository["automationHistory"]>) {
    return this.repos.items.automationHistory(...args);
  }
  itemsWithOpenPr(...args: Parameters<ItemRepository["itemsWithOpenPr"]>) {
    return this.repos.items.itemsWithOpenPr(...args);
  }
  updateItem(...args: Parameters<ItemRepository["updateItem"]>) {
    return this.repos.items.updateItem(...args);
  }
  applyPolicyState(...args: Parameters<ItemRepository["applyPolicyState"]>) {
    return this.repos.items.applyPolicyState(...args);
  }
  addCost(...args: Parameters<ItemRepository["addCost"]>) {
    return this.repos.items.addCost(...args);
  }

  // --- events ---

  addEvent(...args: Parameters<EventRepository["addEvent"]>) {
    return this.repos.events.addEvent(...args);
  }
  pendingEvents(...args: Parameters<EventRepository["pendingEvents"]>) {
    return this.repos.events.pendingEvents(...args);
  }
  itemsWithPendingEvents(
    ...args: Parameters<EventRepository["itemsWithPendingEvents"]>
  ) {
    return this.repos.events.itemsWithPendingEvents(...args);
  }
  markEventsProcessed(
    ...args: Parameters<EventRepository["markEventsProcessed"]>
  ) {
    return this.repos.events.markEventsProcessed(...args);
  }
  events(...args: Parameters<EventRepository["events"]>) {
    return this.repos.events.events(...args);
  }

  // --- runs ---

  createRun(...args: Parameters<RunRepository["createRun"]>) {
    return this.repos.runs.createRun(...args);
  }
  markRunStarted(...args: Parameters<RunRepository["markRunStarted"]>) {
    return this.repos.runs.markRunStarted(...args);
  }
  setRunSession(...args: Parameters<RunRepository["setRunSession"]>) {
    return this.repos.runs.setRunSession(...args);
  }
  countRunTool(...args: Parameters<RunRepository["countRunTool"]>) {
    return this.repos.runs.countRunTool(...args);
  }
  setRunSnapshots(...args: Parameters<RunRepository["setRunSnapshots"]>) {
    return this.repos.runs.setRunSnapshots(...args);
  }
  queuedRuns(...args: Parameters<RunRepository["queuedRuns"]>) {
    return this.repos.runs.queuedRuns(...args);
  }
  cancelQueuedRuns(...args: Parameters<RunRepository["cancelQueuedRuns"]>) {
    return this.repos.runs.cancelQueuedRuns(...args);
  }
  finishRun(...args: Parameters<RunRepository["finishRun"]>) {
    return this.repos.runs.finishRun(...args);
  }
  runById(...args: Parameters<RunRepository["runById"]>) {
    return this.repos.runs.runById(...args);
  }
  runsForAgent(...args: Parameters<RunRepository["runsForAgent"]>) {
    return this.repos.runs.runsForAgent(...args);
  }
  runs(...args: Parameters<RunRepository["runs"]>) {
    return this.repos.runs.runs(...args);
  }
  recentRuns(...args: Parameters<RunRepository["recentRuns"]>) {
    return this.repos.runs.recentRuns(...args);
  }
  runAgents(...args: Parameters<RunRepository["runAgents"]>) {
    return this.repos.runs.runAgents(...args);
  }
  runningRuns(...args: Parameters<RunRepository["runningRuns"]>) {
    return this.repos.runs.runningRuns(...args);
  }
  latestAgentSession(...args: Parameters<RunRepository["latestAgentSession"]>) {
    return this.repos.runs.latestAgentSession(...args);
  }
  interruptRun(...args: Parameters<RunRepository["interruptRun"]>) {
    return this.repos.runs.interruptRun(...args);
  }
  moveRunLogs(...args: Parameters<RunRepository["moveRunLogs"]>) {
    return this.repos.runs.moveRunLogs(...args);
  }
  recoverOrphanedRuns(
    ...args: Parameters<RunRepository["recoverOrphanedRuns"]>
  ) {
    return this.repos.runs.recoverOrphanedRuns(...args);
  }

  // --- messages ---

  addMessage(...args: Parameters<MessageRepository["addMessage"]>) {
    return this.repos.messages.addMessage(...args);
  }
  factoryMessagesAfter(
    ...args: Parameters<MessageRepository["factoryMessagesAfter"]>
  ) {
    return this.repos.messages.factoryMessagesAfter(...args);
  }
  lastMessageId(...args: Parameters<MessageRepository["lastMessageId"]>) {
    return this.repos.messages.lastMessageId(...args);
  }
  messages(...args: Parameters<MessageRepository["messages"]>) {
    return this.repos.messages.messages(...args);
  }

  // --- evidence ---

  addEvidence(...args: Parameters<EvidenceRepository["addEvidence"]>) {
    return this.repos.evidence.addEvidence(...args);
  }
  latestEvidence(...args: Parameters<EvidenceRepository["latestEvidence"]>) {
    return this.repos.evidence.latestEvidence(...args);
  }
  itemsWithUnpostedEvidence(
    ...args: Parameters<EvidenceRepository["itemsWithUnpostedEvidence"]>
  ) {
    return this.repos.evidence.itemsWithUnpostedEvidence(...args);
  }
  setEvidenceUrl(...args: Parameters<EvidenceRepository["setEvidenceUrl"]>) {
    return this.repos.evidence.setEvidenceUrl(...args);
  }
  evidenceAfter(...args: Parameters<EvidenceRepository["evidenceAfter"]>) {
    return this.repos.evidence.evidenceAfter(...args);
  }
  lastEvidenceId(...args: Parameters<EvidenceRepository["lastEvidenceId"]>) {
    return this.repos.evidence.lastEvidenceId(...args);
  }

  // --- approvals ---

  addApproval(...args: Parameters<ApprovalRepository["addApproval"]>) {
    return this.repos.approvals.addApproval(...args);
  }
  approval(...args: Parameters<ApprovalRepository["approval"]>) {
    return this.repos.approvals.approval(...args);
  }
  approvals(...args: Parameters<ApprovalRepository["approvals"]>) {
    return this.repos.approvals.approvals(...args);
  }
  resolveApproval(...args: Parameters<ApprovalRepository["resolveApproval"]>) {
    return this.repos.approvals.resolveApproval(...args);
  }

  // --- learnings ---

  addLearning(...args: Parameters<LearningRepository["addLearning"]>) {
    return this.repos.learnings.addLearning(...args);
  }
  learning(...args: Parameters<LearningRepository["learning"]>) {
    return this.repos.learnings.learning(...args);
  }
  pendingLearnings(
    ...args: Parameters<LearningRepository["pendingLearnings"]>
  ) {
    return this.repos.learnings.pendingLearnings(...args);
  }
  approvedLearnings(
    ...args: Parameters<LearningRepository["approvedLearnings"]>
  ) {
    return this.repos.learnings.approvedLearnings(...args);
  }
  addRecurrences(...args: Parameters<LearningRepository["addRecurrences"]>) {
    return this.repos.learnings.addRecurrences(...args);
  }
  resolveLearning(...args: Parameters<LearningRepository["resolveLearning"]>) {
    return this.repos.learnings.resolveLearning(...args);
  }

  // --- kv ---

  getKv(...args: Parameters<KvRepository["getKv"]>) {
    return this.repos.kv.getKv(...args);
  }
  setKv(...args: Parameters<KvRepository["setKv"]>) {
    return this.repos.kv.setKv(...args);
  }
}
