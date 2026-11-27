import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import {
  type ItemStatus,
  parseGateChecks,
  type PolicyState,
  type SpecRule,
  type SpecState,
  type Stage,
  SpecRequestRefused,
} from "../domain/policy.ts";
import type { FactorySettingsRepository } from "./factory-settings.ts";
import type { Notifier } from "./notifier.ts";
import { now, Repository } from "./repository.ts";

export interface WorkItem {
  id: number;
  title: string;
  request: string;
  requester: string | null;
  source: "manual" | "github" | "schedule" | "telegram" | "slack";
  source_ref: string | null;
  source_url: string | null;
  repo: string | null;
  automation: string | null;
  /** The instructions of the Automation that created the item, copied at creation; null for other items and items before migration 020. */
  automation_instructions: string | null;
  /** That Automation's display name, copied at creation; null when it had none. */
  automation_display_name: string | null;
  stage: Stage;
  status: ItemStatus;
  spec_state: SpecState;
  review_count: number;
  revision_count: number;
  cost_usd: number;
  budget_usd: number;
  /** How many runs the item may start: foreman turns and agent runs, failed ones included. */
  max_runs: number;
  /** The runs the item started, of every role and however they ended. */
  run_count: number;
  /** How many reviews the item may run, copied from its factory when it was created. */
  max_reviews: number;
  /** How many revisions the item may take, copied from its factory when it was created. */
  max_revisions: number;
  /** Whether the item needs a Spec, copied from its factory when it was created. */
  spec_rule: SpecRule;
  /** 1 when the item asked for a Spec, which only the `when_asked` rule allows. */
  spec_requested: number;
  /** JSON array of the Handoff Gate checks the item's factory added, copied when it was created; '[]' for items before migration 021. */
  gate_checks: string;
  /** 1 when someone without write access edited the request after the Factory Label was applied. */
  request_edited: number;
  issue_url: string | null;
  pr_url: string | null;
  pr_merged: number;
  foreman_session: string | null;
  foreman_turns: number;
  created_at: string;
  updated_at: string;
  factory_id: number;
}

export function policyState(item: WorkItem): PolicyState {
  return {
    stage: item.stage,
    status: item.status,
    specState: item.spec_state,
    reviewCount: item.review_count,
    revisionCount: item.revision_count,
    costUsd: item.cost_usd,
    budgetUsd: item.budget_usd,
    runCount: item.run_count,
    maxRuns: item.max_runs,
    maxReviews: item.max_reviews,
    maxRevisions: item.max_revisions,
    specRule: item.spec_rule,
    specRequested: item.spec_requested === 1,
    gateChecks: parseGateChecks(item.gate_checks),
    // Only the item's runs tell; callers that judge a handoff fill them
    // (policyFor). Unknown counts as not met, so nothing passes by omission.
    reviewAccepted: false,
    verificationPassed: false,
    prUrl: item.pr_url,
    prMerged: item.pr_merged === 1,
  };
}

/** Reads and writes the work_items table. */
export class ItemRepository extends Repository {
  private readonly settings: FactorySettingsRepository;

  constructor(
    db: DatabaseSync,
    notifier: Notifier,
    settings: FactorySettingsRepository,
  ) {
    super(db, notifier);
    this.settings = settings;
  }

  /** A work item changed: the status bar, the item lists, and the item itself. */
  private changed(id: number): void {
    this.notifier.notify({ type: "status", id: "global" });
    this.notifier.notify({ type: "items", id: "global" });
    this.notifier.notify({ type: "item", id: String(id) });
  }

  createItem(input: {
    title: string;
    request: string;
    requester?: string | null;
    source: WorkItem["source"];
    sourceRef?: string | null;
    sourceUrl?: string | null;
    repo?: string | null;
    automation?: string | null;
    /** The Automation's instructions and display name, copied so later edits leave the item alone. */
    automationInstructions?: string | null;
    automationDisplayName?: string | null;
    issueUrl?: string | null;
    requestEdited?: boolean;
    /** Ask for a Spec; refused unless the factory's rule is `when_asked`. */
    specRequested?: boolean;
    /** Overrides the factory's Budget per Work Item. */
    budgetUsd?: number;
    /** The owning factory; the first factory when omitted. */
    factoryId?: number;
  }): WorkItem {
    const t = now();
    const factoryId =
      input.factoryId ??
      // biome-ignore lint/style/noNonNullAssertion: Migration 005 seeds a factory.
      this.get<{ id: number }>("SELECT MIN(id) AS id FROM factories")!.id;
    // A snapshot: changing the factory's limits later leaves this item alone.
    const limits = this.settings.settings(factoryId);
    // ADR-0006 rule 3: an item cannot opt out of `always` or into `never`.
    if (input.specRequested && limits.specRule !== "when_asked")
      throw new SpecRequestRefused(limits.specRule);
    const id = this.run(
      `INSERT INTO work_items (title, request, requester, source, source_ref, source_url, repo, automation, automation_instructions, automation_display_name, issue_url, request_edited, budget_usd, max_runs, max_reviews, max_revisions, spec_rule, spec_requested, gate_checks, factory_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      input.title,
      input.request,
      input.requester ?? null,
      input.source,
      input.sourceRef ?? null,
      input.sourceUrl ?? null,
      input.repo ?? null,
      input.automation ?? null,
      input.automationInstructions ?? null,
      input.automationDisplayName ?? null,
      input.issueUrl ?? null,
      input.requestEdited ? 1 : 0,
      input.budgetUsd ?? limits.budgetUsd,
      limits.maxRuns,
      limits.maxReviews,
      limits.maxRevisions,
      limits.specRule,
      input.specRequested ? 1 : 0,
      JSON.stringify(limits.gateChecks),
      factoryId,
      t,
      t,
    );
    this.changed(id);
    // biome-ignore lint/style/noNonNullAssertion: The synchronous insert or aggregate query guarantees a row; preserve the existing runtime behavior.
    return this.item(id)!;
  }

  item(id: number): WorkItem | undefined {
    return this.get<WorkItem>("SELECT * FROM work_items WHERE id = ?", id);
  }

  itemByIssueUrl(url: string): WorkItem | undefined {
    return this.get<WorkItem>(
      "SELECT * FROM work_items WHERE issue_url = ?",
      url,
    );
  }

  itemBySourceRef(ref: string): WorkItem | undefined {
    return this.get<WorkItem>(
      "SELECT * FROM work_items WHERE source_ref = ?",
      ref,
    );
  }

  /** Open items, or the latest 200; only one factory's with `factoryId`. */
  items(filter: { open?: boolean; factoryId?: number } = {}): WorkItem[] {
    const factory = filter.factoryId ?? null;
    return filter.open
      ? this.all<WorkItem>(
          "SELECT * FROM work_items WHERE stage NOT IN ('complete','cancelled') AND (? IS NULL OR factory_id = ?) ORDER BY updated_at DESC",
          factory,
          factory,
        )
      : this.all<WorkItem>(
          "SELECT * FROM work_items WHERE (? IS NULL OR factory_id = ?) ORDER BY updated_at DESC LIMIT 200",
          factory,
          factory,
        );
  }

  closedItems(limit: number, factoryId?: number): WorkItem[] {
    return this.all<WorkItem>(
      "SELECT * FROM work_items WHERE stage IN ('complete','cancelled') AND (? IS NULL OR factory_id = ?) ORDER BY updated_at DESC LIMIT ?",
      factoryId ?? null,
      factoryId ?? null,
      limit,
    );
  }

  /**
   * What closed work came to: its pull requests, merged or closed unmerged,
   * the revisions they took, and for each merged one the hours from request
   * to its last merge (a spec PR can merge first). Cost counts every closed
   * item, so work that ended without a merge is paid for by the merged PRs.
   */
  outcomes(factoryId?: number): {
    prs: number;
    merged: number;
    revisions: number;
    costUsd: number;
    cycleHours: number[];
  } {
    const totals = this.get<{
      prs: number;
      merged: number;
      revisions: number;
      cost: number;
    }>(
      `SELECT COALESCE(SUM(pr_url IS NOT NULL), 0) AS prs,
              COALESCE(SUM(pr_url IS NOT NULL AND pr_merged = 1), 0) AS merged,
              COALESCE(SUM(CASE WHEN pr_url IS NOT NULL THEN revision_count END), 0) AS revisions,
              COALESCE(SUM(cost_usd), 0) AS cost
       FROM work_items
       WHERE stage IN ('complete','cancelled') AND (? IS NULL OR factory_id = ?)`,
      factoryId ?? null,
      factoryId ?? null,
    );
    const cycles = this.all<{ created_at: string; merged_at: string }>(
      `SELECT created_at,
              (SELECT MAX(e.created_at) FROM events e
               WHERE e.item_id = w.id AND e.kind = 'pr_merged') AS merged_at
       FROM work_items w
       WHERE stage IN ('complete','cancelled') AND pr_merged = 1
         AND (? IS NULL OR factory_id = ?)`,
      factoryId ?? null,
      factoryId ?? null,
    );
    return {
      prs: totals?.prs ?? 0,
      merged: totals?.merged ?? 0,
      revisions: totals?.revisions ?? 0,
      costUsd: totals?.cost ?? 0,
      cycleHours: cycles
        .filter((c) => c.merged_at)
        .map(
          (c) =>
            (Date.parse(c.merged_at) - Date.parse(c.created_at)) / 3_600_000,
        )
        .sort((a, b) => a - b),
    };
  }

  totalCost(factoryId?: number): number {
    return (
      this.get<{ cost: number }>(
        "SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM work_items WHERE (? IS NULL OR factory_id = ?)",
        factoryId ?? null,
        factoryId ?? null,
      )?.cost ?? 0
    );
  }

  /** Everyone who has requested work, for the New work form. */
  requesters(): string[] {
    return this.all<{ requester: string }>(
      "SELECT DISTINCT requester FROM work_items WHERE requester IS NOT NULL ORDER BY requester",
    ).map((r) => r.requester);
  }

  automationHistory(name: string): { count: number; items: WorkItem[] } {
    const count =
      this.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM work_items WHERE automation = ?",
        name,
      )?.count ?? 0;
    const items = this.all<WorkItem>(
      "SELECT * FROM work_items WHERE automation = ? ORDER BY id DESC LIMIT 5",
      name,
    );
    return { count, items };
  }

  itemsWithOpenPr(): WorkItem[] {
    return this.all<WorkItem>(
      "SELECT * FROM work_items WHERE pr_url IS NOT NULL AND pr_merged = 0 AND stage NOT IN ('complete','cancelled')",
    );
  }

  /**
   * A factory's recorded stage moves, counted per edge (from null: the stage an
   * item started in), and its agent runs counted per agent type.
   */
  stageFlow(factoryId?: number): {
    transitions: { from: Stage | null; to: Stage; count: number }[];
    runs: { agentType: string; count: number }[];
  } {
    const f = [factoryId ?? null, factoryId ?? null] as const;
    return {
      transitions: this.all(
        `SELECT t.from_stage AS "from", t.to_stage AS "to", COUNT(*) AS count
         FROM stage_transitions t JOIN work_items w ON w.id = t.item_id
         WHERE (? IS NULL OR w.factory_id = ?) GROUP BY 1, 2`,
        ...f,
      ),
      runs: this.all(
        `SELECT r.agent_type AS agentType, COUNT(*) AS count
         FROM runs r JOIN work_items w ON w.id = r.item_id
         WHERE r.role = 'agent' AND r.agent_type IS NOT NULL
         AND (? IS NULL OR w.factory_id = ?) GROUP BY 1`,
        ...f,
      ),
    };
  }

  updateItem(
    id: number,
    patch: Partial<Omit<WorkItem, "id" | "created_at">>,
  ): void {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    this.run(
      `UPDATE work_items SET ${sets}, updated_at = ? WHERE id = ?`,
      ...entries.map(([, v]) =>
        typeof v === "boolean" ? Number(v) : (v as SQLInputValue),
      ),
      now(),
      id,
    );
    this.changed(id);
  }

  applyPolicyState(id: number, s: PolicyState): void {
    this.updateItem(id, {
      stage: s.stage,
      status: s.status,
      spec_state: s.specState,
      review_count: s.reviewCount,
      revision_count: s.revisionCount,
      pr_url: s.prUrl,
      pr_merged: s.prMerged ? 1 : 0,
    });
  }

  /** A review that ended without a verdict no longer counts toward max_reviews (see RunRepository). */
  giveBackReview(id: number): void {
    this.run(
      "UPDATE work_items SET review_count = MAX(review_count - 1, 0), updated_at = ? WHERE id = ?",
      now(),
      id,
    );
    this.changed(id);
  }

  /** Count one more run of the item, whatever its role or however it ends. */
  countRun(id: number): void {
    this.run(
      "UPDATE work_items SET run_count = run_count + 1, updated_at = ? WHERE id = ?",
      now(),
      id,
    );
    this.changed(id);
  }

  addCost(id: number, usd: number): void {
    if (usd <= 0) return;
    this.run(
      "UPDATE work_items SET cost_usd = cost_usd + ?, updated_at = ? WHERE id = ?",
      usd,
      now(),
      id,
    );
    this.changed(id);
  }
}
