// Indexes for the queries that run on every pump and every UI refresh: the
// scheduler's runs by status, and the per-item reads of the Inbox, the Work
// Item page and the status footer.
import type { Migration } from "../migrate.ts";

export const hotPathIndexes: Migration = {
  version: 2,
  name: "hot-path-indexes",
  up(db) {
    db.exec(`
      CREATE INDEX runs_status ON runs(status);
      CREATE INDEX runs_item ON runs(item_id, id);
      CREATE INDEX messages_item ON messages(item_id, id);
      CREATE INDEX approvals_item ON approvals(item_id, id);
      CREATE INDEX events_item ON events(item_id, id);
    `);
  },
};
