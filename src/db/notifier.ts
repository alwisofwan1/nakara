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

/** Tells live clients which resources changed, coalescing a burst of writes. */
export class Notifier {
  readonly changes = new EventEmitter<{ change: [event: ChangeEvent] }>();
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
}
