import { now, Repository } from "./repository.ts";

export interface Approval {
  id: number;
  item_id: number;
  kind: "spec" | "question";
  prompt: string;
  ref_url: string | null;
  status: "pending" | "approved" | "rejected" | "answered";
  answer: string | null;
  /** JSON array of suggested answers to a question, or null. */
  options: string | null;
  created_at: string;
  resolved_at: string | null;
}

/** Reads and writes the approvals table: the decisions the factory waits on. */
export class ApprovalRepository extends Repository {
  /** Pending approvals show in the status bar and the item lists. */
  private changed(): void {
    this.notifier.notify({ type: "status", id: "global" });
    this.notifier.notify({ type: "items", id: "global" });
  }

  addApproval(
    itemId: number,
    kind: Approval["kind"],
    prompt: string,
    refUrl: string | null,
    options: string[] = [],
  ): number {
    const id = this.run(
      "INSERT INTO approvals (item_id, kind, prompt, ref_url, options, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      itemId,
      kind,
      prompt,
      refUrl,
      options.length ? JSON.stringify(options) : null,
      now(),
    );
    this.changed();
    this.notifier.needsYou({
      itemId,
      event: "approvals",
      what:
        kind === "spec"
          ? `A Spec waits for your approval${refUrl ? `: ${refUrl}` : "."}`
          : `A Question waits for your answer: ${prompt}`,
    });
    return id;
  }

  approval(id: number): Approval | undefined {
    return this.get<Approval>("SELECT * FROM approvals WHERE id = ?", id);
  }

  approvals(itemId: number): Approval[] {
    return this.all<Approval>(
      "SELECT * FROM approvals WHERE item_id = ? ORDER BY id",
      itemId,
    );
  }

  resolveApproval(
    id: number,
    status: Approval["status"],
    answer: string | null,
  ): void {
    this.run(
      "UPDATE approvals SET status = ?, answer = ?, resolved_at = ? WHERE id = ?",
      status,
      answer,
      now(),
      id,
    );
    this.changed();
  }
}
