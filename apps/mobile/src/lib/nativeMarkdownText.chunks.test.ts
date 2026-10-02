import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
} from "@akeru/mobile-markdown-text/markdown";

describe("nativeMarkdownDocumentChunks", () => {
  it("renders plain blockquotes as rich blocks so their marker spans wrapped lines", () => {
    const blockquote: MarkdownNode = {
      type: "blockquote",
      beg: 0,
      end: 120,
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              content:
                "Persistent random per-result keys are the strongest design, even when this text wraps.",
            },
          ],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentChunks({
        type: "document",
        children: [blockquote],
      }),
    ).toEqual([
      {
        kind: "rich",
        key: "rich:blockquote:0:120",
        node: blockquote,
      },
    ]);
  });

  it("keeps headings and plain lists in one selectable document", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 2,
          children: [{ type: "text", content: "Tasks" }],
        },
        {
          type: "list",
          children: [
            {
              type: "task_list_item",
              checked: true,
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Completed" }],
                },
              ],
            },
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Parent" }],
                },
                {
                  type: "list",
                  children: [
                    {
                      type: "list_item",
                      children: [
                        {
                          type: "paragraph",
                          children: [{ type: "text", content: "Nested" }],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(
      nativeMarkdownDocumentRuns(chunks[0]?.node ?? document)
        .map((run) => run.text)
        .join(""),
    ).toBe("Tasks\n\n☑︎\tCompleted\n•\tParent\n◦\tNested");
  });

  it("aligns ordered markers while keeping the list in one selectable string", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "list",
          ordered: true,
          start: 9,
          children: [
            {
              type: "list_item",
              children: [{ type: "text", content: "Ninth" }],
            },
            {
              type: "list_item",
              children: [{ type: "text", content: "Tenth" }],
            },
          ],
        },
      ],
    };

    expect(
      nativeMarkdownDocumentRuns(document)
        .map((run) => run.text)
        .join(""),
    ).toBe("\u20079.\tNinth\n10.\tTenth");
  });

  it("keeps prose selectable while exposing rich AST blocks", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 1,
          beg: 0,
          end: 9,
          children: [{ type: "text", content: "Install" }],
        },
        {
          type: "code_block",
          language: "bash",
          beg: 11,
          end: 35,
          children: [{ type: "text", content: "pnpm install\n" }],
        },
        {
          type: "paragraph",
          beg: 37,
          end: 42,
          children: [{ type: "text", content: "Done." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(chunks[1]).toEqual({
      kind: "rich",
      key: "rich:code_block:11:35",
      node: document.children?.[1],
    });
    expect(chunks[2]).toMatchObject({ kind: "selectable" });
  });

  it("keeps a list containing fenced code as one rich AST container", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "list",
          beg: 0,
          end: 45,
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Install" }],
                },
                {
                  type: "code_block",
                  language: "bash",
                  children: [{ type: "text", content: "pnpm install\n" }],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(nativeMarkdownDocumentChunks(document)).toEqual([
      {
        kind: "rich",
        key: "rich:list:0:45",
        node: document.children?.[0],
      },
    ]);
  });

  it("keeps surrounding prose selectable when rich nodes have no source offsets", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "heading",
          level: 1,
          children: [{ type: "text", content: "Before" }],
        },
        { type: "horizontal_rule" },
        {
          type: "paragraph",
          children: [{ type: "text", content: "After." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(chunks[1]).toEqual({
      kind: "rich",
      key: "rich:horizontal_rule:1:1",
      node: document.children?.[1],
    });
    expect(chunks[2]).toMatchObject({ kind: "selectable" });
  });

  it("keeps offset-free structural lists isolated without promoting the whole document", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Before." }],
        },
        {
          type: "list",
          ordered: true,
          children: [
            {
              type: "list_item",
              children: [
                {
                  type: "paragraph",
                  children: [{ type: "text", content: "Install" }],
                },
                {
                  type: "code_block",
                  language: "bash",
                  children: [{ type: "text", content: "pnpm install\n" }],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "After." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toMatchObject({ kind: "selectable" });
    expect(chunks[1]).toEqual({
      kind: "rich",
      key: "rich:list:1:1",
      node: document.children?.[1],
    });
    expect(chunks[2]).toMatchObject({ kind: "selectable" });
  });

  it("never collapses a rich subtree into a second markdown parsing pass", () => {
    const document: MarkdownNode = {
      type: "document",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", content: "Before." }],
        },
        {
          type: "blockquote",
          children: [
            {
              type: "list",
              children: [
                {
                  type: "list_item",
                  children: [
                    { type: "text", content: "Run this" },
                    {
                      type: "code_block",
                      language: "sh",
                      children: [{ type: "text", content: "vp check\n" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [{ type: "text", content: "After." }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks(document);
    expect(chunks.map((chunk) => chunk.kind)).toEqual(["selectable", "rich", "selectable"]);
    expect(chunks[1]).toMatchObject({
      kind: "rich",
      node: { type: "blockquote" },
    });
  });

  it("keeps a plain list in one selectable native text container", () => {
    const list: MarkdownNode = {
      type: "list",
      ordered: false,
      children: [
        {
          type: "list_item",
          children: [{ type: "text", content: "First" }],
        },
      ],
    };

    const chunks = nativeMarkdownDocumentChunks({
      type: "document",
      children: [list],
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      kind: "selectable",
      node: { type: "document", children: [list] },
    });
  });

  it("separates sections more than related rich blocks", () => {
    const headingChunk = {
      kind: "selectable" as const,
      key: "heading",
      node: {
        type: "document",
        children: [
          {
            type: "heading",
            level: 2,
            children: [{ type: "text", content: "Section" }],
          },
        ],
      } satisfies MarkdownNode,
    };

    const firstList = {
      kind: "rich" as const,
      key: "list-1",
      node: { type: "list", children: [] } satisfies MarkdownNode,
    };

    const secondList = {
      kind: "rich" as const,
      key: "list-2",
      node: { type: "list", children: [] } satisfies MarkdownNode,
    };

    expect(nativeMarkdownChunkSpacing(undefined, headingChunk)).toBe(0);
    expect(nativeMarkdownChunkSpacing(headingChunk, firstList)).toBe(10);
    expect(nativeMarkdownChunkSpacing(firstList, secondList)).toBe(12);
    expect(nativeMarkdownChunkSpacing(firstList, headingChunk)).toBe(20);
  });
});
