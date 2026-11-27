import { now, Repository } from "./repository.ts";

export type EventKind =
  | "work_received"
  | "agent_report"
  | "human_reply"
  | "human_message"
  | "pr_merged"
  | "pr_closed"
  | "checks_updated"
  | "pr_feedback"
  | "run_stopped"
  | "budget_raised"
  | "run_limit_raised";

export interface ItemEvent {
  id: number;
  item_id: number;
  kind: EventKind;
  payload: string;
  created_at: string;
  processed_at: string | null;
}

/** Reads and writes the events table: the foreman's inbox; no live client shows it. */
export class EventRepository extends Repository {
  addEvent(
    itemId: number,
    kind: EventKind,
    payload: Record<string, unknown>,
  ): number {
    return this.run(
      "INSERT INTO events (item_id, kind, payload, created_at) VALUES (?, ?, ?, ?)",
      itemId,
      kind,
      JSON.stringify(payload),
      now(),
    );
  }

  pendingEvents(itemId: number): ItemEvent[] {
    return this.all<ItemEvent>(
      "SELECT * FROM events WHERE item_id = ? AND processed_at IS NULL ORDER BY id",
      itemId,
    );
  }

  itemsWithPendingEvents(): number[] {
    return this.all<{ item_id: number }>(
      "SELECT DISTINCT item_id FROM events WHERE processed_at IS NULL ORDER BY item_id",
    ).map((r) => r.item_id);
  }

  markEventsProcessed(ids: number[]): void {
    const t = now();
    for (const id of ids)
      this.run("UPDATE events SET processed_at = ? WHERE id = ?", t, id);
  }

  events(itemId: number): ItemEvent[] {
    return this.all<ItemEvent>(
      "SELECT * FROM events WHERE item_id = ? ORDER BY id",
      itemId,
    );
  }
}
