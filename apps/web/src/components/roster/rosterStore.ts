import { create } from "zustand";

import type { RosterLastMessage } from "./roster.logic";
import type { Bot, BotAvatar, Group } from "./types";

const PERSISTED_ROSTER_KEY = "akeru:roster:v1";

interface PersistedRoster {
  selectedBotId?: string;
  chatPathByBotId?: Record<string, string>;
  botLayout?: Array<{ id: string; pinned: boolean }>;
}

function firstAvailableBotId(bots: readonly Bot[]): string | null {
  return bots.find((bot) => bot.archivedAt === null)?.id ?? null;
}

function readPersistedRoster(): PersistedRoster | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(PERSISTED_ROSTER_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { selectedBotId, chatPathByBotId, botLayout } = parsed as {
      selectedBotId?: unknown;
      chatPathByBotId?: unknown;
      botLayout?: unknown;
    };
    return {
      ...(typeof selectedBotId === "string" ? { selectedBotId } : {}),
      ...(typeof chatPathByBotId === "object" && chatPathByBotId !== null
        ? { chatPathByBotId: chatPathByBotId as Record<string, string> }
        : {}),
      ...(Array.isArray(botLayout) &&
      botLayout.every(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          typeof (entry as { id?: unknown }).id === "string" &&
          typeof (entry as { pinned?: unknown }).pinned === "boolean",
      )
        ? { botLayout: botLayout as Array<{ id: string; pinned: boolean }> }
        : {}),
    };
  } catch {
    return null;
  }
}

function persistRoster(roster: PersistedRoster): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PERSISTED_ROSTER_KEY, JSON.stringify(roster));
  } catch (error) {
    console.error("Could not persist bot roster.", error);
  }
}

interface RosterStore {
  bots: Bot[];
  groups: Group[];
  lastMessageByBotId: Record<string, RosterLastMessage>;
  selectedBotId: string | null;
  chatPathByBotId: Record<string, string>;
  selectBot: (botId: string) => void;
  setBotAvatar: (botId: string, avatar: BotAvatar) => boolean;
  commitBotLayout: (bots: Bot[]) => void;
  recordLastMessage: (botId: string, message: RosterLastMessage) => void;
  recordChatPath: (botId: string, path: string) => void;
  forgetChatPath: (botId: string) => void;
  replaceRoster: (input: {
    bots: Bot[];
    groups: Group[];
    lastMessageByBotId?: Record<string, RosterLastMessage>;
  }) => void;
}

export function reorderVisibleRosterBots(
  bots: readonly Bot[],
  visibleBotIds: readonly string[],
  sourceIndex: number,
  destinationIndex: number,
): Bot[] | null {
  if (
    sourceIndex === destinationIndex ||
    sourceIndex < 0 ||
    destinationIndex < 0 ||
    sourceIndex >= visibleBotIds.length ||
    destinationIndex >= visibleBotIds.length ||
    new Set(visibleBotIds).size !== visibleBotIds.length
  ) {
    return null;
  }
  const byId = new Map(bots.map((bot) => [bot.id, bot] as const));
  const visible = visibleBotIds.map((id) => byId.get(id));
  if (visible.some((bot) => !bot || bot.archivedAt !== null)) return null;
  const ordered = visible as Bot[];
  const [moved] = ordered.splice(sourceIndex, 1);
  if (!moved) return null;
  ordered.splice(destinationIndex, 0, moved);
  const visibleIds = new Set(visibleBotIds);
  let index = 0;
  return bots.map((bot) => (visibleIds.has(bot.id) ? ordered[index++]! : bot));
}

function saveState(state: Pick<RosterStore, "bots" | "selectedBotId" | "chatPathByBotId">) {
  persistRoster({
    ...(state.selectedBotId === null ? {} : { selectedBotId: state.selectedBotId }),
    chatPathByBotId: state.chatPathByBotId,
    botLayout: state.bots.map((bot) => ({ id: bot.id, pinned: bot.pinned })),
  });
}

const persisted = readPersistedRoster();

export const useRosterStore = create<RosterStore>((set, get) => ({
  bots: [],
  groups: [],
  lastMessageByBotId: {},
  selectedBotId: persisted?.selectedBotId ?? null,
  chatPathByBotId: persisted?.chatPathByBotId ?? {},

  selectBot: (botId) => {
    if (!get().bots.some((bot) => bot.id === botId && bot.archivedAt === null)) return;
    if (get().selectedBotId === botId) return;
    set({ selectedBotId: botId });
    saveState(get());
  },

  setBotAvatar: (botId, avatar) => {
    set((state) => ({
      bots: state.bots.map((bot) =>
        bot.id === botId ? { ...bot, avatar, updatedAt: new Date().toISOString() } : bot,
      ),
    }));
    saveState(get());
    return true;
  },

  commitBotLayout: (bots) => {
    const current = get().bots;
    if (
      bots.length !== current.length ||
      new Set(bots.map((bot) => bot.id)).size !== bots.length ||
      bots.some((bot) => !current.some((candidate) => candidate.id === bot.id))
    ) {
      return;
    }
    const currentById = new Map(current.map((bot) => [bot.id, bot]));
    const committed = bots.map((bot) => {
      const previous = currentById.get(bot.id)!;
      return previous.pinned === bot.pinned
        ? previous
        : { ...previous, pinned: bot.pinned, updatedAt: new Date().toISOString() };
    });
    set({ bots: committed });
    saveState(get());
  },

  recordLastMessage: (botId, message) => {
    set((state) => ({ lastMessageByBotId: { ...state.lastMessageByBotId, [botId]: message } }));
  },

  recordChatPath: (botId, path) => {
    if (get().chatPathByBotId[botId] === path) return;
    set((state) => ({ chatPathByBotId: { ...state.chatPathByBotId, [botId]: path } }));
    saveState(get());
  },

  forgetChatPath: (botId) => {
    if (get().chatPathByBotId[botId] === undefined) return;
    const chatPathByBotId = { ...get().chatPathByBotId };
    delete chatPathByBotId[botId];
    set({ chatPathByBotId });
    saveState(get());
  },

  replaceRoster: (input) => {
    const currentLayout =
      get().bots.length > 0
        ? get().bots.map((bot) => ({ id: bot.id, pinned: bot.pinned }))
        : (persisted?.botLayout ?? []);
    const orderById = new Map(currentLayout.map((entry, index) => [entry.id, index] as const));
    const pinnedById = new Map(currentLayout.map((entry) => [entry.id, entry.pinned] as const));
    const bots = input.bots
      .map((bot) => ({ ...bot, pinned: pinnedById.get(bot.id) ?? false }))
      .sort(
        (left, right) =>
          (orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );
    const selectedBotId = bots.some(
      (bot) => bot.id === get().selectedBotId && bot.archivedAt === null,
    )
      ? get().selectedBotId
      : firstAvailableBotId(bots);
    set({
      bots,
      groups: input.groups,
      selectedBotId,
      ...(input.lastMessageByBotId ? { lastMessageByBotId: input.lastMessageByBotId } : {}),
    });
    saveState(get());
  },
}));

export function useSelectedBot(): Bot | null {
  return useRosterStore((state) =>
    state.selectedBotId === null
      ? null
      : (state.bots.find((bot) => bot.id === state.selectedBotId) ?? null),
  );
}
