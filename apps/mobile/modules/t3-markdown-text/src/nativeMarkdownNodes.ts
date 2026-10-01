import type { MarkdownNode } from "react-native-nitro-markdown/headless";

export function nodeKey(node: MarkdownNode, index: number): string {
  return `${node.type}:${node.beg ?? index}:${node.end ?? index}`;
}

export function nodeText(node: MarkdownNode): string {
  if (node.content !== undefined) {
    return node.content;
  }
  return (node.children ?? []).map(nodeText).join("");
}

export function documentFor(node: MarkdownNode): MarkdownNode {
  return node.type === "document" ? node : { type: "document", children: [node] };
}
