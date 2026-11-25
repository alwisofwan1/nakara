import { describe, expect, it } from "vitest";
import { automationPrefill, prefillValues } from "./prefill";

describe("duplicate prefill", () => {
  const options = {
    repositories: ["acme/widgets", "acme/gadgets"],
    automations: [{ name: "nakara-manual" }, { name: "nightly" }],
  };
  const item = {
    title: "Retry failed work items",
    request: "Offer **Retry** next to Cancel.",
    repo: "acme/gadgets",
    automation: "nightly",
  };

  it("copies the title, request, repository and automation", () => {
    expect(prefillValues(item, options)).toEqual(item);
  });
  it("keeps an item without a repository or automation that way", () => {
    expect(
      prefillValues({ ...item, repo: null, automation: null }, options),
    ).toEqual({ ...item, repo: "", automation: "" });
  });
  it("starts Run now for an event-triggered automation on that automation", () => {
    expect(prefillValues(automationPrefill("nightly"), options)).toEqual({
      title: "",
      request: "",
      repo: "",
      automation: "nightly",
    });
  });
  it("drops a repository or automation the definition no longer has", () => {
    expect(
      prefillValues(
        { ...item, repo: "acme/gone", automation: "removed" },
        options,
      ),
    ).toEqual({ ...item, repo: "", automation: "" });
  });
});
