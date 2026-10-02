import {
  $createLineBreakNode,
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalNode,
} from "lexical";
import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { type TerminalContextDraft } from "~/lib/terminalContext";
import { $createComposerSkillNode, type ComposerSkillMetadata } from "../composerSkillNode";
import {
  $createComposerMentionNode,
  $createComposerTerminalContextNode,
  ComposerTerminalContextNode,
  isComposerInlineTokenNode,
  type ComposerInlineTokenNode,
} from "./ComposerInlineTokenNodes";

export function clampExpandedCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;

  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}

function getComposerInlineTokenTextLength(_node: ComposerInlineTokenNode): 1 {
  return 1;
}

function getComposerInlineTokenExpandedTextLength(node: ComposerInlineTokenNode): number {
  return node.getTextContentSize();
}

function getAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenTextLength(node) : 0);
}

function getExpandedAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenExpandedTextLength(node) : 0);
}

function findSelectionPointForInlineToken(
  node: ComposerInlineTokenNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "element" } | null {
  const parent = node.getParent();

  if (!parent || !$isElementNode(parent)) return null;
  const index = node.getIndexWithinParent();

  if (remainingRef.value === 0) {
    return {
      key: parent.getKey(),
      offset: index,
      type: "element",
    };
  }

  if (remainingRef.value === getComposerInlineTokenTextLength(node)) {
    return {
      key: parent.getKey(),
      offset: index + 1,
      type: "element",
    };
  }

  remainingRef.value -= getComposerInlineTokenTextLength(node);

  return null;
}

function getComposerNodeTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenTextLength(node);
  }

  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }

  if ($isLineBreakNode(node)) {
    return 1;
  }

  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + getComposerNodeTextLength(child), 0);
  }

  return 0;
}

function getComposerNodeExpandedTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenExpandedTextLength(node);
  }

  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }

  if ($isLineBreakNode(node)) {
    return 1;
  }

  if ($isElementNode(node)) {
    return node
      .getChildren()
      .reduce((total, child) => total + getComposerNodeExpandedTextLength(child), 0);
  }

  return 0;
}

export function getAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent: LexicalNode | null = current.getParent();

    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }

    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();

    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];

      if (!sibling) continue;
      offset += getComposerNodeTextLength(sibling);
    }

    current = nextParent;
  }

  if ($isTextNode(node)) {
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }

  if (isComposerInlineTokenNode(node)) {
    return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));

    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];

      if (!child) continue;
      offset += getComposerNodeTextLength(child);
    }

    return offset;
  }

  return offset;
}

export function getExpandedAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent: LexicalNode | null = current.getParent();

    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }

    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();

    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];

      if (!sibling) continue;
      offset += getComposerNodeExpandedTextLength(sibling);
    }

    current = nextParent;
  }

  if ($isTextNode(node)) {
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }

  if (isComposerInlineTokenNode(node)) {
    return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));

    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];

      if (!child) continue;
      offset += getComposerNodeExpandedTextLength(child);
    }

    return offset;
  }

  return offset;
}

function findSelectionPointAtOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if (isComposerInlineTokenNode(node)) {
    return findSelectionPointForInlineToken(node, remainingRef);
  }

  if ($isTextNode(node)) {
    const size = node.getTextContentSize();

    if (remainingRef.value <= size) {
      return {
        key: node.getKey(),
        offset: remainingRef.value,
        type: "text",
      };
    }

    remainingRef.value -= size;

    return null;
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent();

    if (!parent) return null;
    const index = node.getIndexWithinParent();

    if (remainingRef.value === 0) {
      return {
        key: parent.getKey(),
        offset: index,
        type: "element",
      };
    }

    if (remainingRef.value === 1) {
      return {
        key: parent.getKey(),
        offset: index + 1,
        type: "element",
      };
    }

    remainingRef.value -= 1;

    return null;
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();

    for (const child of children) {
      const point = findSelectionPointAtOffset(child, remainingRef);

      if (point) {
        return point;
      }
    }

    if (remainingRef.value === 0) {
      return {
        key: node.getKey(),
        offset: children.length,
        type: "element",
      };
    }
  }

  return null;
}

export function $getComposerRootLength(): number {
  const root = $getRoot();
  const children = root.getChildren();

  return children.reduce((sum, child) => sum + getComposerNodeTextLength(child), 0);
}

export function $setSelectionAtComposerOffset(nextOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedOffset = Math.max(0, Math.min(nextOffset, composerLength));
  const remainingRef = { value: boundedOffset };

  const point = findSelectionPointAtOffset(root, remainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };

  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

export function $setSelectionRangeAtComposerOffsets(startOffset: number, endOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedStart = Math.max(0, Math.min(startOffset, composerLength));
  const boundedEnd = Math.max(0, Math.min(endOffset, composerLength));
  const anchorRemainingRef = { value: boundedStart };
  const focusRemainingRef = { value: boundedEnd };

  const anchorPoint = findSelectionPointAtOffset(root, anchorRemainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };

  const focusPoint = findSelectionPointAtOffset(root, focusRemainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };

  const selection = $createRangeSelection();
  selection.anchor.set(anchorPoint.key, anchorPoint.offset, anchorPoint.type);
  selection.focus.set(focusPoint.key, focusPoint.offset, focusPoint.type);
  $setSelection(selection);
}

export function getSelectionRangeForExpandedComposerOffsets(
  selection: ReturnType<typeof $getSelection>,
): {
  start: number;
  end: number;
} | null {
  if (!$isRangeSelection(selection)) {
    return null;
  }

  const anchorNode = selection.anchor.getNode();
  const focusNode = selection.focus.getNode();
  const anchorOffset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const focusOffset = getExpandedAbsoluteOffsetForPoint(focusNode, selection.focus.offset);

  return {
    start: Math.min(anchorOffset, focusOffset),
    end: Math.max(anchorOffset, focusOffset),
  };
}

export function $selectionTouchesInlineToken(selection: ReturnType<typeof $getSelection>): boolean {
  if (!$isRangeSelection(selection)) {
    return false;
  }

  return selection.getNodes().some((node) => isComposerInlineTokenNode(node));
}

export function $readSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();

  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }

  const anchorNode = selection.anchor.getNode();
  const offset = getAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const composerLength = $getComposerRootLength();

  return Math.max(0, Math.min(offset, composerLength));
}

export function $readExpandedSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();

  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }

  const anchorNode = selection.anchor.getNode();
  const offset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const expandedLength = $getRoot().getTextContent().length;

  return Math.max(0, Math.min(offset, expandedLength));
}

function $appendTextWithLineBreaks(parent: ElementNode, text: string): void {
  const lines = text.split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.length > 0) {
      parent.append($createTextNode(line));
    }

    if (index < lines.length - 1) {
      parent.append($createLineBreakNode());
    }
  }
}

export function $setComposerEditorPrompt(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
  skillMetadata: ReadonlyMap<string, ComposerSkillMetadata>,
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const segments = splitPromptIntoComposerSegments(prompt, terminalContexts);

  for (const segment of segments) {
    if (segment.type === "mention") {
      paragraph.append($createComposerMentionNode(segment.path));
      continue;
    }

    if (segment.type === "skill") {
      paragraph.append($createComposerSkillNode(segment.name, skillMetadata.get(segment.name)));
      continue;
    }

    if (segment.type === "terminal-context") {
      if (segment.context) {
        paragraph.append($createComposerTerminalContextNode(segment.context));
      }

      continue;
    }

    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

export function collectTerminalContextIds(node: LexicalNode): string[] {
  if (node instanceof ComposerTerminalContextNode) {
    return [node.__context.id];
  }

  if ($isElementNode(node)) {
    return node.getChildren().flatMap((child) => collectTerminalContextIds(child));
  }

  return [];
}
