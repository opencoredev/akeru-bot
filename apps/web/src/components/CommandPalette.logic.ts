import { type KeybindingCommand, PLACEHOLDER_THREAD_TITLE } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";
import { type ReactNode } from "react";

export const ITEM_ICON_CLASS = "size-4 text-icon-muted";
export const COMMAND_PALETTE_INPUT_PLACEHOLDER = "Search commands...";

export interface CommandPaletteActionItem {
  readonly value: string;
  readonly searchTerms: ReadonlyArray<string>;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly icon: ReactNode;
  readonly disabled?: boolean;
  readonly shortcutCommand?: KeybindingCommand;
  readonly run: () => Promise<void>;
}

export interface CommandPaletteGroup {
  readonly value: string;
  readonly label: string;
  readonly items: ReadonlyArray<CommandPaletteActionItem>;
}

/**
 * The open chat's actions as palette rows, in the order its header menu lists
 * them. Each row matches its translated title as well as its English terms.
 */
export function buildChatCommandPaletteItems(input: {
  readonly actions: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly description?: string;
    readonly searchTerms: ReadonlyArray<string>;
    readonly shortcutCommand?: KeybindingCommand;
    readonly run: () => Promise<void> | void;
  }>;
  readonly icon: ReactNode;
}): CommandPaletteActionItem[] {
  return input.actions.map((action) => ({
    value: `chat:${action.id}`,
    searchTerms: [action.title, "chat", ...action.searchTerms],
    title: action.title,
    ...(action.description ? { description: action.description } : {}),
    icon: input.icon,
    ...(action.shortcutCommand ? { shortcutCommand: action.shortcutCommand } : {}),
    run: async () => {
      await action.run();
    },
  }));
}

/** Opens Settings > General at the language row; matches English and translated labels. */
export function buildLanguageCommandPaletteAction(input: {
  readonly translate: (message: string) => string;
  readonly openSettings: (section: "general", targetId: "language") => void;
  readonly icon: ReactNode;
}): CommandPaletteActionItem {
  const title = input.translate("Change language");
  return {
    value: "action:language",
    searchTerms: [
      title,
      "language",
      "locale",
      "translation",
      "English",
      "system default",
      "preferences",
      "Chinese",
      "中文",
      "简体中文",
    ],
    title,
    icon: input.icon,
    run: async () => {
      input.openSettings("general", "language");
    },
  };
}

/**
 * Opens the model picker of whichever composer registered one. Disabled when no
 * composer is mounted; the picker opens after the palette closes so focus lands in it.
 */
export function buildModelPickerCommandPaletteAction(input: {
  readonly composerHandle: { readonly openModelPicker: () => void } | null;
  readonly scheduleAfterClose: (openModelPicker: () => void) => void;
  readonly title: string;
  readonly icon: ReactNode;
}): CommandPaletteActionItem {
  return {
    value: "action:change-model",
    searchTerms: [input.title, "change model", "model", "provider", "reasoning"],
    title: input.title,
    icon: input.icon,
    disabled: input.composerHandle === null,
    shortcutCommand: "modelPicker.toggle",
    run: async () => {
      if (input.composerHandle === null) return;
      input.scheduleAfterClose(input.composerHandle.openModelPicker);
    },
  };
}

/** A chat the palette can find: its title, owner, and whether this client can open it. */
export interface CommandPaletteChat {
  readonly environmentId: string;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt: string;
  /** Bot or group name shown under the title, when known. */
  readonly ownerName: string | null;
  /** Null when the chat lives in an environment this client's chat views do not show. */
  readonly unavailableIn: string | null;
}

/** A server-side message match, already limited to one snippet per chat. */
export interface CommandPaletteChatMatch {
  readonly environmentId: string;
  readonly threadId: string;
  readonly snippet: string;
}

export const COMMAND_PALETTE_CHAT_LIMIT = 8;

/**
 * The palette's Chats results for a typed query: chats whose title contains the
 * query first, tighter matches ahead, then chats the server matched by message,
 * in its order, with the matching snippet as the description. Chats in another
 * environment are listed but disabled, because this client cannot open them,
 * and only after every chat it can open, so they never crowd one out.
 * A leading ">" asks for actions only, so it yields no chats.
 */
export function buildChatSearchCommandPaletteItems(input: {
  readonly query: string;
  readonly chats: ReadonlyArray<CommandPaletteChat>;
  readonly matches: ReadonlyArray<CommandPaletteChatMatch>;
  readonly untitledLabel: string;
  readonly unavailableLabel: (environmentLabel: string) => string;
  readonly icon: ReactNode;
  readonly openChat: (chat: CommandPaletteChat) => Promise<void>;
  readonly limit?: number;
}): CommandPaletteActionItem[] {
  if (input.query.startsWith(">")) return [];
  const normalizedQuery = normalizeSearchText(input.query);
  if (normalizedQuery.length === 0) return [];
  const limit = input.limit ?? COMMAND_PALETTE_CHAT_LIMIT;
  const chatKey = (chat: { readonly environmentId: string; readonly threadId: string }) =>
    `${chat.environmentId}:${chat.threadId}`;
  const chatsByKey = new Map(input.chats.map((chat) => [chatKey(chat), chat] as const));

  // A placeholder title says nothing about the chat, so only its messages can match.
  const titleOf = (chat: CommandPaletteChat) =>
    chat.title === PLACEHOLDER_THREAD_TITLE ? "" : chat.title.trim();
  const titleMatches = input.chats
    .map((chat, index) => ({
      chat,
      index,
      rank: rankSearchFieldMatch(titleOf(chat), normalizedQuery),
    }))
    .filter((entry) => entry.rank !== Number.NEGATIVE_INFINITY)
    .toSorted(
      (left, right) =>
        right.rank - left.rank ||
        right.chat.updatedAt.localeCompare(left.chat.updatedAt) ||
        left.index - right.index,
    )
    .map((entry) => ({ chat: entry.chat, snippet: null as string | null }));
  const seen = new Set(titleMatches.map((entry) => chatKey(entry.chat)));
  const messageMatches = input.matches.flatMap((match) => {
    const chat = chatsByKey.get(chatKey(match));
    if (!chat || seen.has(chatKey(chat))) return [];
    seen.add(chatKey(chat));
    return [{ chat, snippet: match.snippet.trim() || null }];
  });

  const ranked = [...titleMatches, ...messageMatches];
  return [
    ...ranked.filter((entry) => entry.chat.unavailableIn === null),
    ...ranked.filter((entry) => entry.chat.unavailableIn !== null),
  ]
    .slice(0, limit)
    .map(({ chat, snippet }) => {
      const description = [
        chat.ownerName,
        chat.unavailableIn === null ? null : input.unavailableLabel(chat.unavailableIn),
        snippet,
      ]
        .filter((part): part is string => part !== null && part.length > 0)
        .join(" · ");
      return {
        value: `chat-search:${chatKey(chat)}`,
        searchTerms: [titleOf(chat), snippet ?? ""],
        title: titleOf(chat) || input.untitledLabel,
        ...(description ? { description } : {}),
        icon: input.icon,
        ...(chat.unavailableIn === null ? {} : { disabled: true }),
        run: async () => {
          await input.openChat(chat);
        },
      };
    });
}

export function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function rankSearchFieldMatch(field: string, normalizedQuery: string): number {
  const normalizedField = normalizeSearchText(field);
  if (normalizedField.length === 0 || !normalizedField.includes(normalizedQuery)) {
    return Number.NEGATIVE_INFINITY;
  }
  if (normalizedField === normalizedQuery) {
    return 3;
  }
  if (normalizedField.startsWith(normalizedQuery)) {
    return 2;
  }
  return 1;
}

function rankCommandPaletteItemMatch(
  item: CommandPaletteActionItem,
  normalizedQuery: string,
): number {
  const terms = item.searchTerms.filter((term) => term.length > 0);
  for (const [index, field] of terms.entries()) {
    const fieldRank = rankSearchFieldMatch(field, normalizedQuery);
    if (fieldRank !== Number.NEGATIVE_INFINITY) {
      return 1_000 - index * 100 + fieldRank;
    }
  }
  return 0;
}

/**
 * Filters each group to the items whose search terms contain the query, ranking
 * earlier and tighter term matches first. A leading ">" is accepted and ignored
 * so the VS Code habit of typing it still works.
 */
export function filterCommandPaletteGroups(input: {
  readonly groups: ReadonlyArray<CommandPaletteGroup>;
  readonly query: string;
}): CommandPaletteGroup[] {
  const searchQuery = input.query.startsWith(">") ? input.query.slice(1) : input.query;
  const normalizedQuery = normalizeSearchText(searchQuery);
  if (normalizedQuery.length === 0) {
    return [...input.groups];
  }

  return input.groups.flatMap((group) => {
    const items = Arr.filterMap(group.items, (item, index) => {
      const haystack = normalizeSearchText(item.searchTerms.join(" "));
      if (!haystack.includes(normalizedQuery)) {
        return Result.failVoid;
      }
      return Result.succeed({
        item,
        index,
        rank: rankCommandPaletteItemMatch(item, normalizedQuery),
      });
    })
      .toSorted((left, right) => right.rank - left.rank || left.index - right.index)
      .map((entry) => entry.item);

    return items.length === 0 ? [] : [{ value: group.value, label: group.label, items }];
  });
}
