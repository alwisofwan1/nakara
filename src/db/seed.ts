// Synthetic data at production scale, for query plans and load checks.
import type { DatabaseSync } from "node:sqlite";

export interface SeedCounts {
  items: number;
  runs: number;
}

/** Fill a migrated, empty database: per item a few messages, approvals and events; runs spread over the items, almost all finished. */
export function seed(db: DatabaseSync, { items, runs }: SeedCounts): void {
  const at = "2026-01-01T00:00:00.000Z";
  const text = "x".repeat(2000);
  const item = db.prepare(
    `INSERT INTO work_items (title, request, source, source_ref, stage, status, budget_usd, factory_id, created_at, updated_at)
     VALUES (?, ?, 'manual', ?, ?, 'active', 15, (SELECT MIN(id) FROM factories), ?, ?)`,
  );
  const message = db.prepare(
    "INSERT INTO messages (item_id, author, body, created_at) VALUES (?, ?, ?, ?)",
  );
  const approval = db.prepare(
    "INSERT INTO approvals (item_id, kind, prompt, status, created_at) VALUES (?, 'question', 'Which?', ?, ?)",
  );
  const event = db.prepare(
    "INSERT INTO events (item_id, kind, payload, created_at, processed_at) VALUES (?, 'agent_report', '{}', ?, ?)",
  );
  const run = db.prepare(
    `INSERT INTO runs (item_id, role, agent, agent_type, harness, status, input, result, started_at)
     VALUES (?, ?, ?, ?, 'claude', ?, ?, ?, ?)`,
  );
  db.exec("BEGIN");
  try {
    for (let i = 1; i <= items; i++) {
      // One item in ten is still open.
      const open = i % 10 === 0;
      item.run(
        `Item ${i}`,
        text,
        `seed:${i}`,
        open ? "implement" : "complete",
        at,
        at,
      );
      for (const author of ["requester", "factory", "factory"])
        message.run(i, author, text, at);
      approval.run(i, open ? "pending" : "approved", at);
      for (let e = 0; e < 4; e++) event.run(i, at, open && e === 3 ? null : at);
    }
    for (let r = 1; r <= runs; r++) {
      const foreman = r % 3 === 0;
      // The last few runs are still queued or running.
      const status =
        r > runs - 4 ? "queued" : r > runs - 8 ? "running" : "succeeded";
      run.run(
        ((r - 1) % items) + 1,
        foreman ? "foreman" : "agent",
        foreman ? "foreman" : "implement",
        foreman ? "foreman" : "implement",
        status,
        text,
        status === "succeeded" ? text : null,
        at,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  db.exec("ANALYZE");
}
