import { describe, expect, it } from "vite-plus/test";

import { stabilizeStreamingMarkdown } from "./markdownStreaming.js";

const SETTLED = [
  "Here is the plan.",
  "",
  "| File | State |",
  "| --- | --- |",
  "| src/a.ts | Ready |",
  "",
  "- [x] Render table",
  "- [ ] Review diff",
  "",
  "```diff",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1 +1 @@",
  "-plain",
  "+rich",
  "```",
  "",
  "Heading",
  "-------",
  "",
  "Done.",
  "",
].join("\n");

describe("stabilizeStreamingMarkdown", () => {
  it("leaves complete text unchanged", () => {
    expect(stabilizeStreamingMarkdown(SETTLED)).toBe(SETTLED);
    expect(stabilizeStreamingMarkdown("Plain prose that is still stream")).toBe(
      "Plain prose that is still stream",
    );
    expect(stabilizeStreamingMarkdown("")).toBe("");
  });

  it.each([
    ["a lone backtick", "Intro\n`"],
    ["a partial fence opener", "Intro\n``"],
    ["a fence opener without its newline", "Intro\n```"],
    ["a fence opener with a partial language", "Intro\n```ty"],
    ["a tilde fence opener", "Intro\n~~~py"],
  ])("withholds %s", (_label, text) => {
    expect(stabilizeStreamingMarkdown(text)).toBe("Intro\n");
  });

  it("keeps inline code that cannot become a fence", () => {
    expect(stabilizeStreamingMarkdown("Run `vp test` now")).toBe("Run `vp test` now");
    expect(stabilizeStreamingMarkdown("`vp test` first")).toBe("`vp test` first");
  });

  it("withholds a partial fence closer inside an open fence", () => {
    expect(stabilizeStreamingMarkdown("```ts\nconst a = 1;\n``")).toBe("```ts\nconst a = 1;\n");
    expect(stabilizeStreamingMarkdown("```ts\nconst a = 1;\n```")).toBe("```ts\nconst a = 1;\n");
  });

  it("streams code lines inside an open fence untouched", () => {
    expect(stabilizeStreamingMarkdown("```ts\nconst a = 1;\n- [")).toBe("```ts\nconst a = 1;\n- [");
    expect(stabilizeStreamingMarkdown("```md\n| a | b |\n")).toBe("```md\n| a | b |\n");
  });

  it.each([
    ["a header row in flight", "Intro\n\n| File | Sta"],
    ["a complete header row", "Intro\n\n| File | State |\n"],
    ["a delimiter row in flight", "Intro\n\n| File | State |\n| --- | -"],
  ])("withholds a table before its delimiter row: %s", (_label, text) => {
    expect(stabilizeStreamingMarkdown(text)).toBe("Intro\n\n");
  });

  it("shows a table once its delimiter row is complete and holds the row in flight", () => {
    const head = "| File | State |\n| --- | --- |\n";
    expect(stabilizeStreamingMarkdown(head)).toBe(head);
    expect(stabilizeStreamingMarkdown(`${head}| src/a.ts | Re`)).toBe(head);
    expect(stabilizeStreamingMarkdown(`${head}| src/a.ts | Ready |\n`)).toBe(
      `${head}| src/a.ts | Ready |\n`,
    );
  });

  it.each([
    ["a bare list marker", "- [x] Done\n-"],
    ["an opening task bracket", "- [x] Done\n- ["],
    ["an unchecked marker without text", "- [x] Done\n- [ ]"],
    ["a checked marker without text", "- [x] Done\n- [x"],
    ["an ordered marker", "- [x] Done\n2."],
  ])("withholds %s", (_label, text) => {
    expect(stabilizeStreamingMarkdown(text)).toBe("- [x] Done\n");
  });

  it("withholds a setext underline that would turn the line above into a heading", () => {
    expect(stabilizeStreamingMarkdown("Almost done\n-")).toBe("Almost done\n");
    expect(stabilizeStreamingMarkdown("Almost done\n==")).toBe("Almost done\n");
  });

  it("only ever returns a prefix of the settled text", () => {
    for (let length = 0; length <= SETTLED.length; length += 1) {
      const partial = SETTLED.slice(0, length);
      const stable = stabilizeStreamingMarkdown(partial);
      expect(partial.startsWith(stable), JSON.stringify(partial)).toBe(true);
    }
  });
});
