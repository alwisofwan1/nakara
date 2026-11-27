import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HandoffGateRow } from "./handoff-gate-row";

// The API module reads the page's runtime config; rendering never saves.
vi.mock("../../lib/api", () => ({
  factorySettingsQuery: vi.fn(),
  saveLimits: vi.fn(),
}));
vi.mock("../../app/toast", () => ({ useToast: () => vi.fn() }));

const row = (checks: ("review" | "verification")[]) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(HandoffGateRow, { slug: "harbor", checks }),
    ),
  );

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
});
