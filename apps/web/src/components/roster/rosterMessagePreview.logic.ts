import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

export interface RosterLastMessage {
  text: string;
  at: string;
  /** The chat the message went to, when known. */
  threadId?: string;
}

type MarkdownNode = ReturnType<typeof fromMarkdown> | MarkdownNodeChild;
type MarkdownNodeChild = ReturnType<typeof fromMarkdown>["children"][number];

const markdownPreviewOptions = {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
};
const markdownPreviewCache = new Map<string, string>();
const MARKDOWN_PREVIEW_CACHE_LIMIT = 500;

/**
 * One-line plain text for a roster preview. Chat messages are markdown, and a
 * preview row shows only the words: emphasis, code ticks and fences, link and
 * image syntax, headings, and list or quote markers go, and whitespace
 * collapses to single spaces. Links keep their label; images drop out; code
 * and URLs stay literal. The text is parsed with the same micromark/GFM stack
 * the chat renders with, and results are cached by text so a roster render
 * never reparses an unchanged message.
 */
export function flattenMarkdownPreview(markdown: string): string {
  const cached = markdownPreviewCache.get(markdown);
  if (cached !== undefined) return cached;
  // A row shows one line, so parse whole blocks from the top only until the
  // flattened text is long enough. Parsing costs several milliseconds per long
  // answer. Cuts fall on blank lines outside code fences, so they never land
  // inside a link, image, or code span and leak raw syntax into the preview.
  // A message longer than the parse limit only parses blocks that end inside
  // it; past the last such block, a cheap strip of the next few thousand
  // characters stands in, so one enormous line cannot stall a roster render.
  const complete = markdown.length <= MARKDOWN_PREVIEW_PARSE_LIMIT;
  const source = complete ? markdown : markdown.slice(0, MARKDOWN_PREVIEW_PARSE_LIMIT);
  // Chunks parse apart, so a reference image or link in one chunk still needs
  // the definitions another chunk holds; they flatten to nothing themselves.
  const definitions = (source.match(MARKDOWN_REFERENCE_DEFINITION) ?? []).join("\n");
  const withDefinitions = definitions ? `\n\n${definitions}` : "";
  let flattened = "";
  let offset = 0;
  while (offset < source.length && flattened.length < MARKDOWN_PREVIEW_TEXT_TARGET) {
    const end = markdownPreviewChunkEnd(source, offset, complete);
    if (end === null) break;
    const chunk = flattenMarkdownText(source.slice(offset, end) + withDefinitions);
    if (chunk.length > 0) flattened = flattened.length > 0 ? `${flattened} ${chunk}` : chunk;
    offset = end;
  }
  if (flattened.length === 0 && !complete) {
    flattened = stripMarkdownRoughly(
      markdown.slice(offset, offset + MARKDOWN_PREVIEW_ROUGH_LIMIT).trimStart(),
    );
  }
  if (markdownPreviewCache.size >= MARKDOWN_PREVIEW_CACHE_LIMIT) markdownPreviewCache.clear();
  markdownPreviewCache.set(markdown, flattened);
  return flattened;
}

const MARKDOWN_PREVIEW_TEXT_TARGET = 280;
const MARKDOWN_PREVIEW_CHUNK_TARGET = 600;
const MARKDOWN_PREVIEW_PARSE_LIMIT = 20_000;
const MARKDOWN_PREVIEW_ROUGH_LIMIT = 2_000;
const MARKDOWN_FENCE = /^ {0,3}(`{3,}|~{3,})/;
const MARKDOWN_REFERENCE_DEFINITION = /^ {0,3}\[(?!\^)(?:[^\]\\\n]|\\.)+\]:[ \t]*\S.*$/gm;

/**
 * End of the next chunk starting at `offset`: a blank line outside a fenced
 * code block, preferably at least the chunk target long. When `complete` is
 * false the source is a cut prefix, so its end is not a block boundary and the
 * result is the last blank line seen, or null when there is none.
 */
function markdownPreviewChunkEnd(
  markdown: string,
  offset: number,
  complete: boolean,
): number | null {
  let fence: string | null = null;
  let lastBoundary: number | null = null;
  let lineStart = offset;
  while (lineStart < markdown.length) {
    const newline = markdown.indexOf("\n", lineStart);
    const lineEnd = newline === -1 ? markdown.length : newline + 1;
    const line = markdown.slice(lineStart, lineEnd);
    const marker = MARKDOWN_FENCE.exec(line)?.[1];
    if (fence === null) {
      if (marker !== undefined) fence = marker;
      else if (newline !== -1 && line.trim().length === 0) {
        if (lineEnd - offset >= MARKDOWN_PREVIEW_CHUNK_TARGET) return lineEnd;
        lastBoundary = lineEnd;
      }
    } else if (
      marker !== undefined &&
      marker[0] === fence[0] &&
      marker.length >= fence.length &&
      line.trim() === marker
    ) {
      fence = null;
    }
    lineStart = lineEnd;
  }
  return complete ? markdown.length : lastBoundary;
}

/**
 * Rough plain text for the tail of a message too long to parse: drops image
 * syntax and alt text, keeps link labels, and removes code ticks, emphasis,
 * and line markers. It is only a fallback, so literal brackets or underscores
 * next to words may survive or go.
 */
function stripMarkdownRoughly(markdown: string): string {
  const stripProse = (text: string) =>
    withoutImagesRoughly(text)
      .replace(/\[([^\]]*)\](?:\([^)]*\)?|\[[^\]]*\]?)/g, "$1")
      .replace(/^[ \t]{0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, "")
      .replace(/~~|\*+|(?<![A-Za-z0-9])_+|_+(?![A-Za-z0-9])/g, "");
  let result = "";
  let offset = 0;
  while (offset < markdown.length) {
    const opening = unescapedIndexOf(markdown, "`", offset);
    // An image that starts before the next code span is dropped whole, so a
    // backtick inside its label cannot split it and leak the description.
    const image = unescapedIndexOf(markdown, "![", offset);
    if (image >= 0 && (opening < 0 || image < opening)) {
      result += `${stripProse(markdown.slice(offset, image))} `;
      const end = roughImageEnd(markdown, image);
      if (end === null) break;
      offset = end;
      continue;
    }
    if (opening < 0) {
      result += stripProse(markdown.slice(offset));
      break;
    }
    const delimiter = /^`+/.exec(markdown.slice(opening))![0];
    const closing = markdown.indexOf(delimiter, opening + delimiter.length);
    if (closing < 0) {
      result += stripProse(markdown.slice(offset).replace(/`+/g, ""));
      break;
    }
    result += stripProse(markdown.slice(offset, opening));
    result += markdown.slice(opening + delimiter.length, closing);
    offset = closing + delimiter.length;
  }
  return result.replace(/\s+/g, " ").trim();
}

/**
 * Text with every `![` image dropped through the end of its balanced bracket
 * group and any balanced parenthesis or reference group after it, honoring
 * backslash escapes. An image with no balanced close drops the rest of the
 * text, so alt text never leaks even when some ordinary words go with it.
 */
function withoutImagesRoughly(markdown: string): string {
  let result = "";
  let offset = 0;
  for (;;) {
    const start = markdown.indexOf("![", offset);
    if (start === -1) return result + markdown.slice(offset);
    result += `${markdown.slice(offset, start)} `;
    const end = roughImageEnd(markdown, start);
    if (end === null) return result;
    offset = end;
  }
}

/**
 * Index just past the `![` image at `start`: its balanced label and any
 * balanced parenthesis or reference group after it. Null when the label or
 * target never closes.
 */
function roughImageEnd(markdown: string, start: number): number | null {
  const labelEnd = balancedGroupEnd(markdown, start + 1, "[", "]");
  if (labelEnd === null) return null;
  const next = markdown[labelEnd];
  if (next !== "(" && next !== "[") return labelEnd;
  return balancedGroupEnd(markdown, labelEnd, next, next === "(" ? ")" : "]");
}

/** Index of `needle` at or after `from` that no backslash escapes, or -1. */
function unescapedIndexOf(text: string, needle: string, from: number): number {
  for (
    let index = text.indexOf(needle, from);
    index >= 0;
    index = text.indexOf(needle, index + 1)
  ) {
    let backslashes = 0;
    while (text[index - 1 - backslashes] === "\\") backslashes += 1;
    if (backslashes % 2 === 0) return index;
  }
  return -1;
}

/** Index just past the close matching the `open` at `start`, or null. */
function balancedGroupEnd(text: string, start: number, open: string, close: string): number | null {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === open) depth += 1;
    else if (char === close && --depth === 0) return index + 1;
  }
  return null;
}

function flattenMarkdownText(markdown: string): string {
  const parts: string[] = [];
  collectPreviewText(fromMarkdown(markdown, markdownPreviewOptions), parts);
  return parts.join("").replace(/\s+/g, " ").trim();
}

function collectPreviewText(node: MarkdownNode, parts: string[]): void {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "code":
      parts.push(node.value);
      break;
    case "html":
      parts.push(visibleHtmlText(node.value));
      break;
    case "image":
    case "imageReference":
    case "definition":
    case "break":
    case "thematicBreak":
      parts.push(" ");
      break;
    default:
      if ("children" in node) {
        for (const child of node.children) collectPreviewText(child, parts);
      }
  }
  // Block boundaries become spaces so adjacent paragraphs or list items never
  // glue their words together.
  if (node.type !== "text" && !isPhrasingNode(node)) parts.push(" ");
}

/**
 * The words raw HTML shows once the chat renders it: tags and comments go,
 * and line-breaking elements leave a space so their words do not glue.
 */
function visibleHtmlText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?(?:-->|$)/g, "")
    .replace(/<\/?(?:br|p|div|li|ul|ol|h[1-6]|tr|td|th|table|blockquote|pre|hr)\b[^>]*>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ");
  return text.includes("&") ? decodeHtmlEntities(text) : text;
}

/**
 * Decodes character references the way the rendered chat does. Markdown parsing
 * knows every named HTML entity, so the text is parsed with all other ASCII
 * punctuation escaped and its words read back; unknown names stay as written.
 */
function decodeHtmlEntities(text: string): string {
  const escaped = text.trim().replace(/[!-"$-%'-/:<-@[-`{-~]/g, "\\$&");
  const parts: string[] = [];
  collectPreviewText(fromMarkdown(escaped), parts);
  // Keep the edge spaces that separate this HTML from neighbouring text.
  const lead = text.startsWith(" ") ? " " : "";
  const trail = text.endsWith(" ") ? " " : "";
  return `${lead}${parts.join("").trim()}${trail}`;
}

function isPhrasingNode(node: MarkdownNode): boolean {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
    case "footnoteReference":
    case "html":
      return true;
    default:
      return false;
  }
}

export function resolveLatestRosterMessage(
  fallback: RosterLastMessage | null,
  messages: ReadonlyArray<{
    role: "user" | "assistant" | "system";
    text: string;
    createdAt: string;
    parentThreadId?: string | null | undefined;
  }>,
  threadId?: string | null,
): RosterLastMessage | null {
  let latest: RosterLastMessage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.parentThreadId != null || message.role === "system") continue;
    const text = flattenMarkdownPreview(message.text);
    if (text.length > 0) {
      latest = { text, at: message.createdAt };
      break;
    }
  }
  // A fallback that flattens to nothing (an image-only attachment, say) must
  // not beat an older visible answer on timestamp alone.
  // The fallback is kept per bot, so one sent to another chat does not
  // describe the chat that is open. With no open chat (its last chat was
  // archived or deleted) no fallback describes anything current.
  const sameChatFallback =
    fallback && threadId !== null && (fallback.threadId ?? threadId) === threadId ? fallback : null;
  const flatFallback = sameChatFallback
    ? { ...sameChatFallback, text: flattenMarkdownPreview(sameChatFallback.text) }
    : null;
  const usableFallback = flatFallback && flatFallback.text.length > 0 ? flatFallback : null;
  if (!latest) return usableFallback;
  if (!usableFallback) return latest;
  return latest.at >= usableFallback.at ? latest : usableFallback;
}
