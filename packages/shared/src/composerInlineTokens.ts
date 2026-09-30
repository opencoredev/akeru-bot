export type ComposerInlineToken =
  | {
      /** A workspace path mention. Bot mentions use the separate bot-mention token. */
      readonly type: "mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** A group member bot mention. `value` is the stable bot id. */
      readonly type: "bot-mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** The `@browser` mention. `value` is always `"browser"`. */
      readonly type: "browser-mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      /** An `@chat:<id>` chat mention. `value` is the thread id. */
      readonly type: "thread-mention";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    }
  | {
      readonly type: "skill";
      readonly value: string;
      readonly source: string;
      readonly start: number;
      readonly end: number;
    };

export interface CollectComposerInlineTokensOptions {
  readonly preserveTrailingFrom?: ReadonlyArray<ComposerInlineToken>;
}

export const COMPOSER_BROWSER_MENTION = "@browser";
const THREAD_MENTION_PREFIX = "@chat:";
const THREAD_MENTION_ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9._:-]*";
const THREAD_MENTION_ID_REGEX = new RegExp(`^${THREAD_MENTION_ID_PATTERN}$`);
const BOT_MENTION_PREFIX = "@bot:";
const BROWSER_MENTION_TOKEN_REGEX = /(^|\s)@browser(?=\s)/g;
const THREAD_MENTION_TOKEN_REGEX = new RegExp(
  `(^|\\s)@chat:(${THREAD_MENTION_ID_PATTERN})(?=\\s)`,
  "g",
);
const BOT_MENTION_TOKEN_REGEX = new RegExp(
  `(^|\\s)@bot:(${THREAD_MENTION_ID_PATTERN})(?=\\s)`,
  "g",
);

/**
 * Serializes a mention of one exact bot, for when its name alone is ambiguous.
 * Returns null for ids the token grammar cannot carry.
 */
export function serializeComposerBotMention(botId: string): string | null {
  return THREAD_MENTION_ID_REGEX.test(botId) ? `${BOT_MENTION_PREFIX}${botId}` : null;
}

/** Serializes a chat mention. Returns null for ids the token grammar cannot carry. */
export function serializeComposerThreadMention(threadId: string): string | null {
  return THREAD_MENTION_ID_REGEX.test(threadId) ? `${THREAD_MENTION_PREFIX}${threadId}` : null;
}

function isReservedMentionPath(path: string): boolean {
  return path === "browser" || path.startsWith("chat:") || path.startsWith("bot:");
}

const SKILL_TOKEN_REGEX = /(^|\s)\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s)/g;
const MENTION_TOKEN_REGEX = /(^|\s)@(?:"((?:\\.|[^"\\])*)"|([^\s@"]+))(?=\s)/g;
/**
 * The label body is bounded rather than `*`. Unbounded, every whitespace in
 * the composer is a candidate start: the engine scans the rest of the text for
 * a closing `]`, fails, and rescans from the next whitespace — quadratic on
 * input like " [[[[[…". A cap makes each attempt constant-bounded.
 *
 * Only a basename ever survives the `label !== basename` check below, so this
 * cannot reject a link a user could meaningfully write; the longest filename
 * any common filesystem allows is 255.
 */
const MAX_FILE_LINK_LABEL_LENGTH = 512;
const FILE_LINK_TOKEN_REGEX = new RegExp(
  `(^|\\s)\\[((?:\\\\.|[^\\]\\\\]){0,${MAX_FILE_LINK_LABEL_LENGTH}})\\]\\(([^)\\s]+)\\)(?=\\s)`,
  "g",
);
const URI_SCHEME_REGEX = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATH_REGEX = /^[A-Za-z]:[\\/]/;
// Autocomplete emits canonical file links, so ambiguous bare @scope/package text stays a package.
const SCOPED_PACKAGE_REFERENCE_REGEX =
  /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*(?:\/[^\s@"]+)*$/;

function collectMentionTokens(text: string): ComposerInlineToken[] {
  const matches: ComposerInlineToken[] = [];

  for (const match of text.matchAll(FILE_LINK_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const label = (match[2] ?? "").replace(/\\(.)/g, "$1");
    const encodedPath = match[3] ?? "";
    let path = encodedPath;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      // Preserve malformed source rather than dropping a user-authored token.
    }
    const separatorIndex = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const basename = separatorIndex >= 0 ? path.slice(separatorIndex + 1) : path;
    const hasExternalScheme = URI_SCHEME_REGEX.test(path) && !WINDOWS_DRIVE_PATH_REGEX.test(path);
    if (!path || hasExternalScheme || label !== basename) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(MENTION_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const quotedPath = match[2];
    const path = quotedPath !== undefined ? quotedPath.replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (
      !path ||
      (quotedPath === undefined &&
        (SCOPED_PACKAGE_REFERENCE_REGEX.test(path) || isReservedMentionPath(path)))
    ) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "mention",
      value: path,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  return matches;
}

export function collectComposerInlineTokens(
  text: string,
  options: CollectComposerInlineTokensOptions = {},
): ReadonlyArray<ComposerInlineToken> {
  const matches = collectMentionTokens(text);

  for (const match of text.matchAll(BROWSER_MENTION_TOKEN_REGEX)) {
    const start = (match.index ?? 0) + (match[1] ?? "").length;
    const end = start + COMPOSER_BROWSER_MENTION.length;
    matches.push({
      type: "browser-mention",
      value: "browser",
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(THREAD_MENTION_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const end = start + match[0].length - prefix.length;
    matches.push({
      type: "thread-mention",
      value: match[2] ?? "",
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(BOT_MENTION_TOKEN_REGEX)) {
    const prefix = match[1] ?? "";
    const start = (match.index ?? 0) + prefix.length;
    const end = start + match[0].length - prefix.length;
    matches.push({
      type: "bot-mention",
      value: match[2] ?? "",
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const match of text.matchAll(SKILL_TOKEN_REGEX)) {
    const fullMatch = match[0];
    const prefix = match[1] ?? "";
    const value = match[2] ?? "";
    if (!value) {
      continue;
    }
    const start = (match.index ?? 0) + prefix.length;
    const end = start + fullMatch.length - prefix.length;
    matches.push({
      type: "skill",
      value,
      source: text.slice(start, end),
      start,
      end,
    });
  }

  for (const token of options.preserveTrailingFrom ?? []) {
    if (
      token.end === text.length &&
      text.slice(token.start, token.end) === token.source &&
      !matches.some(
        (match) =>
          match.type === token.type && match.start === token.start && match.end === token.end,
      )
    ) {
      matches.push(token);
    }
  }

  return [...matches].sort((left, right) => left.start - right.start);
}

export interface ComposerMentionReferences {
  readonly browser: boolean;
  /** Distinct mentioned thread ids in first-mention order. */
  readonly threadIds: ReadonlyArray<string>;
}

/**
 * Reads the `@browser` and `@chat:<id>` mentions from a finished prompt.
 * Unlike live composer parsing, a token at the very end of the text counts.
 */
export function collectComposerMentionReferences(text: string): ComposerMentionReferences {
  let browser = false;
  const threadIds: string[] = [];
  for (const token of collectComposerInlineTokens(`${text}\n`)) {
    if (token.type === "browser-mention") browser = true;
    if (token.type === "thread-mention" && !threadIds.includes(token.value)) {
      threadIds.push(token.value);
    }
  }
  return { browser, threadIds };
}

export const BROWSER_MENTION_LABEL = "Browser";
/** Label for a chat mention whose chat this client cannot see, or that no longer exists. */
export const UNKNOWN_CHAT_MENTION_LABEL = "Unknown chat";
/** Label for an `@bot:<id>` mention whose bot this client cannot see, or that was removed. */
export const UNKNOWN_BOT_MENTION_LABEL = "Unknown bot";

export interface ComposerMentionDisplay {
  readonly kind: "browser" | "thread" | "bot";
  /** The raw token, which copy and removal act on. */
  readonly source: string;
  readonly label: string;
  readonly threadId: string | null;
  readonly botId: string | null;
  /** Offsets of the first occurrence. */
  readonly start: number;
  readonly end: number;
}

/**
 * The `@browser`, `@chat:<id>`, and `@bot:<id>` mentions in a draft or sent message,
 * once per token, labelled for chips. Web and mobile share these labels.
 */
export function collectComposerMentionDisplays(
  text: string,
  threadTitle: (threadId: string) => string | null,
  botName: (botId: string) => string | null = () => null,
): ComposerMentionDisplay[] {
  const displays: ComposerMentionDisplay[] = [];
  const seen = new Set<string>();
  for (const token of collectComposerInlineTokens(`${text}\n`)) {
    if (
      token.type !== "browser-mention" &&
      token.type !== "thread-mention" &&
      token.type !== "bot-mention"
    ) {
      continue;
    }
    if (seen.has(token.source)) continue;
    seen.add(token.source);
    const base = { source: token.source, start: token.start, end: token.end };
    if (token.type === "browser-mention") {
      displays.push({
        ...base,
        kind: "browser",
        label: BROWSER_MENTION_LABEL,
        threadId: null,
        botId: null,
      });
    } else if (token.type === "thread-mention") {
      displays.push({
        ...base,
        kind: "thread",
        label: threadTitle(token.value) ?? UNKNOWN_CHAT_MENTION_LABEL,
        threadId: token.value,
        botId: null,
      });
    } else {
      displays.push({
        ...base,
        kind: "bot",
        label: botName(token.value) ?? UNKNOWN_BOT_MENTION_LABEL,
        threadId: null,
        botId: token.value,
      });
    }
  }
  return displays;
}
