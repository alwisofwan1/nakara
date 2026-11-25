import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff";

const diff = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,3 +1,3 @@
 const a = 1;
-const color = "red";
+const color = "blue";
 export { a };
diff --git a/gen/out.txt b/gen/out.txt
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/gen/out.txt
@@ -0,0 +1 @@
+--- generated
\\ No newline at end of file
diff --git a/old name.md b/new name.md
similarity 90%
rename from old name.md
rename to new name.md
diff --git a/logo.png b/logo.png
deleted file mode 100644
index 4444444..0000000
Binary files a/logo.png and /dev/null differ
`;

describe("parseDiff", () => {
  it("splits a git diff into files with their status and lines", () => {
    const files = parseDiff(diff);
    expect(
      files.map(({ path, from, status, binary }) => ({
        path,
        from,
        status,
        binary,
      })),
    ).toEqual([
      { path: "src/app.ts", from: null, status: "modified", binary: false },
      { path: "gen/out.txt", from: null, status: "added", binary: false },
      {
        path: "new name.md",
        from: "old name.md",
        status: "renamed",
        binary: false,
      },
      { path: "logo.png", from: null, status: "deleted", binary: true },
    ]);
    expect(files[0]?.lines).toEqual([
      { kind: "hunk", text: "@@ -1,3 +1,3 @@" },
      { kind: "context", text: " const a = 1;" },
      { kind: "del", text: '-const color = "red";' },
      { kind: "add", text: '+const color = "blue";' },
      { kind: "context", text: " export { a };" },
    ]);
    // A hunk line that looks like a header stays a line.
    expect(files[1]?.lines.at(-1)).toEqual({
      kind: "add",
      text: "+--- generated",
    });
    expect(files[2]?.lines).toEqual([]);
  });

  it("reads quoted paths and returns nothing for an empty diff", () => {
    expect(parseDiff("")).toEqual([]);
    const [file] = parseDiff(
      'diff --git "a/tab\\there" "b/tab\\there"\n--- "a/tab\\there"\n+++ "b/tab\\there"\n@@ -1 +1 @@\n-x\n+y\n',
    );
    expect(file?.path).toBe("tab\there");
  });
  it("reads paths with spaces, which git ends with a tab on ---/+++ lines", () => {
    const files = parseDiff(
      [
        "diff --git a/a b.txt b/a b.txt",
        "index 1111111..2222222 100644",
        "--- a/a b.txt\t",
        "+++ b/a b.txt\t",
        "@@ -1 +1,2 @@",
        " 1",
        "+3",
        // A deleted file whose path contains " b/": the header splits it wrongly.
        "diff --git a/x b/y.txt b/x b/y.txt",
        "deleted file mode 100644",
        "index 0cfbf08..0000000",
        "--- a/x b/y.txt\t",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-2",
        "",
      ].join("\n"),
    );
    expect(files.map(({ path, status }) => ({ path, status }))).toEqual([
      { path: "a b.txt", status: "modified" },
      { path: "x b/y.txt", status: "deleted" },
    ]);
    expect(files[1]?.lines.at(-1)).toEqual({ kind: "del", text: "-2" });
  });
});
