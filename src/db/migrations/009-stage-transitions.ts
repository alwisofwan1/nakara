// Records every stage a work item enters, so the Blueprint page can count the
// moves between stages. Triggers catch every writer of work_items.stage; items
// before this migration have no history.
import type { Migration } from "../migrate.ts";

const AT = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

export const stageTransitions: Migration = {
  version: 9,
  name: "stage-transitions",
  up(db) {
    db.exec(`
CREATE TABLE stage_transitions (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES work_items(id),
  from_stage TEXT,
  to_stage TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX stage_transitions_item ON stage_transitions(item_id);
CREATE TRIGGER stage_entered AFTER INSERT ON work_items BEGIN
  INSERT INTO stage_transitions (item_id, from_stage, to_stage, at)
  VALUES (NEW.id, NULL, NEW.stage, ${AT});
END;
CREATE TRIGGER stage_changed AFTER UPDATE OF stage ON work_items
WHEN OLD.stage IS NOT NEW.stage BEGIN
  INSERT INTO stage_transitions (item_id, from_stage, to_stage, at)
  VALUES (NEW.id, OLD.stage, NEW.stage, ${AT});
END;`);
  },
  // Losing the recorded moves is all a rollback costs.
  down(db) {
    db.exec(`
DROP TRIGGER stage_changed;
DROP TRIGGER stage_entered;
DROP TABLE stage_transitions;`);
  },
};
