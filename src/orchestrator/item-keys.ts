// The kv keys of per-item state, `<prefix><item id>` or `<prefix><item
// id>:…`, from the modules that own them. A factory delete removes its items'
// keys, and the startup sweep removes the keys of items that are gone.
import { MERGE_SUBMITTED } from "./operator-merge.ts";
import { ITEM_KEY_PREFIXES as GATE_KEY_PREFIXES } from "./pull-request-gate.ts";
import { REFLECT_SEEN } from "./reflect.ts";
import { RUN_LIMIT_TOLD } from "./run-support.ts";

/** The Slack thread an item was created from (intake/slack.ts). */
export const SLACK_ITEM = "slack:item:";

export const ITEM_KV_PREFIXES: readonly string[] = [
  ...GATE_KEY_PREFIXES,
  MERGE_SUBMITTED,
  RUN_LIMIT_TOLD,
  REFLECT_SEEN,
  SLACK_ITEM,
];
