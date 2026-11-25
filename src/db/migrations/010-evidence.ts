// Screenshots an implement run left as proof of its acceptance criteria. Nakara
// copies them out of the workspace, then posts them on the item's PR and in its
// Slack thread; github_url is set once the PR comment carries the image.
import type { Migration } from "../migrate.ts";

export const evidence: Migration = {
  version: 10,
  name: "evidence",
  up(db) {
    db.exec(`
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  criterion TEXT NOT NULL,
  file TEXT NOT NULL,
  github_url TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX evidence_item ON evidence(item_id);
CREATE INDEX evidence_unposted ON evidence(item_id) WHERE github_url IS NULL;`);
  },
  // Losing the proof records is all a rollback costs; the files stay on disk.
  down(db) {
    db.exec("DROP TABLE evidence;");
  },
};
