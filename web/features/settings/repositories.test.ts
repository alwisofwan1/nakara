import { describe, expect, it } from "vitest";
import { parseRepo, refusedAt, repoRows } from "./repositories";

describe("Add repository input", () => {
  const listed = ["acme/web", "acme/api"];

  it("shows nothing while empty", () => {
    expect(parseRepo("", listed)).toBeNull();
    expect(parseRepo("   ", listed)).toBeNull();
  });

  it("takes owner/name and a github.com URL", () => {
    expect(parseRepo(" acme/docs.site ", listed)).toEqual({
      repo: { owner: "acme", name: "docs.site" },
    });
    expect(parseRepo("https://github.com/acme/docs.git", listed)).toEqual({
      repo: { owner: "acme", name: "docs" },
    });
  });

  it("shows an error for anything else", () => {
    for (const input of ["acme", "acme/", "acme corp/web", "a/b/c", "acme/.."])
      expect(parseRepo(input, listed)).toEqual({
        error: "Enter a repository as owner/name, such as acme/web.",
      });
  });

  it("shows an error for a listed repository in any spelling", () => {
    expect(parseRepo("ACME/Web", listed)).toEqual({
      error: "ACME/Web is already a repository of this factory.",
    });
  });
});

describe("Repository rows", () => {
  it("marks a repository whose reach waits for approval", () => {
    const rows = repoRows(
      ["acme/web", "acme/docs"],
      ["repository acme/docs", "foreman · runner host"],
    );
    expect(rows.map((r) => r.pending)).toEqual([false, true]);
    expect(repoRows(["acme/web"], null)[0]?.pending).toBe(false);
  });

  it("can remove a repository only while another stays", () => {
    expect(
      repoRows(["acme/web", "acme/docs"], null).map((r) => r.removable),
    ).toEqual([true, true]);
    expect(repoRows(["acme/web"], null)[0]?.removable).toBe(false);
  });

  it("lists each repository's verify commands, none without", () => {
    const rows = repoRows(["acme/web", "acme/docs"], null, {
      "acme/web": ["npm ci", "npm test"],
    });
    expect(rows.map((r) => r.verify)).toEqual([["npm ci", "npm test"], []]);
  });
});

describe("Where a refusal shows", () => {
  it("under the input for an add, under its row for a remove", () => {
    const add = { add: { owner: "acme", name: "docs" } };
    const remove = { remove: "acme/web" };
    expect(refusedAt(add, "add")).toBe(true);
    expect(refusedAt(add, "acme/docs")).toBe(false);
    expect(refusedAt(remove, "acme/web")).toBe(true);
    expect(refusedAt(remove, "acme/api")).toBe(false);
    expect(refusedAt(remove, "add")).toBe(false);
    expect(refusedAt(undefined, "add")).toBe(false);
  });
});
