import { now, Repository } from "./repository.ts";

/** One screenshot an implement run left as proof of one acceptance criterion. */
export interface Evidence {
  id: number;
  item_id: number;
  run_id: number;
  criterion: string;
  /** The copy in the item's internal directory, outside every agent mount. */
  file: string;
  /** The GitHub attachment once the PR comment carries it. */
  github_url: string | null;
  created_at: string;
}

/** Reads and writes the evidence table. */
export class EvidenceRepository extends Repository {
  addEvidence(
    itemId: number,
    runId: number,
    proofs: { criterion: string; file: string }[],
  ): void {
    for (const p of proofs)
      this.run(
        "INSERT INTO evidence (item_id, run_id, criterion, file, created_at) VALUES (?, ?, ?, ?, ?)",
        itemId,
        runId,
        p.criterion,
        p.file,
        now(),
      );
    if (proofs.length)
      this.notifier.notify({ type: "item", id: String(itemId) });
  }

  /** The proof of the item's latest run that left any, in the order it was given. */
  latestEvidence(itemId: number): Evidence[] {
    return this.all<Evidence>(
      `SELECT * FROM evidence WHERE item_id = ? AND run_id =
         (SELECT MAX(run_id) FROM evidence WHERE item_id = ?) ORDER BY id`,
      itemId,
      itemId,
    );
  }

  /** Items whose latest proof is not yet on their PR; a later run's proof supersedes an earlier one. */
  itemsWithUnpostedEvidence(): number[] {
    return this.all<{ item_id: number }>(
      `SELECT DISTINCT item_id FROM evidence e WHERE github_url IS NULL
         AND run_id = (SELECT MAX(run_id) FROM evidence WHERE item_id = e.item_id)`,
    ).map((r) => r.item_id);
  }

  setEvidenceUrl(id: number, url: string): void {
    this.run("UPDATE evidence SET github_url = ? WHERE id = ?", url, id);
  }

  /** Proof after a cursor, for the Slack thread. */
  evidenceAfter(id: number): Evidence[] {
    return this.all<Evidence>(
      "SELECT * FROM evidence WHERE id > ? ORDER BY id LIMIT 50",
      id,
    );
  }

  lastEvidenceId(): number {
    return (
      this.get<{ id: number | null }>("SELECT max(id) AS id FROM evidence")
        ?.id ?? 0
    );
  }
}
