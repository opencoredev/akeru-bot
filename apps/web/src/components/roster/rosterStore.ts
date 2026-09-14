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

function isRosterItemList(value: unknown): value is RosterItemRef[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        ((item as { kind?: unknown }).kind === "bot" ||
          (item as { kind?: unknown }).kind === "group") &&
        typeof (item as { id?: unknown }).id === "string",
    )
  );
}

function readPersistedRoster(environmentId: string | null = null): PersistedRoster | null {
  const key = persistedRosterKey(environmentId);
  const inMemory = persistedRosterMemory.get(key);
  if (inMemory) return inMemory;
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { selectedBotId, chatPathByBotId, botLayout, sections, pinnedItems, unassignedItems } =
      parsed as {
        selectedBotId?: unknown;
        chatPathByBotId?: unknown;
        botLayout?: unknown;
        sections?: unknown;
        pinnedItems?: unknown;
        unassignedItems?: unknown;
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
      ...(Array.isArray(sections) &&
      sections.every(
        (section) =>
          typeof section === "object" &&
          section !== null &&
          typeof (section as { id?: unknown }).id === "string" &&
          typeof (section as { name?: unknown }).name === "string" &&
          Array.isArray((section as { botIds?: unknown }).botIds) &&
          (section as { botIds: unknown[] }).botIds.every((id) => typeof id === "string") &&
          ((section as { groupIds?: unknown }).groupIds === undefined ||
            (Array.isArray((section as { groupIds?: unknown }).groupIds) &&
              (section as { groupIds: unknown[] }).groupIds.every(
                (id) => typeof id === "string",
              ))) &&
          ((section as { items?: unknown }).items === undefined ||
            isRosterItemList((section as { items?: unknown }).items)) &&
          typeof (section as { collapsed?: unknown }).collapsed === "boolean",
      )
        ? {
            sections: (
              sections as Array<
                Omit<LegacyRosterSection, "groupIds" | "items"> & {
                  groupIds?: string[];
                  items?: RosterItemRef[];
                }
              >
            ).map((section) => {
              const items = rosterSectionItems({
                botIds: section.botIds,
                groupIds: section.groupIds ?? [],
                items: section.items,
              });
              return {
                ...section,
                botIds: items.filter((item) => item.kind === "bot").map((item) => item.id),
                groupIds: items.filter((item) => item.kind === "group").map((item) => item.id),
                items,
              };
            }),
          }
        : {}),
      ...(isRosterItemList(pinnedItems) ? { pinnedItems } : {}),
      ...(isRosterItemList(unassignedItems) ? { unassignedItems } : {}),
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
  if (visible.some((bot) => !bot || bot.archivedAt !== null)) return null;
  const ordered = visible as Bot[];
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
      const unassignedIds = plan.order
        .filter((entry) => entry.kind === "bot")
        .map((entry) => entry.id);
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
