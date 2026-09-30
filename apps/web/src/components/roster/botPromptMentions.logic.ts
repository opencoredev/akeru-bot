import {
  BROWSER_MENTION_LABEL,
  collectComposerInlineTokens,
  collectComposerMentionDisplays,
  COMPOSER_BROWSER_MENTION,
  serializeComposerBotMention,
  serializeComposerThreadMention,
} from "@t3tools/shared/composerInlineTokens";
import { composerBotMentionDetail } from "@t3tools/shared/composerBotMentions";
import { detectComposerTrigger, serializeComposerFileLink } from "@t3tools/shared/composerTrigger";

const THREAD_QUERY_PREFIX = "chat:";

export interface BotPromptMentionTrigger {
  /** Text typed after `@`, used to filter the picker. */
  readonly query: string;
  readonly rangeStart: number;
  readonly rangeEnd: number;
}

export type BotPromptMentionItem =
  | { readonly kind: "browser"; readonly key: "browser"; readonly label: string }
  | {
      readonly kind: "bot";
      readonly key: string;
      readonly label: string;
      /** The token inserted for this bot: `@Name`, or `@bot:<id>` when the name is shared. */
      readonly source: string;
      /** Tells bots that share a name apart; null for a unique name. */
      readonly detail: string | null;
      /** False when the bot's provider cannot take handed-off work. */
      readonly canTakeWork: boolean;
    }
  | {
      readonly kind: "thread";
      readonly key: string;
      readonly label: string;
      readonly threadId: string;
    }
  | {
      readonly kind: "path";
      readonly key: string;
      readonly label: string;
      readonly path: string;
      readonly directory: string;
    };

/** The `@` token being typed at the caret, or null when the picker should stay closed. */
export function botPromptMentionTrigger(
  draft: string,
  caret: number,
): BotPromptMentionTrigger | null {
  const trigger = detectComposerTrigger(draft, caret);
  if (trigger?.kind !== "path" || trigger.query.startsWith('"')) return null;
  return { query: trigger.query, rangeStart: trigger.rangeStart, rangeEnd: trigger.rangeEnd };
}

/** The part of the query that filters chats: `@chat:rel` and `@rel` both match "Release". */
export function botPromptThreadQuery(query: string): string {
  return query.toLowerCase().startsWith(THREAD_QUERY_PREFIX)
    ? query.slice(THREAD_QUERY_PREFIX.length)
    : query;
}

/** Whether an `@` query names a chat explicitly, so file search can be skipped. */
export function isBotPromptThreadQuery(query: string): boolean {
  return query.toLowerCase().startsWith(THREAD_QUERY_PREFIX);
}

/** A query with a path separator or extension is a file reference, like `@src/comp` or `@a.ts`. */
export function isBotPromptPathQuery(query: string): boolean {
  return !isBotPromptThreadQuery(query) && /[/\\.]/.test(query);
}

export interface BotPromptMentionBot {
  readonly id: string;
  readonly name: string;
  /** The bot's role, which usually tells two bots with the same name apart. */
  readonly title?: string;
  /** False when the bot's provider cannot take handed-off work. Defaults to true. */
  readonly canTakeWork?: boolean;
}

/**
 * How a bot is mentioned among `bots`: `@Name` for a unique name. A shared name gets
 * the `@bot:<id>` token, which routes to that exact bot, and a detail for the menus:
 * the bot's title, or a short id when the namesakes share that too.
 */
export function botPromptMention(
  bot: BotPromptMentionBot,
  bots: ReadonlyArray<BotPromptMentionBot>,
): { readonly source: string; readonly detail: string | null } {
  const detail = composerBotMentionDetail(bot, bots);
  // A bot named `browser` would read as the browser mention, so it keeps its id token.
  if (detail === null && `@${bot.name}` !== COMPOSER_BROWSER_MENTION)
    return { source: `@${bot.name}`, detail };
  return { source: serializeComposerBotMention(bot.id) ?? `@${bot.name}`, detail };
}

/**
 * Picker rows for a query: the browser (only when this environment lets bots use it),
 * matching bots (namesakes told apart by a detail), the chats the caller already ranked for the query, then workspace files.
 * For a path-like query a chat must match by title, so a chat that only mentions the
 * path in its messages cannot take Enter from the file the user is typing.
 */
export function buildBotPromptMentionItems(input: {
  readonly query: string;
  readonly browserAvailable: boolean;
  /** The browser row's displayed name, so a translated name is searchable too. */
  readonly browserLabel?: string;
  readonly bots: ReadonlyArray<BotPromptMentionBot>;
  readonly threads: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly paths?: ReadonlyArray<{ readonly path: string }>;
}): BotPromptMentionItem[] {
  const query = input.query.toLowerCase();
  const threadOnly = isBotPromptThreadQuery(query);
  const pathLike = isBotPromptPathQuery(query);
  const items: BotPromptMentionItem[] = [];
  if (
    input.browserAvailable &&
    !threadOnly &&
    ("browser".startsWith(query) || input.browserLabel?.toLowerCase().startsWith(query))
  ) {
    items.push({ kind: "browser", key: "browser", label: BROWSER_MENTION_LABEL });
  }
  if (!threadOnly) {
    for (const bot of input.bots) {
      if (bot.name.toLowerCase().startsWith(query)) {
        items.push({
          kind: "bot",
          key: `bot:${bot.id}`,
          label: bot.name,
          ...botPromptMention(bot, input.bots),
          canTakeWork: bot.canTakeWork !== false,
        });
      }
    }
  }
  for (const thread of input.threads) {
    if (pathLike && !thread.title.toLowerCase().includes(query)) continue;
    items.push({
      kind: "thread",
      key: `thread:${thread.id}`,
      label: thread.title,
      threadId: thread.id,
    });
  }
  if (!threadOnly) {
    for (const entry of input.paths ?? []) {
      const slash = entry.path.lastIndexOf("/");
      items.push({
        kind: "path",
        key: `path:${entry.path}`,
        label: entry.path.slice(slash + 1),
        path: entry.path,
        directory: entry.path.slice(0, Math.max(0, slash)),
      });
    }
  }
  return items;
}

function mentionSource(item: BotPromptMentionItem): string | null {
  switch (item.kind) {
    case "browser":
      return COMPOSER_BROWSER_MENTION;
    case "bot":
      return item.source;
    case "thread":
      return serializeComposerThreadMention(item.threadId);
    case "path":
      return serializeComposerFileLink(item.path);
  }
}

/** Replaces the typed `@query` with the chosen mention and a trailing space. */
export function applyBotPromptMention(
  draft: string,
  trigger: BotPromptMentionTrigger,
  item: BotPromptMentionItem,
): { readonly text: string; readonly caret: number } {
  const source = mentionSource(item);
  if (source === null) return { text: draft, caret: trigger.rangeEnd };
  const before = draft.slice(0, trigger.rangeStart);
  const after = draft.slice(trigger.rangeEnd).replace(/^[ \t]/, "");
  const inserted = `${source} `;
  return { text: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

export interface BotPromptMentionChip {
  readonly key: string;
  readonly kind: "browser" | "thread" | "bot";
  readonly label: string;
  readonly source: string;
  readonly start: number;
  readonly end: number;
}

/**
 * The browser, chat, and `@bot:<id>` mentions in a draft, each once, labelled for the
 * chip strip. A chat or bot the client cannot see still gets a chip so the user can remove it.
 */
export function botPromptMentionChips(
  draft: string,
  threadTitle: (threadId: string) => string | null,
  botName: (botId: string) => string | null = () => null,
): BotPromptMentionChip[] {
  return collectComposerMentionDisplays(draft, threadTitle, botName).map((display) => ({
    key:
      display.kind === "browser"
        ? "browser"
        : display.kind === "bot"
          ? `bot:${display.botId}`
          : `thread:${display.threadId}`,
    kind: display.kind,
    label: display.label,
    source: display.source,
    start: display.start,
    end: display.end,
  }));
}

/** Removes every occurrence of a chip's mention, with the space that followed it. */
export function removeBotPromptMention(draft: string, chip: BotPromptMentionChip): string {
  const tokens = collectComposerInlineTokens(`${draft}\n`).filter(
    (token) =>
      (token.type === "browser-mention" ||
        token.type === "thread-mention" ||
        token.type === "bot-mention") &&
      token.source === chip.source,
  );
  let next = draft;
  for (const token of tokens.toReversed()) {
    const end = next[token.end] === " " ? token.end + 1 : token.end;
    next = `${next.slice(0, token.start)}${next.slice(end)}`;
  }
  return next;
}
