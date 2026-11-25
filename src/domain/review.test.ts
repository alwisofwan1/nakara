import assert from "node:assert/strict";
import { test } from "node:test";
import { reviewVerdict } from "./review.ts";

test("reviewVerdict reads the verdict a review report states", () => {
  for (const [report, verdict] of [
    ["Verdict: accepted\n\nNo findings.", "accepted"],
    [
      "**Verdict:** revision needed (2 unambiguous findings)",
      "revision_needed",
    ],
    ["## Verdict\n\nHuman decision needed: the API shape.", "human_decision"],
    ["Summary first.\n\nVerdict — **Accepted**", "accepted"],
    ["Verdict: changes requested", "revision_needed"],
    // The first verdict named after the word wins, not the mention of another.
    ["Verdict: revision needed; not accepted as is", "revision_needed"],
    // The stated verdict wins over a synonym earlier on the line.
    ["Verdict: tests passed, but revision needed", "revision_needed"],
    ["Verdict: approved", "accepted"],
    // Only a line that starts with Verdict states it, not a mention of the word.
    ["I will state my verdict below.\n\nVerdict: accepted", "accepted"],
    ["- **Verdict:** human decision needed", "human_decision"],
  ] as const)
    assert.equal(reviewVerdict(report), verdict, report);
});

test("reviewVerdict does not guess an unstated verdict", () => {
  for (const report of [
    null,
    "",
    "Looks good, accepted.",
    "Verdict: unclear, see below",
    "Verdict: not accepted",
    "Verdict: this is not approved yet",
    "The verdict is accepted.",
  ])
    assert.equal(reviewVerdict(report), null, String(report));
});
