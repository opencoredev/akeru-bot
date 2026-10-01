import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import {
  nativeMarkdownTextRuns,
  nativeMarkdownWithPreservedSoftBreaks,
} from "@akeru/mobile-markdown-text/markdown";

describe("nativeMarkdownTextRuns", () => {
  it("preserves inline emphasis and code styles", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "plain " },
        { type: "bold", children: [{ type: "text", content: "bold" }] },
        { type: "text", content: " " },
        { type: "code_inline", content: "const value = 1" },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      { text: "plain " },
      { text: "bold", bold: true },
      { text: " " },
      { text: "const value = 1", code: true },
    ]);
  });

  it("normalizes external and file links for native presentation", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "link",
          href: "https://example.com/docs",
          children: [{ type: "text", content: "Docs" }],
        },
        { type: "text", content: " " },
        {
          type: "link",
          href: "file:///repo/README.md#L12",
          children: [{ type: "text", content: "ignored label" }],
        },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      {
        text: "Docs",
        href: "https://example.com/docs",
        externalHost: "example.com",
      },
      { text: " " },
      {
        text: "README.md:12",
        href: "file:///repo/README.md#L12",
        fileIcon: "readme",
      },
    ]);
  });

  it("keeps hard breaks and collapses soft breaks", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "first" },
        { type: "soft_break" },
        { type: "text", content: "second" },
        { type: "line_break" },
        { type: "text", content: "third" },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([{ text: "first second\nthird" }]);
  });

  it("can preserve soft breaks for authored user messages", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "first" },
        { type: "soft_break" },
        { type: "text", content: "second" },
      ],
    };

    expect(nativeMarkdownTextRuns(nativeMarkdownWithPreservedSoftBreaks(node))).toEqual([
      { text: "first\nsecond" },
    ]);
  });

  it("normalizes common inline HTML and entities", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        { type: "text", content: "Less than: &lt; " },
        { type: "html_inline", content: "<kbd>" },
        { type: "text", content: "⌘" },
        { type: "html_inline", content: "</kbd>" },
        { type: "html_inline", content: "<br />" },
        { type: "html_inline", content: "<mark>highlighted</mark>" },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([{ text: "Less than: < ⌘\nhighlighted" }]);
  });

  it("normalizes double-encoded entities and inline tags emitted as text", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "text",
          content:
            "Keyboard: <kbd>⌘</kbd> + <kbd>K</kbd>; Less than: &amp;lt;; Greater than: &amp;gt;",
        },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      { text: "Keyboard: ⌘ + K; Less than: <; Greater than: >" },
    ]);
  });

  it.each([
    ["&#128512;", "😀"],
    ["&#x1f680;", "🚀"],
    ["&#9999999999;", "&#9999999999;"],
    ["&#x110000;", "&#x110000;"],
    ["&amp;#9999999999;", "&#9999999999;"],
    ["&amp;#x110000;", "&#x110000;"],
  ])("normalizes numeric entity %s without throwing", (content, expected) => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [{ type: "text", content }],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([{ text: expected }]);
  });

  it("reads inline content from nested text nodes", () => {
    const node: MarkdownNode = {
      type: "paragraph",
      children: [
        {
          type: "text",
          children: [{ type: "text", content: "Plain text" }],
        },
        { type: "text", content: " and " },
        {
          type: "code_inline",
          children: [{ type: "text", content: "inline code" }],
        },
      ],
    };

    expect(nativeMarkdownTextRuns(node)).toEqual([
      { text: "Plain text and " },
      { text: "inline code", code: true },
    ]);
  });
});
