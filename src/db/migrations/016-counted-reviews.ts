// Which runs used up one of their work item's reviews (#21): a dispatched
// review run counts toward max_reviews when it is queued, and gives the review
// back when it ends without a verdict (stopped, cancelled or failed), so only
// a review that ran counts. Follow-ups never counted, so they carry 0.
//
// A review queued or running at the upgrade already counted in its item's
// review_count, so it is marked too, or a stop after the upgrade would keep
// the count. Before this migration a run did not say how it was created, but
// how each kind was created tells them apart:
// - a dispatch starts without a session, and the session it reports is new:
//   no earlier run of the agent in the item has it;
// - a follow-up resumes the agent's latest session (the foreman may only
//   follow up an agent that has one), and resuming keeps the session id, so
//   an earlier run of the agent has it;
// - the run that resumes an interrupted one, and an operator's retry of a
//   failed one, continue that run: they count when it did.
import type { DatabaseSync } from "node:sqlite";

import type { Migration } from "../migrate.ts";

// The inputs of the continuations as written before this migration; copied,
// so a later change to them cannot change what this migration does.
const RESUME_INPUT =
  "Nakara restarted while you were working, and your run was interrupted. Continue the task where you left off; the workspace still has the work you already did.";
const RETRY_PREFIX = "Your previous run failed";

interface ReviewRun {
  id: number;
  item_id: number;
  agent: string;
  session_id: string | null;
  status: string;
  input: string;
}

/** The review runs queued or running now that hold one of their item's reviews. */
function inFlightCountedReviews(db: DatabaseSync): number[] {
  const runs = db
    .prepare(
      `SELECT id, item_id, agent, session_id, status, input FROM runs
       WHERE role = 'agent' AND agent_type = 'REVIEW' ORDER BY id`,
    )
    .all() as unknown as ReviewRun[];
  const counted = new Map<number, boolean>();
  // The earlier runs of each item's review agent, oldest first.
  const earlier = new Map<string, ReviewRun[]>();
  for (const run of runs) {
    const key = JSON.stringify([run.item_id, run.agent]);
    const before = earlier.get(key) ?? [];
    const previous = before.at(-1);
    const continues =
      previous &&
      (run.input === RESUME_INPUT ||
        (previous.status === "failed" &&
          (run.input.startsWith(RETRY_PREFIX) ||
            (!run.session_id && run.input === previous.input))));
    counted.set(
      run.id,
      continues
        ? (counted.get(previous.id) ?? false)
        : !run.session_id ||
            !before.some((b) => b.session_id === run.session_id),
    );
    before.push(run);
    earlier.set(key, before);
  }
  return runs
    .filter(
      (r) =>
        (r.status === "queued" || r.status === "running") && counted.get(r.id),
    )
    .map((r) => r.id);
}

export const countedReviews: Migration = {
  version: 16,
  name: "counted-reviews",
  up(db) {
    db.exec(
      "ALTER TABLE runs ADD COLUMN counts_review INTEGER NOT NULL DEFAULT 0;",
    );
    const mark = db.prepare("UPDATE runs SET counts_review = 1 WHERE id = ?");
    for (const id of inFlightCountedReviews(db)) mark.run(id);
  },
  down(db) {
    db.exec("ALTER TABLE runs DROP COLUMN counts_review;");
  },
};
