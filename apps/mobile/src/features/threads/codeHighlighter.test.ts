import { describe, expect, it } from "vite-plus/test";

import { highlightCodeSnippet } from "./codeHighlighter";

describe("highlightCodeSnippet", () => {
  it("resolves language aliases and returns syntax-colored tokens", async () => {
    const source = "const answer: number = 42;";
    const highlighted = await highlightCodeSnippet({
      code: source,
      language: "ts",
      theme: "dark",
    });

    expect(
      highlighted
        .flat()
        .map((token) => token.content)
        .join(""),
    ).toBe(source);
    expect(highlighted.flat().some((token) => token.color !== null)).toBe(true);
  });

  it("renders unknown languages as plain text", async () => {
    const highlighted = await highlightCodeSnippet({
      code: "a\nb",
      language: "not-a-language",
      theme: "light",
    });

    expect(highlighted.map((line) => line.map((token) => token.content).join(""))).toEqual([
      "a",
      "b",
    ]);
  });
});
