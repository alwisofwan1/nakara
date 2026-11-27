import type { QueryClient } from "@tanstack/react-query";
import type { ChangeEvent } from "../../src/web/api.ts";

// Status changes also cover run writes and definition reloads, which the
// agents and automations pages read, and new items, which add requesters
// to the New work form, and instance settings, which live in kv.
const QUERY_KEYS: Record<ChangeEvent["type"], string[]> = {
  status: ["status", "automations", "agents", "new-work", "settings"],
  // The blueprint counts runs, and the stages items move through.
  runs: ["runs", "blueprint"],
  items: ["items", "inbox", "blueprint"],
  // A run page shows its siblings and the item's revision budget, so any run
  // or item change refreshes it. An item change can also move its PR's checks.
  run: ["runs"],
  item: ["runs", "pr"],
  // A factory's Settings page lists its definition's history.
  definition: ["definition", "factories"],
  creation: ["creation"],
  // The New work form starts from the factory's budget and Spec rule.
  factories: ["factories", "new-work"],
};

export function invalidateChange(client: QueryClient, data: string) {
  let event: ChangeEvent;
  try {
    event = JSON.parse(data);
  } catch {
    return;
  }
  if (typeof event?.id !== "string" || !Object.hasOwn(QUERY_KEYS, event.type))
    return;
  for (const key of QUERY_KEYS[event.type])
    void client.invalidateQueries({ queryKey: [key] });
}

/** On every (re)connect: changes may have been missed while offline, so refetch all live data. */
export function revalidateLive(client: QueryClient) {
  for (const queryKey of [
    ["status"],
    ["runs"],
    ["items"],
    ["inbox"],
    ["blueprint"],
    ["creation"],
    ["factories"],
  ])
    void client.invalidateQueries({ queryKey });
}
