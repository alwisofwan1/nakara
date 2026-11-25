import { describe, expect, it } from "vitest";
import {
  creationBody,
  LAST_STEP,
  matchRepos,
  wizardSearch,
} from "./wizard-state";

describe("wizard search", () => {
  it("keeps the step and every choice", () => {
    expect(
      wizardSearch({
        step: "2",
        owner: "acme",
        repos: ["acme/widgets", "acme/gadgets", "acme/widgets"],
        name: "Web Shop",
        description: "Sells widgets.",
        color: "#0E7490",
      }),
    ).toEqual({
      step: 2,
      owner: "acme",
      repos: ["acme/widgets", "acme/gadgets"],
      name: "Web Shop",
      description: "Sells widgets.",
      color: "#0e7490",
    });
  });
  it("starts at step 1 and drops malformed choices", () => {
    expect(
      wizardSearch({
        step: "two",
        owner: "-acme",
        repos: ["not a repo", 4],
        name: "",
        color: "red",
      }),
    ).toEqual({
      step: 1,
      owner: undefined,
      repos: undefined,
      name: undefined,
      description: undefined,
      color: undefined,
    });
  });
  it("clamps the step to the steps that exist", () => {
    expect(wizardSearch({ step: 9 }).step).toBe(LAST_STEP);
    expect(wizardSearch({ step: 0 }).step).toBe(1);
  });
});

describe("steps 3 to 6", () => {
  const chosen = wizardSearch({
    step: 6,
    owner: "acme",
    repos: ["acme/shop", "acme/shop-api"],
    name: " Web Shop ",
    template: "warp",
    example: "01-bug-fix",
    location: "repo",
    defRepo: "acme/shop-api",
    folder: "ops/factory",
    handle: "shop",
    off: ["triage", "implement", "nope"],
    harness: { review: "codex", spec: "gpt" },
    // Telegram routes to the default factory only; the wizard has no toggle.
    telegram: true,
    cron: "@daily",
    job: "00000000-0000-4000-8000-000000000000",
  });
  it("keeps the choices; implement and the foreman can't be turned off", () => {
    expect(chosen).toMatchObject({
      step: 6,
      template: "warp",
      example: "01-bug-fix",
      location: "repo",
      defRepo: "acme/shop-api",
      folder: "ops/factory",
      handle: "shop",
      off: ["triage"],
      harness: { review: "codex" },
      cron: "@daily",
      job: "00000000-0000-4000-8000-000000000000",
    });
    expect(chosen.github).toBeUndefined();
    expect(chosen).not.toHaveProperty("telegram");
    expect(wizardSearch({ cron: false, job: "nope" })).toMatchObject({
      cron: false,
      job: undefined,
    });
  });
  it("builds what Create sends; unchanged intake sources are left out", () => {
    expect(creationBody(chosen)).toEqual({
      name: "Web Shop",
      handle: "shop",
      avatarColor: "#6d4aff",
      repositories: ["acme/shop", "acme/shop-api"],
      template: { kind: "warp", example: "01-bug-fix" },
      location: { mode: "repo", repo: "acme/shop-api", folder: "ops/factory" },
      agents: { triage: { enabled: false }, review: { harness: "codex" } },
      intake: { schedule: { cron: "@daily" } },
    });
    expect(
      creationBody(
        wizardSearch({ repos: ["acme/shop"], name: "Shop", cron: false }),
      ),
    ).toEqual({
      name: "Shop",
      avatarColor: "#6d4aff",
      repositories: ["acme/shop"],
      template: { kind: "nakara" },
      location: { mode: "managed" },
      intake: { schedule: null },
    });
  });
  it("is incomplete without a name, repositories, or an import's folder", () => {
    expect(creationBody(wizardSearch({ repos: ["acme/shop"] }))).toBeNull();
    expect(creationBody(wizardSearch({ name: "Shop" }))).toBeNull();
    expect(
      creationBody(
        wizardSearch({
          repos: ["acme/shop"],
          name: "Shop",
          template: "import",
        }),
      ),
    ).toBeNull();
  });
});

describe("repository search", () => {
  const repos = [
    { repo: "acme/nakara" },
    { repo: "acme/nakara-docs" },
    { repo: "acme/widgets" },
  ];
  it("matches every word in owner/name, case-insensitively", () => {
    expect(matchRepos(repos, "Nakara")).toEqual(repos.slice(0, 2));
    expect(matchRepos(repos, "acme docs")).toEqual([repos[1]]);
    expect(matchRepos(repos, "  ")).toEqual(repos);
  });
});
