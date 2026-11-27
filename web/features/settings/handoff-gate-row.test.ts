import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  HandoffGateRow,
  reviewWaitsOnOperator,
  verificationUnreachable,
} from "./handoff-gate-row";

// The API module reads the page's runtime config; rendering never saves.
vi.mock("../../lib/api", () => ({
  factorySettingsQuery: vi.fn(),
  saveLimits: vi.fn(),
}));
vi.mock("../../app/toast", () => ({ useToast: () => vi.fn() }));

const row = (
  checks: ("review" | "verification")[],
  { maxReviews = 2, verifyAgent = true as boolean | null } = {},
) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(HandoffGateRow, {
        slug: "harbor",
        checks,
        maxReviews,
        verifyAgent,
      }),
    ),
  );

const NO_VERIFY_AGENT = "has no verify agent, so no Verification can pass";
const ONE_REVIEW =
  "a review that asks for changes leaves the Work Item waiting for you";
const ONE_REVIEW_WAY_OUT =
  "you review and merge the pull request yourself, or cancel the Work Item. Raising the review limit applies only to new Work Items, not to one already waiting.";

/** Each switch's label and whether it is on and locked, in order. */
const switches = (html: string) =>
  [...html.matchAll(/<label[^>]*>(.*?)<\/label>/g)].map(([, label = ""]) => ({
    label: label.replace(/<[^>]+>/g, "").trim(),
    on: /checked=""/.test(label),
    locked: /disabled=""/.test(label),
  }));

describe("Handoff Gate row", () => {
  it("shows CI on and locked, and the added checks off when the factory added none", () => {
    expect(switches(row([]))).toEqual([
      { label: "CI passes (always on)", on: true, locked: true },
      { label: "Review accepted", on: false, locked: false },
      { label: "Verification passed", on: false, locked: false },
    ]);
  });

  it("shows the checks the factory added as on", () => {
    expect(switches(row(["verification"])).map((s) => s.on)).toEqual([
      true,
      false,
      true,
    ]);
    expect(row([])).toContain(
      "The work is always pushed and CI always passes. A factory can add checks; it cannot remove those.",
    );
  });

  it("warns under Verification passed when it is on and the definition has no verify agent", () => {
    const html = row(["verification"], { verifyAgent: false });
    expect(html).toContain(NO_VERIFY_AGENT);
    expect(html).toContain('role="note"');
    // The warning sits under its own switch, before the closing note.
    expect(html.indexOf(NO_VERIFY_AGENT)).toBeGreaterThan(
      html.indexOf("Verification passed"),
    );
  });

  it.each([
    [[], false],
    [["verification"], true],
    [["verification"], null],
  ] as const)(
    "does not warn about the verify agent for checks %j with verifyAgent %s",
    (checks, verifyAgent) => {
      expect(row([...checks], { verifyAgent })).not.toContain(NO_VERIFY_AGENT);
    },
  );

  it("hints under Review accepted when it is on and the review limit is 1", () => {
    const html = row(["review"], { maxReviews: 1 });
    expect(html).toContain(ONE_REVIEW);
    // The item copied its review limit: raising the factory's does not free it.
    expect(html).toContain(ONE_REVIEW_WAY_OUT);
    expect(html).not.toContain("to let the Foreman review again");
    expect(html.indexOf(ONE_REVIEW)).toBeGreaterThan(
      html.indexOf("Review accepted"),
    );
    expect(html.indexOf(ONE_REVIEW)).toBeLessThan(
      html.indexOf("Verification passed"),
    );
  });

  it.each([
    [[], 1],
    [["review"], 2],
  ] as const)(
    "does not hint about the review limit for checks %j with limit %i",
    (checks, maxReviews) => {
      expect(row([...checks], { maxReviews })).not.toContain(ONE_REVIEW);
    },
  );

  it("decides both notes with pure conditions", () => {
    expect(verificationUnreachable(true, false)).toBe(true);
    expect(verificationUnreachable(true, true)).toBe(false);
    expect(verificationUnreachable(true, null)).toBe(false);
    expect(verificationUnreachable(false, false)).toBe(false);
    expect(reviewWaitsOnOperator(true, 1)).toBe(true);
    expect(reviewWaitsOnOperator(true, 2)).toBe(false);
    expect(reviewWaitsOnOperator(false, 1)).toBe(false);
  });
});
