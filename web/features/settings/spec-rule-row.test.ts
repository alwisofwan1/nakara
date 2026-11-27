import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SpecRuleRow } from "./spec-rule-row";

// The API module reads the page's runtime config; rendering never saves.
vi.mock("../../lib/api", () => ({ saveLimits: vi.fn() }));

const WARNING = "has no spec agent, so no Spec can be written";

const row = (
  rule: "always" | "when_asked" | "never",
  specAgent: boolean | null,
) =>
  renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SpecRuleRow, { slug: "harbor", rule, specAgent }),
    ),
  );

describe("Spec rule row", () => {
  it("warns when always is saved and the definition has no spec agent", () => {
    const html = row("always", false);
    expect(html).toContain('role="note"');
    expect(html).toContain(WARNING);
  });

  it.each([
    ["always", true],
    ["always", null],
    ["when_asked", false],
    ["never", false],
  ] as const)("does not warn for %s with specAgent %s", (rule, specAgent) => {
    const html = row(rule, specAgent);
    expect(html).toContain("Spec before code");
    expect(html).not.toContain(WARNING);
  });
});
