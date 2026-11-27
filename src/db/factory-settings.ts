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

/** The events a factory can tell the Operator about in Slack. */
export const NOTIFY_EVENTS = ["approvals", "handoff", "paused"] as const;
export type NotifyEvent = (typeof NOTIFY_EVENTS)[number];

/** Where and when Nakara tells the Operator that a Work Item needs them. */
export interface NotificationSettings {
  /** A Slack channel ID, or the name the Operator gave when it did not resolve; null sends nothing. */
  slackChannel: string | null;
  /** Each event's switch; on when unsaved. */
  notify: Record<NotifyEvent, boolean>;
}

/** A notifications edit: an omitted key stays, `null` clears the channel or turns the switch back on. */
export type NotificationsEdit = {
  slackChannel?: string | null;
} & { [K in NotifyEvent]?: boolean | null };

const NOTIFY_COLUMNS = {
  approvals: "notify_approvals",
  handoff: "notify_handoff",
  paused: "notify_paused",
} as const satisfies Record<NotifyEvent, string>;

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
    this.upsert(
      factoryId,
      keys.map((key) => {
        const value = edit[key];
        // A gate check is on (1) or off (NULL).
        if (typeof value === "boolean") return [all[key], value ? 1 : null];
        return [all[key], value ?? null];
      }),
    );
  }

  /** Where the factory's Slack notifications go, and which events send one. */
  notifications(factoryId: number): NotificationSettings {
    const row = this.get<
      { slack_channel: string | null } & Record<
        (typeof NOTIFY_COLUMNS)[NotifyEvent],
        number | null
      >
    >(
      "SELECT slack_channel, notify_approvals, notify_handoff, notify_paused FROM factory_settings WHERE factory_id = ?",
      factoryId,
    );
    return {
      slackChannel: row?.slack_channel ?? null,
      // NULL falls back to on (ADR-0006); only a saved 0 turns an event off.
      notify: {
        approvals: row?.notify_approvals !== 0,
        handoff: row?.notify_handoff !== 0,
        paused: row?.notify_paused !== 0,
      },
    };
  }

  /** Save the given channel and switches; the others keep their saved value. */
  saveNotifications(factoryId: number, edit: NotificationsEdit): void {
    const values: [string, string | number | null][] = [];
    if (edit.slackChannel !== undefined)
      values.push(["slack_channel", edit.slackChannel || null]);
    for (const event of NOTIFY_EVENTS) {
      const on = edit[event];
      // A switch is off (0) or on (NULL, the default).
      if (on !== undefined)
        values.push([NOTIFY_COLUMNS[event], on === false ? 0 : null]);
    }
    this.upsert(factoryId, values);
  }

  /** Insert or update the factory's row with the given column values. */
  private upsert(
    factoryId: number,
    values: [column: string, value: string | number | null][],
  ): void {
    const columns = [...values.map(([c]) => c), "updated_at"];
    this.run(
      `INSERT INTO factory_settings (factory_id, ${columns.join(", ")})
       VALUES (?, ${columns.map(() => "?").join(", ")})
       ON CONFLICT(factory_id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
      factoryId,
      ...values.map(([, v]) => v),
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
