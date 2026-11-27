import { EventEmitter } from "node:events";

/** A thin change notification: clients refetch the named resource over REST. */
export type ChangeEvent =
  | { type: "status"; id: "global" }
  | { type: "runs"; id: "global" }
  | { type: "items"; id: "global" }
  | { type: "item"; id: string }
  | { type: "run"; id: string }
  | { type: "definition"; id: "global" }
  /** The factory registry: a factory was renamed, moved or deleted. */
  | { type: "factories"; id: "global" }
  /** A New factory wizard's creation job, by its id. */
  | { type: "creation"; id: string };
export type ChangeType = ChangeEvent["type"];

/**
 * A Work Item needs the Operator: a Spec or Question waits (`approvals`), its
 * Pull Request is ready to merge (`handoff`), or it stopped at its Budget or
 * run limit (`paused`). Intake bridges tell the Operator (see SlackBridge).
 */
export interface NeedsYou {
  itemId: number;
  event: "approvals" | "handoff" | "paused";
  /** What the Operator is asked to do, in plain text. */
  what: string;
}

/** Tells live clients which resources changed, coalescing a burst of writes. */
export class Notifier {
  readonly changes = new EventEmitter<{ change: [event: ChangeEvent] }>();
  /** Work Items that need the Operator; see NeedsYou. */
  readonly attention = new EventEmitter<{ needsYou: [event: NeedsYou] }>();
  private readonly pending = new Map<string, ChangeEvent>();

  constructor() {
    // Each open SSE connection owns a listener; connections clean up on abort.
    this.changes.setMaxListeners(0);
  }

  /** Tell live clients that a resource changed. */
  notify(event: ChangeEvent): void {
    const queued = this.pending.size > 0;
    this.pending.set(`${event.type}:${event.id}`, event);
    if (queued) return;
    // Run after the synchronous transaction commits; coalesce a burst of writes.
    queueMicrotask(() => {
      const events = [...this.pending.values()];
      this.pending.clear();
      for (const e of events) this.changes.emit("change", e);
    });
  }

  /**
   * Tell the listeners that a Work Item needs the Operator, after the
   * synchronous transaction that recorded it commits. A listener's failure
   * never reaches the writer: notifying is never why work fails.
   */
  needsYou(event: NeedsYou): void {
    queueMicrotask(() => {
      try {
        this.attention.emit("needsYou", event);
      } catch {
        // A listener reports its own failures (SlackBridge logs them).
      }
    });
  }
}
