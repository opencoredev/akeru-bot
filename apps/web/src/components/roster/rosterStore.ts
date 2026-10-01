import { Option, Schema } from "effect";
import { create } from "zustand";

import {
  moveRosterItemInOrder,
  rosterItemKey,
  rosterItemsEqual,
  rosterSectionItems,
  type RosterDropPlan,
  type RosterItemRef,
  type RosterLastMessage,
} from "./roster.logic";
import type { Bot, BotAvatar, Group } from "./types";

export type { RosterItemRef };

const PERSISTED_ROSTER_KEY = "akeru:roster:v1";

const persistedRosterMemory = new Map<string, PersistedRoster>();

function persistedRosterKey(environmentId: string | null): string {
  return environmentId ? `${PERSISTED_ROSTER_KEY}:${environmentId}` : PERSISTED_ROSTER_KEY;
}

interface PersistedRoster {
  selectedBotId?: string;
  chatPathByBotId?: Record<string, string>;
  botLayout?: Array<{ id: string; pinned: boolean }>;
  sections?: LegacyRosterSection[];
  pinnedItems?: RosterItemRef[];
  unassignedItems?: RosterItemRef[];
}

interface LegacyRosterSection {
  id: string;
  name: string;
  botIds: string[];
  groupIds?: string[];
  items?: RosterItemRef[];
  collapsed: boolean;
}

function firstAvailableBotId(bots: readonly Bot[]): string | null {
  return bots.find((bot) => bot.archivedAt === null)?.id ?? null;
}

const RosterItem = Schema.Struct({ kind: Schema.Literals(["bot", "group"]), id: Schema.String });

const decodeItems = Schema.decodeUnknownOption(Schema.Array(RosterItem));

const decodeBotLayout = Schema.decodeUnknownOption(
  Schema.Array(Schema.Struct({ id: Schema.String, pinned: Schema.Boolean })),
);

const decodeSections = Schema.decodeUnknownOption(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      botIds: Schema.Array(Schema.String),
      groupIds: Schema.optionalKey(Schema.Array(Schema.String)),
      items: Schema.optionalKey(Schema.Array(RosterItem)),
      collapsed: Schema.Boolean,
    }),
  ),
);

const decodePaths = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.String));

const decodeString = Schema.decodeUnknownOption(Schema.String);

const decodeStoredRoster = Schema.decodeUnknownSync(
  Schema.Struct({
    selectedBotId: Schema.optionalKey(Schema.Unknown),
    chatPathByBotId: Schema.optionalKey(Schema.Unknown),
    botLayout: Schema.optionalKey(Schema.Unknown),
    sections: Schema.optionalKey(Schema.Unknown),
    pinnedItems: Schema.optionalKey(Schema.Unknown),
    unassignedItems: Schema.optionalKey(Schema.Unknown),
  }),
);

function readPersistedRoster(environmentId: string | null = null): PersistedRoster | null {
  const key = persistedRosterKey(environmentId);
  const inMemory = persistedRosterMemory.get(key);

  if (inMemory) return inMemory;

  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(key);

    if (raw === null) return null;
    const parsed = decodeStoredRoster(JSON.parse(raw));
    const selectedBotId = Option.getOrUndefined(decodeString(parsed.selectedBotId));
    const chatPathByBotId = Option.getOrUndefined(decodePaths(parsed.chatPathByBotId));
    const botLayout = Option.getOrUndefined(decodeBotLayout(parsed.botLayout));
    const sections = Option.getOrUndefined(decodeSections(parsed.sections));
    const pinnedItems = Option.getOrUndefined(decodeItems(parsed.pinnedItems));
    const unassignedItems = Option.getOrUndefined(decodeItems(parsed.unassignedItems));

    return {
      ...(selectedBotId === undefined ? {} : { selectedBotId }),
      ...(chatPathByBotId === undefined ? {} : { chatPathByBotId: { ...chatPathByBotId } }),
      ...(botLayout === undefined ? {} : { botLayout: [...botLayout] }),
      ...(sections === undefined
        ? {}
        : {
            sections: sections.map((section) => {
              const items = rosterSectionItems({
                botIds: section.botIds,
                groupIds: section.groupIds ?? [],
                items: section.items,
              });

              return {
                ...section,
                botIds: items.flatMap((item) => (item.kind === "bot" ? [item.id] : [])),
                groupIds: items.flatMap((item) => (item.kind === "group" ? [item.id] : [])),
                items,
              };
            }),
          }),
      ...(pinnedItems === undefined ? {} : { pinnedItems: [...pinnedItems] }),
      ...(unassignedItems === undefined ? {} : { unassignedItems: [...unassignedItems] }),
    };
  } catch {
    return null;
  }
}

function persistRoster(roster: PersistedRoster, environmentId: string | null): void {
  const key = persistedRosterKey(environmentId);
  persistedRosterMemory.set(key, roster);

  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(key, JSON.stringify(roster));
  } catch (error) {
    console.error("Could not persist bot roster.", error);
  }
}

export function flattenPersistedSections(roster: PersistedRoster | null): PersistedRoster | null {
  if (!roster) return null;
  const unassignedItems: RosterItemRef[] = [];
  const seen = new Set<string>();

  for (const item of [
    ...(roster.sections ?? []).flatMap((section) => rosterSectionItems(section)),
    ...(roster.unassignedItems ?? []),
  ]) {
    const key = rosterItemKey(item);

    if (seen.has(key)) continue;
    seen.add(key);
    unassignedItems.push(item);
  }

  return { ...roster, sections: [], unassignedItems };
}

interface RosterStore {
  bots: Bot[];
  groups: Group[];
  lastMessageByBotId: Record<string, RosterLastMessage>;
  selectedBotId: string | null;
  chatPathByBotId: Record<string, string>;
  /**
   * The older chat the user opened for a bot, by thread id. Session-only: the
   * bot's view falls back to its newest chat when this is unset or no longer
   * one of the bot's active chats.
   */
  openChatByBotId: Record<string, string>;
  pinnedItems: RosterItemRef[];
  unassignedItems: RosterItemRef[];
  environmentId: string | null;
  selectBot: (botId: string) => void;
  setBotAvatar: (botId: string, avatar: BotAvatar) => boolean;
  commitBotLayout: (bots: Bot[]) => void;
  nudgeRosterItem: (item: RosterItemRef, delta: -1 | 1) => void;
  setItemPinned: (item: RosterItemRef, pinned: boolean) => void;
  applyRosterDrop: (plan: RosterDropPlan) => void;
  recordLastMessage: (botId: string, message: RosterLastMessage) => void;
  recordChatPath: (botId: string, path: string) => void;
  forgetChatPath: (botId: string) => void;
  /**
   * Opens one of the bot's chats; null returns the bot to its newest chat. `chatPath` also
   * remembers the opened chat, so an older remembered chat cannot take its place.
   */
  openBotChat: (botId: string, threadId: string | null, chatPath?: string) => void;
  replaceRoster: (input: {
    environmentId: string;
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

  if (!visible.every((bot): bot is Bot => bot !== undefined && bot.archivedAt === null))
    return null;
  const ordered = visible;
  const [moved] = ordered.splice(sourceIndex, 1);

  if (!moved) return null;
  ordered.splice(destinationIndex, 0, moved);
  const visibleIds = new Set(visibleBotIds);
  let index = 0;

  return bots.map((bot) => (visibleIds.has(bot.id) ? ordered[index++]! : bot));
}

function saveState(
  state: Pick<
    RosterStore,
    | "bots"
    | "selectedBotId"
    | "chatPathByBotId"
    | "pinnedItems"
    | "unassignedItems"
    | "environmentId"
  >,
) {
  persistRoster(
    {
      ...(state.selectedBotId === null ? {} : { selectedBotId: state.selectedBotId }),
      chatPathByBotId: state.chatPathByBotId,
      botLayout: state.bots.map((bot) => ({ id: bot.id, pinned: bot.pinned })),
      pinnedItems: state.pinnedItems,
      unassignedItems: state.unassignedItems,
    },
    state.environmentId,
  );
}

const persisted = flattenPersistedSections(readPersistedRoster());

export const useRosterStore = create<RosterStore>((set, get) => ({
  bots: [],
  groups: [],
  lastMessageByBotId: {},
  selectedBotId: persisted?.selectedBotId ?? null,
  chatPathByBotId: persisted?.chatPathByBotId ?? {},
  openChatByBotId: {},
  pinnedItems: persisted?.pinnedItems ?? [],
  unassignedItems: persisted?.unassignedItems ?? [],
  environmentId: null,

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
        : {
            ...previous,
            pinned: bot.pinned,
            updatedAt: new Date().toISOString(),
          };
    });

    set({ bots: committed });
    saveState(get());
  },

  applyRosterDrop: (plan) => {
    if (plan.kind === "none") return;

    if (plan.kind === "reorder-section") return;

    if (plan.kind === "reorder-pinned") {
      set({ pinnedItems: [...plan.order] });
      saveState(get());

      return;
    }

    if (plan.kind === "pin") {
      set({ pinnedItems: [...plan.order] });
      saveState(get());

      return;
    }

    if (plan.zone !== "unassigned") return;
    set((state) => {
      const pinnedItems = plan.unpin
        ? state.pinnedItems.filter((candidate) => !rosterItemsEqual(candidate, plan.item))
        : state.pinnedItems;

      const unassignedItems = [...plan.order];

      if (plan.item.kind !== "bot") {
        return { pinnedItems, unassignedItems };
      }

      const unassignedIds = plan.order.flatMap((entry) => (entry.kind === "bot" ? [entry.id] : []));

      const unassigned = new Set(unassignedIds);
      const botsById = new Map(state.bots.map((bot) => [bot.id, bot] as const));
      let botIndex = 0;

      return {
        pinnedItems,
        unassignedItems,
        bots: state.bots.map((bot) =>
          unassigned.has(bot.id) ? (botsById.get(unassignedIds[botIndex++]!) ?? bot) : bot,
        ),
      };
    });
    saveState(get());
  },

  nudgeRosterItem: (item, delta) => {
    const state = get();
    const pinned = moveRosterItemInOrder(state.pinnedItems, item, delta);

    if (pinned) {
      set({ pinnedItems: pinned });
      saveState(get());

      return;
    }

    const pinnedKeys = new Set(state.pinnedItems.map(rosterItemKey));
    const remaining = (candidate: RosterItemRef) => !pinnedKeys.has(rosterItemKey(candidate));
    const unassigned = state.unassignedItems.filter(remaining);
    const seen = new Set(unassigned.map(rosterItemKey));

    for (const group of state.groups) {
      const candidate = { kind: "group" as const, id: group.id };

      if (remaining(candidate) && !seen.has(rosterItemKey(candidate))) {
        unassigned.push(candidate);
        seen.add(rosterItemKey(candidate));
      }
    }

    for (const bot of state.bots) {
      const candidate = { kind: "bot" as const, id: bot.id };

      if (bot.archivedAt === null && remaining(candidate) && !seen.has(rosterItemKey(candidate))) {
        unassigned.push(candidate);
        seen.add(rosterItemKey(candidate));
      }
    }

    const movedUnassigned = moveRosterItemInOrder(unassigned, item, delta);

    if (!movedUnassigned) return;
    set({ unassignedItems: movedUnassigned });
    saveState(get());
  },

  setItemPinned: (item, pinned) => {
    set((state) => {
      const withoutItem = state.pinnedItems.filter(
        (candidate) => candidate.kind !== item.kind || candidate.id !== item.id,
      );

      return { pinnedItems: pinned ? [...withoutItem, item] : withoutItem };
    });
    saveState(get());
  },

  recordLastMessage: (botId, message) => {
    set((state) => ({
      lastMessageByBotId: { ...state.lastMessageByBotId, [botId]: message },
    }));
  },

  recordChatPath: (botId, path) => {
    if (get().chatPathByBotId[botId] === path) return;
    set((state) => ({
      chatPathByBotId: { ...state.chatPathByBotId, [botId]: path },
    }));
    saveState(get());
  },

  forgetChatPath: (botId) => {
    if (get().chatPathByBotId[botId] === undefined) return;
    const chatPathByBotId = { ...get().chatPathByBotId };
    delete chatPathByBotId[botId];
    set({ chatPathByBotId });
    saveState(get());
  },

  openBotChat: (botId, threadId, chatPath) => {
    if (chatPath !== undefined) get().recordChatPath(botId, chatPath);
    const current = get().openChatByBotId[botId];

    if ((current ?? null) === threadId) return;
    const openChatByBotId = { ...get().openChatByBotId };

    if (threadId === null) delete openChatByBotId[botId];
    else openChatByBotId[botId] = threadId;
    set({ openChatByBotId });
  },

  replaceRoster: (input) => {
    const switchingEnvironment = get().environmentId !== input.environmentId;

    const scopedPersisted = switchingEnvironment
      ? flattenPersistedSections(readPersistedRoster(input.environmentId))
      : null;

    const targetPersisted = switchingEnvironment
      ? (scopedPersisted ?? (get().environmentId === null ? persisted : null))
      : null;

    const currentLayout =
      !switchingEnvironment && get().bots.length > 0
        ? get().bots.map((bot) => ({ id: bot.id, pinned: bot.pinned }))
        : (targetPersisted?.botLayout ?? []);

    const orderById = new Map(currentLayout.map((entry, index) => [entry.id, index] as const));
    const pinnedById = new Map(currentLayout.map((entry) => [entry.id, entry.pinned] as const));

    const bots = input.bots
      .map((bot) => ({ ...bot, pinned: pinnedById.get(bot.id) ?? false }))
      .sort(
        (left, right) =>
          (orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      );

    const targetSelectedBotId = switchingEnvironment
      ? (targetPersisted?.selectedBotId ?? null)
      : get().selectedBotId;

    const selectedBotId = bots.some(
      (bot) => bot.id === targetSelectedBotId && bot.archivedAt === null,
    )
      ? targetSelectedBotId
      : firstAvailableBotId(bots);

    const targetPinnedItems = switchingEnvironment
      ? (targetPersisted?.pinnedItems ?? [])
      : get().pinnedItems;

    const targetUnassignedItems = switchingEnvironment
      ? (targetPersisted?.unassignedItems ?? [])
      : get().unassignedItems;

    const liveItem = (item: RosterItemRef) =>
      item.kind === "bot"
        ? bots.some((bot) => bot.id === item.id && bot.archivedAt === null)
        : input.groups.some((group) => group.id === item.id);

    set({
      environmentId: input.environmentId,
      bots,
      groups: input.groups,
      chatPathByBotId: switchingEnvironment
        ? (targetPersisted?.chatPathByBotId ?? {})
        : get().chatPathByBotId,
      openChatByBotId: switchingEnvironment ? {} : get().openChatByBotId,
      pinnedItems: targetPinnedItems.filter(liveItem),
      unassignedItems: targetUnassignedItems.filter(liveItem),
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
