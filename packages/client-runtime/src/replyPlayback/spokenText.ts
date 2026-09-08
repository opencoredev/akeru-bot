export const MAX_REPLY_MARKDOWN_LENGTH = 100_000;
export const MAX_REPLY_SPOKEN_TEXT_LENGTH = 20_000;

export interface ReplySpokenText {
  readonly text: string;
  readonly speakable: boolean;
  readonly reason: "empty" | "input-too-long" | "text-too-long" | "too-complex" | null;
  /** Counts cover parsed content only; input-too-long replies are not parsed. */
  readonly skipped: { readonly codeBlocks: number; readonly images: number };
}

function referenceKey(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function delimiterEnds(source: string, open: string, close: string) {
  const stack: number[] = [];
  const ends = new Map<number, number>();
  for (let index = 0; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
    } else if (source[index] === open) {
      stack.push(index);
    } else if (source[index] === close) {
      const start = stack.pop();
      if (start !== undefined) ends.set(start, index);
    }
  }
  return ends;
}

function decodeEntity(entity: string) {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
  };
  const name = entity.slice(1, -1);
  if (!name.startsWith("#")) return named[name] ?? entity;
  const hexadecimal = name[1]?.toLowerCase() === "x";
  const value = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff)
    ? String.fromCodePoint(value)
    : "\uFFFD";
}

/** Converts stored Markdown without a DOM, network access, or provider-specific behavior. */
export function replyMarkdownToSpokenText(markdown: string): ReplySpokenText {
  const skipped = { codeBlocks: 0, images: 0 };
  const blocked = (reason: Exclude<ReplySpokenText["reason"], null>): ReplySpokenText => ({
    text: "",
    speakable: false,
    reason,
    skipped,
  });
  if (markdown.length > MAX_REPLY_MARKDOWN_LENGTH) return blocked("input-too-long");

  const references = new Set<string>();
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const prose: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let indented = false;
  let previousBlank = true;
  for (const rawLine of lines) {
    const line = rawLine.replace(/^ {0,3}(?:> ?)+/, "");
    if (fence) {
      const closing = /^ {0,3}(`+|~+)\s*$/.exec(line);
      if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) {
        fence = undefined;
        previousBlank = true;
      }
      continue;
    }
    const opening = /^ {0,3}(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})(.*)$/.exec(line);
    if (opening && !(opening[1]![0] === "`" && opening[2]!.includes("`"))) {
      skipped.codeBlocks++;
      fence = { marker: opening[1]![0]!, length: opening[1]!.length };
      indented = false;
      prose.push("");
      continue;
    }
    const nestedList = /^\s+(?:[-+*]|\d+[.)])\s+/.test(line);
    if (line.trim() && /^(?: {4}|\t)/.test(line) && (indented || (previousBlank && !nestedList))) {
      if (!indented) skipped.codeBlocks++;
      indented = true;
      prose.push("");
      continue;
    }
    if (line.trim()) indented = false;
    previousBlank = !line.trim();
    const definition = /^ {0,3}\[([^\]]+)\]:\s*\S+.*$/.exec(line);
    if (definition) {
      references.add(referenceKey(definition[1]!));
      continue;
    }
    prose.push(line);
  }

  let tooComplex = false;
  const inline = (source: string, depth = 0): string => {
    if (depth > 32) {
      tooComplex = true;
      return "";
    }
    const brackets = delimiterEnds(source, "[", "]");
    const parentheses = delimiterEnds(source, "(", ")");
    let result = "";
    for (let index = 0; index < source.length; ) {
      const rest = source.slice(index);
      const escaped = /^\\([!"#$%&'()*+,\-./:;<=>?@[\]\\^_`{|}~])/.exec(rest);
      if (escaped) {
        result += escaped[1];
        index += escaped[0].length;
        continue;
      }
      const ticks = /^`+/.exec(rest)?.[0];
      if (ticks) {
        let end = source.indexOf(ticks, index + ticks.length);
        while (end !== -1 && (source[end - 1] === "`" || source[end + ticks.length] === "`")) {
          end = source.indexOf(ticks, end + ticks.length);
        }
        if (end !== -1) {
          let code = source.slice(index + ticks.length, end).replace(/\n/g, " ");
          if (/^ .* $/.test(code) && /\S/.test(code)) code = code.slice(1, -1);
          result += code;
          index = end + ticks.length;
          continue;
        }
        result += ticks;
        index += ticks.length;
        continue;
      }
      const image = rest.startsWith("![");
      if (image || rest.startsWith("[")) {
        const start = index + (image ? 1 : 0);
        const labelEnd = brackets.get(start) ?? -1;
        if (labelEnd !== -1) {
          const label = source.slice(start + 1, labelEnd);
          let end = labelEnd;
          let linked = false;
          if (source[end + 1] === "(") {
            const destinationEnd = parentheses.get(end + 1) ?? -1;
            if (destinationEnd !== -1) {
              end = destinationEnd;
              linked = true;
            }
          } else if (source[end + 1] === "[") {
            const referenceEnd = source.indexOf("]", end + 2);
            if (
              referenceEnd !== -1 &&
              references.has(referenceKey(source.slice(end + 2, referenceEnd) || label))
            ) {
              end = referenceEnd;
              linked = true;
            }
          } else {
            linked = references.has(referenceKey(label));
          }
          if (linked) {
            if (image) {
              skipped.images++;
              result += " ";
            } else {
              result += inline(label, depth + 1);
            }
            index = end + 1;
            continue;
          }
        }
      }
      const htmlImage = /^<img\b[^>]*>/i.exec(rest);
      if (htmlImage) {
        skipped.images++;
        result += " ";
        index += htmlImage[0].length;
        continue;
      }
      const autolink = /^<((?:https?:\/\/|mailto:)[^ <>]+|[^ <>@]+@[^ <>@]+)>/.exec(rest);
      if (autolink) {
        result += autolink[1]!.replace(/^mailto:/, "");
        index += autolink[0].length;
        continue;
      }
      const tag = /^(?:<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>)/.exec(rest);
      if (tag) {
        if (/^<\/?(?:br|p|div)\b/i.test(tag[0])) result += " ";
        index += tag[0].length;
        continue;
      }
      const marker = /^(\*\*\*|___|\*\*|__|~~|\*|_)/.exec(rest)?.[0];
      if (marker && !(marker.includes("_") && /[\p{L}\p{N}]/u.test(source[index - 1] ?? ""))) {
        let end = source.indexOf(marker, index + marker.length);
        while (
          end !== -1 &&
          (source[end - 1] === marker[0] ||
            source[end + marker.length] === marker[0] ||
            source[end - 1] === "\\")
        ) {
          end = source.indexOf(marker, end + marker.length);
        }
        if (end > index + marker.length && !/^\s/.test(source.slice(index + marker.length))) {
          result += inline(source.slice(index + marker.length, end), depth + 1);
          index = end + marker.length;
          continue;
        }
      }
      const entity = /^&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);/i.exec(rest);
      if (entity) {
        result += decodeEntity(entity[0]);
        index += entity[0].length;
        continue;
      }
      result += source[index];
      index++;
    }
    return result;
  };

  const tableCells = (line: string) => {
    const cells: string[] = [];
    let cell = "";
    let ticks = "";
    const trimmed = line
      .trim()
      .replace(/^\|/, "")
      .replace(/(?<!\\)\|$/, "");
    for (let index = 0; index < trimmed.length; index++) {
      const character = trimmed[index]!;
      if (character === "\\" && index + 1 < trimmed.length) {
        cell += character + trimmed[++index];
      } else if (character === "`") {
        const run = /^`+/.exec(trimmed.slice(index))![0];
        if (!ticks) ticks = run;
        else if (ticks === run) ticks = "";
        cell += run;
        index += run.length - 1;
      } else if (character === "|" && !ticks) {
        cells.push(cell.trim());
        cell = "";
      } else {
        cell += character;
      }
    }
    cells.push(cell.trim());
    return cells;
  };
  const output: string[] = [];
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) output.push(inline(paragraph.join("\n")));
    paragraph = [];
  };
  for (let index = 0; index < prose.length; index++) {
    const line = prose[index]!;
    const next = prose[index + 1];
    if (next && line.includes("|") && tableCells(next).every((cell) => /^:?-{3,}:?$/.test(cell))) {
      flushParagraph();
      const headers = tableCells(line).map((cell) => inline(cell));
      index += 2;
      let rows = 0;
      for (; index < prose.length && prose[index]!.includes("|") && prose[index]!.trim(); index++) {
        const cells = tableCells(prose[index]!).map((cell) => inline(cell));
        output.push(
          cells
            .map((cell, column) => (headers[column] ? `${headers[column]}: ${cell}` : cell))
            .join("; "),
        );
        rows++;
      }
      if (!rows) output.push(headers.join("; "));
      index--;
      continue;
    }
    if (/^\s*(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,}|={3,})\s*$/.test(line)) continue;
    const content = line
      .replace(/^ {0,3}#{1,6}\s+/, "")
      .replace(/\s+#+\s*$/, "")
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "");
    if (!content.trim()) {
      flushParagraph();
      output.push("");
    } else {
      paragraph.push(content);
    }
  }
  flushParagraph();
  if (tooComplex) return blocked("too-complex");
  const text = output
    .join("\n")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > MAX_REPLY_SPOKEN_TEXT_LENGTH) return blocked("text-too-long");
  if (!text || !/[\p{L}\p{N}\p{S}]/u.test(text)) return blocked("empty");
  return { text, speakable: true, reason: null, skipped };
}
