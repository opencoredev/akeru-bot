/**
 * ClaudeSkillDispatch — turns `$skill` mentions in a composer prompt into the
 * slash invocation Claude Code actually runs.
 *
 * The composer inserts `$name` for every provider. Codex parses that natively;
 * Claude Code does not, and treats it as prose. Claude Code's only user-side
 * invocation is a text block whose first character is `/`.
 *
 * @module provider/Drivers/ClaudeSkillDispatch
 */

/**
 * Same token shape the composer and timeline chips recognise
 * (`packages/shared/src/composerInlineTokens.ts`), so a rendered chip and a
 * dispatched skill are always the same set.
 */
const SKILL_MENTION_PATTERN = /(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/g;

export interface ClaudeSkillDispatch {
  /** Text before the dispatched mention, or `undefined` when it opens the prompt. */
  readonly leadingText: string | undefined;
  /** `/name` plus the trailing text, ready to be the message's last text block. */
  readonly commandText: string;
  readonly skillName: string;
}

/**
 * Split `prompt` around the last `$skill` mention that names a known skill.
 * Returns `undefined` when there is nothing to dispatch, in which case the
 * prompt should go out unchanged. Mentions that do not match a discovered
 * skill stay literal: a `$HOME` in prose must not become a command. So do
 * mentions inside code or quotes, such as `echo "$implement now"`.
 */
export function planClaudeSkillDispatch(
  prompt: string,
  skillNames: ReadonlySet<string>,
): ClaudeSkillDispatch | undefined {
  const literalRanges = findLiteralRanges(prompt);
  const mentions = [...prompt.matchAll(SKILL_MENTION_PATTERN)].flatMap((match) => {
    const name = match[2] ?? "";
    if (!skillNames.has(name)) return [];
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (literalRanges.some((range) => start >= range.start && start < range.end)) return [];
    return [{ name, start, end: start + name.length + 1 }];
  });
  const last = mentions.at(-1);
  if (!last) {
    return undefined;
  }

  const leading = prompt.slice(0, last.start);
  const trailing = prompt.slice(last.end);
  const leadingWithInlineSlashes = mentions
    .slice(0, -1)
    .reduceRight(
      (text, mention) => `${text.slice(0, mention.start)}/${text.slice(mention.start + 1)}`,
      leading,
    )
    .trimEnd();

  return {
    leadingText: leadingWithInlineSlashes.length > 0 ? leadingWithInlineSlashes : undefined,
    commandText: `/${last.name}${trailing}`.trimEnd(),
    skillName: last.name,
  };
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

const FENCE_OPEN_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const WORD_CHARACTER = /[\p{L}\p{N}_]/u;

/**
 * Ranges the user wrote as literal text: fenced code blocks, inline code
 * spans, and single- or double-quoted runs. A quote only opens after a
 * non-word character and only closes before one, so apostrophes in prose like
 * "don't" and "it's" never start a quoted run. Quoted runs may span lines, and
 * inside double quotes a backslash escapes the next character, matching shell
 * rules; single quotes have no escapes.
 */
function findLiteralRanges(prompt: string): TextRange[] {
  const ranges: TextRange[] = [];
  let fence: { readonly marker: string; readonly start: number } | null = null;
  let index = 0;
  while (index < prompt.length) {
    const lineEnd = prompt.indexOf("\n", index);
    const end = lineEnd < 0 ? prompt.length : lineEnd;
    if (fence) {
      const closing = new RegExp(`^ {0,3}${fence.marker[0]}{${fence.marker.length},}\\s*$`);
      if (closing.test(prompt.slice(index, end))) {
        ranges.push({ start: fence.start, end });
        fence = null;
      }
      index = end + 1;
      continue;
    }
    if (index === 0 || prompt[index - 1] === "\n") {
      const open = FENCE_OPEN_PATTERN.exec(prompt.slice(index, end));
      if (open?.[1]) {
        fence = { marker: open[1], start: index };
        index = end + 1;
        continue;
      }
    }
    const character = prompt[index];
    if (character === "`") {
      const run = /^`+/.exec(prompt.slice(index, end))?.[0] ?? "`";
      const close = findBacktickRun(prompt, index + run.length, run.length, end);
      if (close >= 0) {
        ranges.push({ start: index, end: close + run.length });
        index = close + run.length;
        continue;
      }
      index += run.length;
      continue;
    }
    if ((character === '"' || character === "'") && !isWordCharacter(prompt[index - 1])) {
      const close = findClosingQuote(prompt, index + 1, character);
      if (close >= 0) {
        ranges.push({ start: index, end: close + 1 });
        index = close + 1;
        continue;
      }
    }
    index += 1;
  }
  if (fence) ranges.push({ start: fence.start, end: prompt.length });
  return ranges;
}

function findBacktickRun(text: string, from: number, length: number, end: number): number {
  for (let index = from; index < end; index += 1) {
    if (text[index] !== "`") continue;
    const run = /^`+/.exec(text.slice(index))?.[0] ?? "";
    if (run.length === length) return index;
    index += run.length - 1;
  }
  return -1;
}

function findClosingQuote(text: string, from: number, quote: string): number {
  for (let index = from; index < text.length; index += 1) {
    if (quote === '"' && text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote && !isWordCharacter(text[index + 1])) return index;
  }
  return -1;
}

function isWordCharacter(character: string | undefined): boolean {
  return character !== undefined && WORD_CHARACTER.test(character);
}
