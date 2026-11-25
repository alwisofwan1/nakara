// Adds the `interrupted` run status: a run that a restart cut short and that
// continues in its session, instead of failing. The statuses become a CHECK
// constraint, so a status unknown to the code cannot be written, and a new one
// needs a migration. SQLite cannot add a constraint in place: the runs table
// is rebuilt with its rows and indexes.
import type { Migration } from "../migrate.ts";

const RUN_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export const interruptedRuns: Migration = {
  version: 3,
  name: "interrupted-runs",
  up(db) {
    db.exec(`
      CREATE TABLE runs_rebuilt (
        id INTEGER PRIMARY KEY,
        item_id INTEGER NOT NULL REFERENCES work_items(id),
        role TEXT NOT NULL,
        agent TEXT NOT NULL,
        agent_type TEXT NOT NULL,
        harness TEXT NOT NULL,
        model TEXT,
        session_id TEXT,
        status TEXT NOT NULL CHECK (status IN (${RUN_STATUSES.map((s) => `'${s}'`).join(", ")})),
        input TEXT NOT NULL,
        result TEXT,
        error TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        num_turns INTEGER,
        duration_ms INTEGER,
        log_path TEXT,
        started_at TEXT NOT NULL,
        ended_at TEXT
      );
      INSERT INTO runs_rebuilt SELECT id, item_id, role, agent, agent_type, harness, model, session_id,
        status, input, result, error, cost_usd, num_turns, duration_ms, log_path, started_at, ended_at FROM runs;
      DROP TABLE runs;
      ALTER TABLE runs_rebuilt RENAME TO runs;
      CREATE INDEX runs_agent ON runs(agent, id);
      CREATE INDEX runs_status ON runs(status);
      CREATE INDEX runs_item ON runs(item_id, id);
    `);
  },
};
