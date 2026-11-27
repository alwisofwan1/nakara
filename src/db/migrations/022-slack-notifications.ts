// What Nakara tells the Operator (ADR-0006): the Slack channel a factory's
// "something needs you" messages go to, and a switch for each event: a Spec or
// Question waits, a Pull Request is ready to merge, a Work Item pauses at its
// Budget or run limit. A NULL switch is on; a NULL channel sends nothing, so
// an instance without settings behaves as before.
import type { Migration } from "../migrate.ts";

export const slackNotifications: Migration = {
  version: 22,
  name: "slack-notifications",
  up(db) {
    db.exec(`
ALTER TABLE factory_settings ADD COLUMN slack_channel TEXT;
ALTER TABLE factory_settings ADD COLUMN notify_approvals INTEGER;
ALTER TABLE factory_settings ADD COLUMN notify_handoff INTEGER;
ALTER TABLE factory_settings ADD COLUMN notify_paused INTEGER;`);
  },
  // A rollback only loses the saved channel and switches.
  down(db) {
    db.exec(`
ALTER TABLE factory_settings DROP COLUMN notify_paused;
ALTER TABLE factory_settings DROP COLUMN notify_handoff;
ALTER TABLE factory_settings DROP COLUMN notify_approvals;
ALTER TABLE factory_settings DROP COLUMN slack_channel;`);
  },
};
