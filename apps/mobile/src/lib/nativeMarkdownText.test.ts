import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { nativeMarkdownDocumentRuns } from "@akeru/mobile-markdown-text/markdown";

describe("nativeMarkdownDocumentRuns", () => {
  it("decorates known skill references as selectable skill links", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $ui for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [{ name: "ui", displayName: "UI" }])).toEqual([
      { text: "Use ", role: "body" },
      {
        text: "$ui",
        role: "body",
        skillName: "ui",
        skillLabel: "UI",
      },
      { text: " for this.", role: "body" },
    ]);
  });

  it("decorates known skill references inside blockquotes", () => {
    const node: MarkdownNode = {
      type: "blockquote",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $ui for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [{ name: "ui", displayName: "UI" }])).toContainEqual({
      text: "$ui",
      role: "body",
      skillName: "ui",
      skillLabel: "UI",
    });
  });

  it("leaves unknown skill-like text unchanged", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Use $unknown for this." }],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node, [])).toEqual([
      { text: "Use $unknown for this.", role: "body" },
    ]);
  });

  it("keeps headings, paragraphs, and lists in one continuous document", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 1,
          children: [{ type: "text", content: "Header One" }],
        },
        {
          type: "paragraph",
          children: [
            { type: "text", content: "A paragraph with " },
            { type: "bold", children: [{ type: "text", content: "bold text" }] },
            { type: "text", content: "." },
          ],
        },
        {
          type: "list",
          ordered: false,
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "First item" }],
                },
              ],
            },
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Second item" }],
                },
              ],
            },
          ],
        },
      ],
    };

    const runs = nativeMarkdownDocumentRuns(node);
    expect(runs.map((run) => run.text).join("")).toBe(
      "Header One\n\nA paragraph with bold text.\n\n•\tFirst item\n•\tSecond item",
    );
    expect(runs).toContainEqual({
      text: "Header One\n",
      role: "heading",
      headingLevel: 1,
    });
    expect(runs).toContainEqual({
      text: "bold text",
      bold: true,
      role: "body",
    });
    expect(runs).toContainEqual({
      text: "•\t",
      role: "list-marker",
      depth: 1,
      firstLineHeadIndent: 0,
      headIndent: 24,
      paragraphSpacing: 2,
    });
  });

  it("uses distinct section, heading-content, and body spacing", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Intro" }],
        },
        {
          type: "heading",
          level: 2,
          children: [{ type: "text", content: "Section" }],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "First paragraph" }],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "Second paragraph" }],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentRuns(node)
        .filter((run) => run.role === "spacer")
        .map((run) => run.spacing),
    ).toEqual([20, 10, 12]);
  });

  it("renders tight list items whose inline nodes are direct children", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "list",
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "bold",
                  children: [{ type: "text", content: "Finding:" }],
                },
                { type: "text", content: " details with " },
                { type: "code_inline", content: "inline code" },
                { type: "text", content: "." },
              ],
            },
          ],
        },
      ],
    };

    expect(nativeMarkdownDocumentRuns(node)).toEqual([
      {
        text: "•\t",
        role: "list-marker",
        depth: 1,
        firstLineHeadIndent: 0,
        headIndent: 24,
        paragraphSpacing: 2,
      },
      { text: "Finding:", bold: true, role: "body", depth: 1 },
      { text: " details with ", role: "body", depth: 1 },
      { text: "inline code", code: true, role: "body", depth: 1 },
      { text: ".", role: "body", depth: 1 },
    ]);
  });

  it("preserves quotes and fenced code in document runs", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "blockquote",
          children: [
            {
              type: "paragraph",
              children: [{ type: "text", content: "Read this" }],
            },
          ],
        },
        {
          type: "code_block",
          language: "ts",
          content: "const answer = 42;",
        },
      ],
    };

    const runs = nativeMarkdownDocumentRuns(node);
    expect(runs.map((run) => run.text).join("")).toBe("│\u00a0Read this\n\nTS\nconst answer = 42;");
    expect(runs).toContainEqual({
      text: "const answer = 42;",
      code: true,
      role: "code-block",
    });
  });

  it("reads fenced code content from child text nodes", () => {
    const node: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "code_block",
          language: "bash",
          children: [{ type: "text", content: "pnpm install\n" }],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentRuns(node)
        .map((run) => run.text)
        .join(""),
    ).toBe("BASH\npnpm install");
  });
});
