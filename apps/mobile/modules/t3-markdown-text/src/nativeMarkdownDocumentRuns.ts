import type { MarkdownNode } from "react-native-nitro-markdown/headless";
import type { SelectableMarkdownSkill } from "./SelectableMarkdownText.types";
import type { NativeMarkdownTextRun } from "./nativeMarkdownTextTypes";
import {
  EMPTY_CONTEXT,
  type RunContext,
  appendNode,
  appendRun,
  decorateSkillRuns,
  inlineHtmlText,
  nodeTextContent,
} from "./nativeMarkdownInlineRuns";

function appendBlockTerminator(
  runs: NativeMarkdownTextRun[],
  context: RunContext,
): NativeMarkdownTextRun[] {
  return appendRun(runs, "\n", context);
}

function appendSpacer(runs: NativeMarkdownTextRun[], spacing: number): NativeMarkdownTextRun[] {
  return appendRun(runs, "\n", { ...EMPTY_CONTEXT, role: "spacer", spacing });
}

function appendInlineChildren(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  context: RunContext,
): NativeMarkdownTextRun[] {
  for (const child of node.children ?? []) {
    appendNode(runs, child, context);
  }

  return runs;
}

function isInlineNode(node: MarkdownNode): boolean {
  return (
    node.type === "text" ||
    node.type === "bold" ||
    node.type === "italic" ||
    node.type === "strikethrough" ||
    node.type === "link" ||
    node.type === "image" ||
    node.type === "code_inline" ||
    node.type === "math_inline" ||
    node.type === "html_inline" ||
    node.type === "soft_break" ||
    node.type === "line_break"
  );
}

export function nativeMarkdownListItemBlocks(node: MarkdownNode): ReadonlyArray<MarkdownNode> {
  const blocks: MarkdownNode[] = [];
  let inlineNodes: MarkdownNode[] = [];

  const flushInlineNodes = () => {
    if (inlineNodes.length === 0) {
      return;
    }

    blocks.push({ type: "paragraph", children: inlineNodes });
    inlineNodes = [];
  };

  for (const child of node.children ?? []) {
    if (isInlineNode(child)) {
      inlineNodes.push(child);
      continue;
    }

    flushInlineNodes();
    blocks.push(child);
  }

  flushInlineNodes();

  return blocks;
}

function appendListItem(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  marker: string,
  depth: number,
  markerColumnWidth: number,
): NativeMarkdownTextRun[] {
  const firstLineHeadIndent = Math.max(0, depth - 1) * 20;
  appendRun(runs, `${marker}\t`, {
    ...EMPTY_CONTEXT,
    role: "list-marker",
    depth,
    firstLineHeadIndent,
    headIndent: firstLineHeadIndent + markerColumnWidth,
    paragraphSpacing: 2,
  });

  const children = node.children ?? [];
  let wroteInlineContent = false;

  for (const child of children) {
    if (child.type === "paragraph") {
      appendInlineChildren(runs, child, {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
      wroteInlineContent = true;
      continue;
    }

    if (child.type === "list") {
      if (wroteInlineContent) {
        appendBlockTerminator(runs, {
          ...EMPTY_CONTEXT,
          role: "list-break",
          depth,
          spacing: 1,
        });
      }

      appendList(runs, child, depth + 1);
      wroteInlineContent = false;
      continue;
    }

    if (isInlineNode(child)) {
      appendNode(runs, child, {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
      wroteInlineContent = true;
      continue;
    }

    appendDocumentBlock(runs, child, depth);
    wroteInlineContent = true;
  }

  if (wroteInlineContent) {
    appendBlockTerminator(runs, {
      ...EMPTY_CONTEXT,
      role: "list-break",
      depth,
      spacing: depth === 1 ? 4 : 2,
    });
  }

  return runs;
}

function appendList(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  const ordered = node.ordered ?? false;
  const start = node.start ?? 1;
  const children = node.children ?? [];

  const markers = children.map((child, index) =>
    child.type === "task_list_item"
      ? child.checked
        ? "☑︎"
        : "☐︎"
      : ordered
        ? `${start + index}.`
        : depth % 3 === 2
          ? "◦"
          : depth % 3 === 0
            ? "▪︎"
            : "•",
  );

  const markerWidth = ordered
    ? Math.max(0, ...markers.map((marker) => Array.from(marker).length))
    : 0;

  for (const [index, child] of children.entries()) {
    const marker = markers[index] ?? "•";

    const alignedMarker =
      child.type === "task_list_item"
        ? marker
        : ordered
          ? `${"\u2007".repeat(Math.max(0, markerWidth - Array.from(marker).length))}${marker}`
          : marker;

    const markerColumnWidth =
      child.type === "task_list_item" ? 28 : ordered ? 10 + markerWidth * 8 : 24;

    appendListItem(runs, child, alignedMarker, depth, markerColumnWidth);
  }

  return runs;
}

function appendQuoteBlock(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  for (const [index, child] of (node.children ?? []).entries()) {
    if (index > 0) {
      appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
    }

    appendRun(runs, "│\u00a0", {
      ...EMPTY_CONTEXT,
      role: "quote-marker",
      depth,
    });

    if (child.type === "paragraph") {
      appendInlineChildren(runs, child, {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });
    } else {
      appendDocumentBlock(runs, child, depth);
    }
  }

  appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });

  return runs;
}

function appendTableRow(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  const cells = node.children ?? [];

  for (const [index, cell] of cells.entries()) {
    if (index > 0) {
      appendRun(runs, "\u00a0│\u00a0", {
        ...EMPTY_CONTEXT,
        role: "divider",
        depth,
      });
    }

    appendInlineChildren(runs, cell, {
      ...EMPTY_CONTEXT,
      role: "body",
      bold: cell.isHeader ?? false,
      depth,
    });
  }

  appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });

  return runs;
}

function appendTable(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth: number,
): NativeMarkdownTextRun[] {
  const visit = (child: MarkdownNode) => {
    if (child.type === "table_row") {
      appendTableRow(runs, child, depth);

      return;
    }

    for (const nested of child.children ?? []) {
      visit(nested);
    }
  };

  visit(node);

  return runs;
}

function appendDocumentBlock(
  runs: NativeMarkdownTextRun[],
  node: MarkdownNode,
  depth = 0,
): NativeMarkdownTextRun[] {
  switch (node.type) {
    case "document": {
      const children = node.children ?? [];

      for (const [index, child] of children.entries()) {
        if (index > 0) {
          const previous = children[index - 1];
          appendSpacer(
            runs,
            child.type === "heading" ? 20 : previous?.type === "heading" ? 10 : 12,
          );
        }

        appendDocumentBlock(runs, child, depth);
      }

      return runs;
    }

    case "heading": {
      const context: RunContext = {
        ...EMPTY_CONTEXT,
        role: "heading",
        headingLevel: node.level ?? 1,
        depth,
      };

      appendInlineChildren(runs, node, context);

      return appendBlockTerminator(runs, context);
    }

    case "paragraph": {
      const context: RunContext = { ...EMPTY_CONTEXT, role: "body", depth };
      appendInlineChildren(runs, node, context);

      return appendBlockTerminator(runs, context);
    }

    case "list":
      return appendList(runs, node, depth + 1);
    case "blockquote":
      return appendQuoteBlock(runs, node, depth);
    case "code_block": {
      if (node.language) {
        appendRun(runs, `${node.language.toUpperCase()}\n`, {
          ...EMPTY_CONTEXT,
          role: "code-language",
          code: true,
          depth,
        });
      }

      const content = nodeTextContent(node);
      appendRun(runs, content, {
        ...EMPTY_CONTEXT,
        role: "code-block",
        code: true,
        depth,
      });

      if (!content.endsWith("\n")) {
        appendBlockTerminator(runs, {
          ...EMPTY_CONTEXT,
          role: "code-block",
          code: true,
          depth,
        });
      }

      return runs;
    }

    case "horizontal_rule":
      appendRun(runs, "────────────────────────\n", {
        ...EMPTY_CONTEXT,
        role: "divider",
        depth,
      });

      return runs;
    case "table":
      return appendTable(runs, node, depth);
    case "html_block":
      appendRun(runs, inlineHtmlText(nodeTextContent(node)), {
        ...EMPTY_CONTEXT,
        role: "body",
        depth,
      });

      return appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
    case "math_block":
      appendRun(runs, nodeTextContent(node), { ...EMPTY_CONTEXT, role: "body", depth });

      return appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
    default:
      appendInlineChildren(runs, node, { ...EMPTY_CONTEXT, role: "body", depth });

      return appendBlockTerminator(runs, { ...EMPTY_CONTEXT, role: "body", depth });
  }
}

export function nativeMarkdownDocumentRuns(
  node: MarkdownNode,
  skills: ReadonlyArray<SelectableMarkdownSkill> = [],
): ReadonlyArray<NativeMarkdownTextRun> {
  const runs = appendDocumentBlock([], node);

  while (runs.length > 0) {
    const lastIndex = runs.length - 1;
    const last = runs[lastIndex];

    if (!last?.text.endsWith("\n")) {
      break;
    }

    const text = last.text.slice(0, -1);

    if (text.length === 0) {
      runs.pop();
    } else {
      runs[lastIndex] = { ...last, text };
    }
  }

  return decorateSkillRuns(runs, skills);
}
