/**
 * Streaming Markdown arrives mid-token, and a few partial tokens parse as
 * something other than what they become: a half fence opener shows a wrong
 * language, a table header shows as a paragraph until its delimiter row lands,
 * and a lone `-` under a line turns that line into a heading for one frame.
 *
 * `stabilizeStreamingMarkdown` withholds only those unstable trailing tokens
 * so each frame renders a prefix of the settled message. Apply it to
 * streaming text only; settled text must render verbatim.
 */

const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A line that may still grow into a fence opener or closer. */
const PARTIAL_FENCE_PATTERN = /^ {0,3}(?:`{1,3}|~{1,3}|`{3,}[^`]*|~{3,}.*)$/;
/** A list marker, task marker, setext underline, or thematic break with no content yet. */
const PARTIAL_BLOCK_MARKER_PATTERN =
  /^ {0,3}(?:(?:[-*+]|\d{1,9}[.)])(?:\s+\[(?:[ xX]\]?)?)?|-+|=+|\*+|_+)\s*$/;
const TABLE_ROW_PATTERN = /^ {0,3}\|/;
const TABLE_DELIMITER_PATTERN = /^ {0,3}\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;

interface OpenFence {
  readonly marker: "`" | "~";
  readonly length: number;
}

function readFenceState(lines: ReadonlyArray<string>): OpenFence | null {
  let open: OpenFence | null = null;
  for (const line of lines) {
    const match = FENCE_PATTERN.exec(line);
    if (!match) continue;
    const fence = match[1] ?? "";
    const marker = fence[0] === "~" ? "~" : "`";
    if (open === null) {
      // Backtick fence info strings cannot contain backticks.
      if (marker === "`" && (match[2] ?? "").includes("`")) continue;
      open = { marker, length: fence.length };
    } else if (
      marker === open.marker &&
      fence.length >= open.length &&
      (match[2] ?? "").trim() === ""
    ) {
      open = null;
    }
  }
  return open;
}

function withholdFrom(lines: ReadonlyArray<string>, index: number): string {
  return lines.slice(0, index).join("\n") + (index > 0 ? "\n" : "");
}

export function stabilizeStreamingMarkdown(text: string): string {
  const lines = text.split("\n");
  const lastIndex = lines.length - 1;
  const last = lines[lastIndex] ?? "";
  const lastIsPartial = last !== "";
  const openFence = readFenceState(lines.slice(0, lastIndex));

  if (openFence !== null) {
    const closer = new RegExp(`^ {0,3}\\${openFence.marker}+\\s*$`);
    return lastIsPartial && closer.test(last) ? withholdFrom(lines, lastIndex) : text;
  }

  if (
    lastIsPartial &&
    (PARTIAL_FENCE_PATTERN.test(last) || PARTIAL_BLOCK_MARKER_PATTERN.test(last))
  ) {
    return withholdFrom(lines, lastIndex);
  }

  // A trailing run of pipe rows is a table only once its delimiter row is
  // complete. Until then hold the whole run; after it, hold the row in flight.
  const blockEnd = lastIsPartial ? lastIndex : lastIndex - 1;
  let blockStart = blockEnd + 1;
  while (blockStart > 0 && TABLE_ROW_PATTERN.test(lines[blockStart - 1] ?? "")) {
    blockStart -= 1;
  }
  if (blockStart > blockEnd) return text;
  const delimiterIndex = blockStart + 1;
  const delimiterComplete =
    delimiterIndex <= blockEnd &&
    !(lastIsPartial && delimiterIndex === lastIndex) &&
    TABLE_DELIMITER_PATTERN.test(lines[delimiterIndex] ?? "");
  if (!delimiterComplete) return withholdFrom(lines, blockStart);
  return lastIsPartial ? withholdFrom(lines, lastIndex) : text;
}
