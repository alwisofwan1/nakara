import { test } from "node:test";
import assert from "node:assert/strict";

import { cronMatches, parseCron } from "./schedule.ts";

const at = (iso: string) => new Date(`${iso}Z`);

test("cron macros expand to their five-field UTC schedules", () => {
  for (const [macro, expression] of [
    ["@hourly", "0 * * * *"],
    ["@daily", "0 0 * * *"],
    ["@midnight", "0 0 * * *"],
    ["@weekly", "0 0 * * 0"],
    ["@monthly", "0 0 1 * *"],
  ] as const) {
    assert.deepEqual(parseCron(macro), parseCron(expression), macro);
    assert.deepEqual(
      parseCron(` \t${macro}\n`),
      parseCron(expression),
      `${macro} with whitespace`,
    );
  }
});

test("cron fields, steps, ranges and lists match in UTC", () => {
  const weekly = parseCron("0 9 * * 1"); // Mondays 09:00
  assert.ok(cronMatches(weekly, at("2026-10-19T09:00")));
  assert.ok(!cronMatches(weekly, at("2026-10-20T09:00")));
  assert.ok(!cronMatches(weekly, at("2026-10-19T09:01")));
  const every15 = parseCron("*/15 8-10,22 * * *");
  assert.ok(cronMatches(every15, at("2026-10-21T22:45")));
  assert.ok(!cronMatches(every15, at("2026-10-21T11:15")));
  assert.ok(cronMatches(parseCron("0 0 * * 7"), at("2026-10-25T00:00"))); // 7 is Sunday
});

test("restricted day-of-month and day-of-week match either", () => {
  const cron = parseCron("0 0 1 * 1");
  assert.ok(cronMatches(cron, at("2026-10-01T00:00"))); // Thursday the 1st
  assert.ok(cronMatches(cron, at("2026-10-19T00:00"))); // a Monday
  assert.ok(!cronMatches(cron, at("2026-10-21T00:00")));
});

test("bad expressions throw", () => {
  for (const bad of [
    "* * * *",
    "60 * * * *",
    "* * * * MON",
    "5-1 * * * *",
    "*/0 * * * *",
    "@reboot",
    "@foo",
    "@daily extra",
  ])
    assert.throws(() => parseCron(bad), bad);
});
