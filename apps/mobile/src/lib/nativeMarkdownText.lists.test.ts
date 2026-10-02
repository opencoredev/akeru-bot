import { describe, expect, it } from "vite-plus/test";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import { nativeMarkdownListItemBlocks } from "@akeru/mobile-markdown-text/markdown";

describe("nativeMarkdownListItemBlocks", () => {
  it("groups consecutive inline nodes into one paragraph block", () => {
    const item: MarkdownNode = {
      type: "list_item",
      children: [
        { type: "text", content: "Finding: " },
        { type: "bold", children: [{ type: "text", content: "important" }] },
        { type: "text", content: " details." },
        {
          type: "list",
          children: [
            {
              type: "list_item",
              children: [{ type: "text", content: "Nested" }],
            },
          ],
        },
        { type: "text", content: "Trailing prose." },
      ],
    };

    expect(nativeMarkdownListItemBlocks(item)).toEqual([
      {
        type: "paragraph",
        children: item.children?.slice(0, 3),
      },
      item.children?.[3],
      {
        type: "paragraph",
        children: [item.children?.[4]],
      },
    ]);
  });
});
