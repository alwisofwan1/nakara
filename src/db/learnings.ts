import { now, Repository } from "./repository.ts";

/** The kv key counting a factory's corrections no reflect run checked. */
export const uncheckedKey = (factoryId: number) =>
  `reflect:factory:${factoryId}:unchecked`;

/** A reflect run's proposal: up to 3 lesson lines and the mistake they target. */
export interface Learning {
  id: number;
  item_id: number;
  run_id: number;
  /** JSON array of the proposed lines; on approval, the lines as written. */
  lines: string;
  /** The mistake the lesson targets, so a later finding of its kind counts as a recurrence. */
  mistake: string;
  /** 1 when the reflect run thinks a lint rule, type or test should hold the lesson instead. */
  suggest_check: number;
  status: "pending" | "approved" | "rejected";
  reason: string | null;
  /** Later corrections a reflect run found repeating this lesson's mistake. */
  recurrences: number;
  created_at: string;
  resolved_at: string | null;
}

/** Reads and writes the learnings table: lesson proposals and the Operator's decisions. */
export class LearningRepository extends Repository {
  /** Pending lessons show in the Inbox and its counts. */
  private changed(): void {
    this.notifier.notify({ type: "status", id: "global" });
    this.notifier.notify({ type: "items", id: "global" });
  }

  /** The new proposal's id, or null when the item already has one pending. */
  addLearning(
    itemId: number,
    runId: number,
    proposal: { lines: string[]; mistake: string; suggestCheck: boolean },
  ): number | null {
    const result = this.db
      .prepare(
        `INSERT INTO learnings (item_id, run_id, lines, mistake, suggest_check, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      )
      .run(
        itemId,
        runId,
        JSON.stringify(proposal.lines),
        proposal.mistake,
        proposal.suggestCheck ? 1 : 0,
        now(),
      );
    if (!result.changes) return null;
    this.changed();
    return Number(result.lastInsertRowid);
  }

  learning(id: number): Learning | undefined {
    return this.get<Learning>("SELECT * FROM learnings WHERE id = ?", id);
  }

  /** Oldest first. */
  pendingLearnings(): Learning[] {
    return this.all<Learning>(
      "SELECT * FROM learnings WHERE status = 'pending' ORDER BY id",
    );
  }

  /** Approved lessons of every factory, or of the one with factoryId. */
  approvedLearnings(factoryId?: number): Learning[] {
    return this.all<Learning>(
      `SELECT l.* FROM learnings l JOIN work_items w ON w.id = l.item_id
       WHERE l.status = 'approved' AND (? IS NULL OR w.factory_id = ?) ORDER BY l.id`,
      factoryId ?? null,
      factoryId ?? null,
    );
  }

  /**
   * Count a recurrence of each named lesson; ids that are not approved lessons
   * of factoryId are ignored, since a reflect run's report names them.
   */
  addRecurrences(ids: number[], factoryId: number): number {
    let counted = 0;
    for (const id of new Set(ids))
      counted += Number(
        this.db
          .prepare(
            `UPDATE learnings SET recurrences = recurrences + 1
             WHERE id = ? AND status = 'approved'
               AND item_id IN (SELECT id FROM work_items WHERE factory_id = ?)`,
          )
          .run(id, factoryId).changes,
      );
    if (counted) this.changed();
    return counted;
  }

  /**
   * Decide a pending proposal; `lines` replaces the proposed ones when the
   * Operator edited them. False when it was not pending.
   */
  resolveLearning(
    id: number,
    status: "approved" | "rejected",
    decision: { lines?: string[]; reason?: string | null },
  ): boolean {
    const result = this.db
      .prepare(
        `UPDATE learnings SET status = ?, lines = coalesce(?, lines), reason = ?, resolved_at = ?
         WHERE id = ? AND status = 'pending'`,
      )
      .run(
        status,
        decision.lines ? JSON.stringify(decision.lines) : null,
        decision.reason ?? null,
        now(),
        id,
      );
    if (!result.changes) return false;
    this.changed();
    return true;
  }
}
