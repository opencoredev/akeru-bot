import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import type { NativeMarkdownDocumentChunk } from "./nativeMarkdownTextTypes";

export type { NativeMarkdownDocumentChunk, NativeMarkdownTextRun } from "./nativeMarkdownTextTypes";

export {
  decorateSkillRuns,
  nativeMarkdownTextRuns,
  nativeMarkdownWithPreservedSoftBreaks,
} from "./nativeMarkdownInlineRuns";

export {
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
} from "./nativeMarkdownDocumentRuns";

function containsRichBlock(node: MarkdownNode): boolean {
  if (
    node.type === "code_block" ||
    node.type === "blockquote" ||
    node.type === "table" ||
    node.type === "image" ||
    node.type === "horizontal_rule" ||
    node.type === "html_block" ||
    node.type === "math_block"
  ) {
    return true;
  }

  return (node.children ?? []).some(containsRichBlock);
}

export function nativeMarkdownDocumentChunks(
  document: MarkdownNode,
): ReadonlyArray<NativeMarkdownDocumentChunk> {
  const chunks: NativeMarkdownDocumentChunk[] = [];
  let selectableNodes: MarkdownNode[] = [];

  const flushSelectable = () => {
    if (selectableNodes.length === 0) {
      return;
    }

    const first = selectableNodes[0];
    const last = selectableNodes.at(-1);
    chunks.push({
      kind: "selectable",
      key: `selectable:${first?.beg ?? "start"}:${last?.end ?? "end"}`,
      node: {
        type: "document",
        children: selectableNodes,
      },
    });
    selectableNodes = [];
  };

  for (const [index, child] of (document.children ?? []).entries()) {
    if (!containsRichBlock(child)) {
      selectableNodes.push(child);
      continue;
    }

    flushSelectable();
    chunks.push({
      kind: "rich",
      key: `rich:${child.type}:${child.beg ?? index}:${child.end ?? index}`,
      node: child,
    });
  }

  flushSelectable();

  return chunks;
}

function topLevelNodes(node: MarkdownNode): ReadonlyArray<MarkdownNode> {
  return node.type === "document" ? (node.children ?? []) : [node];
}

export function nativeMarkdownChunkSpacing(
  previous: NativeMarkdownDocumentChunk | undefined,
  current: NativeMarkdownDocumentChunk,
): number {
  if (!previous) {
    return 0;
  }

  const previousLast = topLevelNodes(previous.node).at(-1);
  const currentFirst = topLevelNodes(current.node)[0];

  if (currentFirst?.type === "heading") {
    return 20;
  }

  if (previousLast?.type === "heading") {
    return 10;
  }

  if (previousLast?.type === "list" && currentFirst?.type === "list") {
    return 12;
  }

  return 14;
}
