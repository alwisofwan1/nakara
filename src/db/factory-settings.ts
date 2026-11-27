import type { DatabaseSync } from "node:sqlite";

import type { GateCheck, SpecRule } from "../domain/policy.ts";
import type { Notifier } from "./notifier.ts";
import { now, Repository } from "./repository.ts";

/** The per-factory limits a Work Item snapshots when it is created (ADR-0006). */
export interface FactoryLimits {
  budgetUsd: number;
  maxReviews: number;
  maxRevisions: number;
  maxRuns: number;
}

/** A factory's effective limits, and the environment defaults they fall back to. */
export interface FactoryLimitSettings extends FactoryLimits {
  /** Whether the factory writes a Spec before code; `when_asked` when unsaved. */
  specRule: SpecRule;
  /** The checks the factory adds to its Handoff Gate; none when unsaved. */
  gateChecks: GateCheck[];
  defaults: FactoryLimits;
}

/** A limits edit: an omitted key stays, `null` resets it to the default. */
export type LimitsEdit = { [K in keyof FactoryLimits]?: number | null } & {
  specRule?: SpecRule | null;
  /** Add (true) or remove (false or null) a Handoff Gate check; CI has no switch. */
  gateReview?: boolean | null;
  gateVerification?: boolean | null;
};

const COLUMNS = {
  budgetUsd: "budget_usd",
  maxReviews: "max_reviews",
  maxRevisions: "max_revisions",
  maxRuns: "max_runs",
} as const satisfies Record<keyof FactoryLimits, string>;

type Row = { [K in (typeof COLUMNS)[keyof FactoryLimits]]: number | null } & {
  spec_rule: SpecRule | null;
  gate_review: number | null;
  gate_verification: number | null;
};

/** What a factory without a saved rule does: the Foreman decides, unless the item asks. */
const DEFAULT_SPEC_RULE: SpecRule = "when_asked";

/**
 * Reads and writes the factory_settings table: how Nakara limits a factory.
 * A NULL column, or a factory without a row, uses the environment default.
 */
export class FactorySettingsRepository extends Repository {
  private readonly defaults: FactoryLimits;

  constructor(db: DatabaseSync, notifier: Notifier, defaults: FactoryLimits) {
    super(db, notifier);
    this.defaults = { ...defaults };
  }

  /** The factory's effective limits and the defaults; the defaults alone when it saved none. */
  settings(factoryId: number): FactoryLimitSettings {
    const row = this.get<Row>(
      "SELECT budget_usd, max_reviews, max_revisions, max_runs, spec_rule, gate_review, gate_verification FROM factory_settings WHERE factory_id = ?",
      factoryId,
    );
    const limit = (key: keyof FactoryLimits) =>
      row?.[COLUMNS[key]] ?? this.defaults[key];
    return {
      budgetUsd: limit("budgetUsd"),
      maxReviews: limit("maxReviews"),
      maxRevisions: limit("maxRevisions"),
      maxRuns: limit("maxRuns"),
      specRule: row?.spec_rule ?? DEFAULT_SPEC_RULE,
      gateChecks: [
        ...(row?.gate_review ? (["review"] as const) : []),
        ...(row?.gate_verification ? (["verification"] as const) : []),
      ],
      defaults: { ...this.defaults },
    };
  }

  /** Save the given limits, Spec rule and gate checks; the others keep their saved value. */
  saveLimits(factoryId: number, edit: LimitsEdit): void {
    const all = {
      ...COLUMNS,
      specRule: "spec_rule",
      gateReview: "gate_review",
      gateVerification: "gate_verification",
    } as const;
    const keys = (Object.keys(all) as (keyof typeof all)[]).filter(
      (key) => edit[key] !== undefined,
    );
    const columns = keys.map((key) => all[key]);
    this.run(
      `INSERT INTO factory_settings (factory_id, ${[...columns, "updated_at"].join(", ")})
       VALUES (?, ${[...columns, "updated_at"].map(() => "?").join(", ")})
       ON CONFLICT(factory_id) DO UPDATE SET ${[...columns, "updated_at"].map((c) => `${c} = excluded.${c}`).join(", ")}`,
      factoryId,
      ...keys.map((key) => {
        const value = edit[key];
        // A gate check is on (1) or off (NULL).
        if (typeof value === "boolean") return value ? 1 : null;
        return value ?? null;
      }),
      now(),
    );
    this.notifier.notify({ type: "factories", id: "global" });
  }

  /** When the Operator paused the factory; null while it runs. */
  pausedAt(factoryId: number): string | null {
    return (
      this.get<{ paused_at: string | null }>(
        "SELECT paused_at FROM factory_settings WHERE factory_id = ?",
        factoryId,
      )?.paused_at ?? null
    );
  }

  /**
   * Pause or resume the factory and return when it was paused (null when it
   * runs). Pausing a paused factory keeps its first pause time.
   */
  setPaused(factoryId: number, paused: boolean): string | null {
    const at = now();
    this.run(
      `INSERT INTO factory_settings (factory_id, paused_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(factory_id) DO UPDATE SET paused_at = ${paused ? "COALESCE(paused_at, excluded.paused_at)" : "NULL"}, updated_at = excluded.updated_at`,
      factoryId,
      paused ? at : null,
      at,
    );
    this.notifier.notify({ type: "factories", id: "global" });
    return this.pausedAt(factoryId);
  }
}
