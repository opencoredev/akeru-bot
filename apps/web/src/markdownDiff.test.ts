import { describe, expect, it } from "vite-plus/test";

import { parseMarkdownDiff } from "./markdownDiff";

const GIT_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,3 @@",
  " import { run } from './run';",
  "-run(1);",
  "+run(2);",
  "+run(3);",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("parseMarkdownDiff", () => {
  it("classifies git diff lines and counts changes", () => {
    const parsed = parseMarkdownDiff(GIT_DIFF);
    expect(parsed.lines.map((line) => line.kind)).toEqual([
      "meta",
      "meta",
      "meta",
      "meta",
      "hunk",
      "context",
      "remove",
      "add",
      "add",
      "meta",
    ]);
    expect(parsed).toMatchObject({ additions: 2, deletions: 1, files: ["src/app.ts"] });
  });

  it("does not count file headers as changes", () => {
    const parsed = parseMarkdownDiff("--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n");
    expect(parsed).toMatchObject({ additions: 1, deletions: 1, files: ["a.ts"] });
  });

  it("names deleted files from the old path", () => {
    expect(parseMarkdownDiff("--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n").files).toEqual([
      "gone.ts",
    ]);
  });

  it("lists every file in a multi-file diff", () => {
    const parsed = parseMarkdownDiff(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n",
    );
    expect(parsed.files).toEqual(["a.ts", "b.ts"]);
    expect(parsed).toMatchObject({ additions: 2, deletions: 2 });
  });

  it("treats a removed line that starts with dashes inside a hunk as a removal", () => {
    const parsed = parseMarkdownDiff("@@ -1,2 +1 @@\n--- a heading rule\n keep\n");
    expect(parsed.lines.map((line) => line.kind)).toEqual(["hunk", "remove", "context"]);
  });

  it("counts a --- and +++ change pair inside a hunk as a removal and an addition", () => {
    const parsed = parseMarkdownDiff(
      "@@ -1,2 +1,2 @@\n--- old implementation\n+++ new implementation\n",
    );
    expect(parsed.lines.map((line) => line.kind)).toEqual(["hunk", "remove", "add"]);
    expect(parsed).toMatchObject({ additions: 1, deletions: 1, files: [] });
  });

  it("reads the next file header once a hunk's ranges are used up", () => {
    const parsed = parseMarkdownDiff(
      "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n--- a\n+++ b\n--- a/b.ts\n+++ b/b.ts\n@@ -1 +1 @@\n-c\n+d\n",
    );
    expect(parsed.lines.map((line) => line.kind)).toEqual([
      "meta",
      "meta",
      "hunk",
      "remove",
      "add",
      "meta",
      "meta",
      "hunk",
      "remove",
      "add",
    ]);
    expect(parsed).toMatchObject({ additions: 2, deletions: 2, files: ["a.ts", "b.ts"] });
  });

  it("keeps a hunk without ranges open until the next git header", () => {
    const parsed = parseMarkdownDiff("@@\n--- old\n+++ new\n");
    expect(parsed.lines.map((line) => line.kind)).toEqual(["hunk", "remove", "add"]);
    expect(parsed).toMatchObject({ additions: 1, deletions: 1 });
  });

  it("reads hunk-less snippets as plain additions and removals", () => {
    const parsed = parseMarkdownDiff("-old\n+new\n same\n");
    expect(parsed.lines.map((line) => line.kind)).toEqual(["remove", "add", "context"]);
    expect(parsed.files).toEqual([]);
  });

  it("classifies every complete line of a streaming prefix like the settled diff", () => {
    const settled = parseMarkdownDiff(GIT_DIFF);
    const rawLines = GIT_DIFF.split("\n");
    for (let count = 1; count < rawLines.length; count += 1) {
      const prefix = `${rawLines.slice(0, count).join("\n")}\n`;
      const partial = parseMarkdownDiff(prefix);
      expect(partial.lines, prefix).toEqual(settled.lines.slice(0, partial.lines.length));
      expect(partial.lines.length).toBe(count);
    }
  });

  it("parses the same text identically every time", () => {
    expect(parseMarkdownDiff(GIT_DIFF)).toEqual(parseMarkdownDiff(GIT_DIFF));
  });
});
