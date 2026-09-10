import { create } from "zustand";

import { randomUUID } from "../../lib/utils";
import {
  rosterItemKey,
  rosterItemsEqual,
  rosterSectionItems,
  splitRosterSectionItems,
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
  sections?: RosterSection[];
  pinnedItems?: RosterItemRef[];
  unassignedItems?: RosterItemRef[];
}

export interface RosterSection {
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

function withSectionItems(section: RosterSection, items: readonly RosterItemRef[]): RosterSection {
  const split = splitRosterSectionItems(items);
  return {
    ...section,
    items: [...items],
    botIds: split.botIds,
    groupIds: split.groupIds,
  };
}

function removeItemFromSections(
  sections: readonly RosterSection[],
  item: RosterItemRef,
): RosterSection[] {
  return sections.map((section) =>
    withSectionItems(
      section,
      rosterSectionItems(section).filter((candidate) => !rosterItemsEqual(candidate, item)),
    ),
  );
}

/** Insert `moved` into `previous` using the visible drop order, keeping
 * hidden (pinned) members in place so pin state is not a membership change. */
function mergeVisibleOrder(
  previous: readonly RosterItemRef[],
  visibleOrder: readonly RosterItemRef[],
  moved: RosterItemRef,
): RosterItemRef[] {
  const withoutMoved = previous.filter((item) => !rosterItemsEqual(item, moved));
  const movedIndex = visibleOrder.findIndex((item) => rosterItemsEqual(item, moved));
  const after = movedIndex >= 0 ? visibleOrder[movedIndex + 1] : undefined;
  const insertAt =
    after === undefined
      ? withoutMoved.length
      : withoutMoved.findIndex((item) => rosterItemsEqual(item, after));
  const next = [...withoutMoved];
  next.splice(insertAt < 0 ? next.length : insertAt, 0, moved);
  return next;
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
                Omit<RosterSection, "groupIds" | "items"> & {
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
              const split = splitRosterSectionItems(items);
              return {
                ...section,
                botIds: split.botIds,
                groupIds: split.groupIds,
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

interface RosterStore {
  bots: Bot[];
  groups: Group[];
  lastMessageByBotId: Record<string, RosterLastMessage>;
  selectedBotId: string | null;
  chatPathByBotId: Record<string, string>;
  sections: RosterSection[];
  pinnedItems: RosterItemRef[];
  unassignedItems: RosterItemRef[];
  environmentId: string | null;
  selectBot: (botId: string) => void;
  setBotAvatar: (botId: string, avatar: BotAvatar) => boolean;
  commitBotLayout: (bots: Bot[]) => void;
  createSection: (name: string) => void;
  toggleSection: (sectionId: string) => void;
  deleteSection: (sectionId: string) => void;
  moveGroupToSection: (groupId: string, sectionId: string | null, index?: number) => void;
  moveBotToSection: (botId: string, sectionId: string | null, index?: number) => void;
  moveItemToSection: (item: RosterItemRef, sectionId: string | null, index?: number) => void;
  reorderSections: (sourceIndex: number, destinationIndex: number) => void;
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
    | "sections"
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
      sections: state.sections,
      pinnedItems: state.pinnedItems,
      unassignedItems: state.unassignedItems,
    },
    state.environmentId,
  );
}

const persisted = readPersistedRoster();

export const useRosterStore = create<RosterStore>((set, get) => ({
  bots: [],
  groups: [],
  lastMessageByBotId: {},
  selectedBotId: persisted?.selectedBotId ?? null,
  chatPathByBotId: persisted?.chatPathByBotId ?? {},
  sections: persisted?.sections ?? [],
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

  createSection: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => ({
      sections: [
        ...state.sections,
        {
          id: randomUUID(),
          name: trimmed,
          botIds: [],
          groupIds: [],
          items: [],
          collapsed: false,
        },
      ],
    }));
    saveState(get());
  },

  toggleSection: (sectionId) => {
    set((state) => ({
      sections: state.sections.map((section) =>
        section.id === sectionId ? { ...section, collapsed: !section.collapsed } : section,
      ),
    }));
    saveState(get());
  },

  deleteSection: (sectionId) => {
    if (!get().sections.some((section) => section.id === sectionId)) return;
    set((state) => ({
      sections: state.sections.filter((section) => section.id !== sectionId),
    }));
    saveState(get());
  },

  moveBotToSection: (botId, sectionId, index) => {
    get().moveItemToSection({ kind: "bot", id: botId }, sectionId, index);
  },

  moveGroupToSection: (groupId, sectionId, index) => {
    get().moveItemToSection({ kind: "group", id: groupId }, sectionId, index);
  },

  moveItemToSection: (item, sectionId, index) => {
    if (
      item.kind === "bot" &&
      !get().bots.some((bot) => bot.id === item.id && bot.archivedAt === null)
    ) {
      return;
    }
    if (item.kind === "group" && !get().groups.some((group) => group.id === item.id)) return;
    if (sectionId !== null && !get().sections.some((section) => section.id === sectionId)) return;
    set((state) => {
      const sections = removeItemFromSections(state.sections, item).map((section) => {
        if (section.id !== sectionId) return section;
        const items = rosterSectionItems(section);
        items.splice(Math.min(Math.max(index ?? items.length, 0), items.length), 0, item);
        return withSectionItems(section, items);
      });
      const assignedKeys = new Set(
        sections.flatMap((section) => rosterSectionItems(section).map(rosterItemKey)),
      );
      const remainingUnassigned = state.unassignedItems.filter(
        (candidate) =>
          !rosterItemsEqual(candidate, item) && !assignedKeys.has(rosterItemKey(candidate)),
      );
      if (sectionId !== null) {
        return { sections, unassignedItems: remainingUnassigned };
      }
      remainingUnassigned.splice(
        Math.min(Math.max(index ?? remainingUnassigned.length, 0), remainingUnassigned.length),
        0,
        item,
      );
      if (item.kind !== "bot") {
        return { sections, unassignedItems: remainingUnassigned };
      }
      const assignedBotIds = new Set(sections.flatMap((section) => section.botIds));
      const unassignedIds = state.bots
        .filter(
          (bot) => bot.archivedAt === null && !assignedBotIds.has(bot.id) && bot.id !== item.id,
        )
        .map((bot) => bot.id);
      unassignedIds.splice(
        Math.min(Math.max(index ?? unassignedIds.length, 0), unassignedIds.length),
        0,
        item.id,
      );
      const unassigned = new Set(unassignedIds);
      const botsById = new Map(state.bots.map((bot) => [bot.id, bot] as const));
      let botIndex = 0;
      return {
        sections,
        unassignedItems: remainingUnassigned,
        bots: state.bots.map((bot) =>
          unassigned.has(bot.id) ? (botsById.get(unassignedIds[botIndex++]!) ?? bot) : bot,
        ),
      };
    });
    saveState(get());
  },

  applyRosterDrop: (plan) => {
    if (plan.kind === "none") return;
    if (plan.kind === "reorder-section") {
      get().reorderSections(plan.fromIndex, plan.toIndex);
      return;
    }
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
    set((state) => {
      const pinnedItems = plan.unpin
        ? state.pinnedItems.filter((candidate) => !rosterItemsEqual(candidate, plan.item))
        : state.pinnedItems;
      const sectionId = typeof plan.zone === "object" ? plan.zone.sectionId : null;
      const sections = removeItemFromSections(state.sections, plan.item).map((section) => {
        if (section.id !== sectionId) return section;
        return withSectionItems(
          section,
          mergeVisibleOrder(rosterSectionItems(section), plan.order, plan.item),
        );
      });
      const unassignedItems =
        sectionId === null
          ? [...plan.order]
          : state.unassignedItems.filter((candidate) => !rosterItemsEqual(candidate, plan.item));
      if (plan.item.kind !== "bot" || sectionId !== null) {
        return { pinnedItems, sections, unassignedItems };
      }
      const assignedBotIds = new Set(sections.flatMap((section) => section.botIds));
      const unassignedIds = plan.order
        .filter((entry) => entry.kind === "bot")
        .map((entry) => entry.id);
      const unassigned = new Set(unassignedIds);
      const botsById = new Map(state.bots.map((bot) => [bot.id, bot] as const));
      let botIndex = 0;
      return {
        pinnedItems,
        sections,
        unassignedItems,
        bots: state.bots.map((bot) =>
          unassigned.has(bot.id) && !assignedBotIds.has(bot.id)
            ? (botsById.get(unassignedIds[botIndex++]!) ?? bot)
            : bot,
        ),
      };
    });
    saveState(get());
  },

  reorderSections: (sourceIndex, destinationIndex) => {
    if (
      sourceIndex === destinationIndex ||
      sourceIndex < 0 ||
      destinationIndex < 0 ||
      sourceIndex >= get().sections.length ||
      destinationIndex >= get().sections.length
    ) {
      return;
    }
    const sections = [...get().sections];
    const [moved] = sections.splice(sourceIndex, 1);
    if (!moved) return;
    sections.splice(destinationIndex, 0, moved);
    set({ sections });
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
    const scopedPersisted = switchingEnvironment ? readPersistedRoster(input.environmentId) : null;
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
    const targetSections = switchingEnvironment
      ? (targetPersisted?.sections ?? [])
      : get().sections;
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
    const sections = targetSections.map((section) =>
      withSectionItems(section, rosterSectionItems(section).filter(liveItem)),
    );
    set({
      environmentId: input.environmentId,
      bots,
      groups: input.groups,
      chatPathByBotId: switchingEnvironment
        ? (targetPersisted?.chatPathByBotId ?? {})
        : get().chatPathByBotId,
      sections,
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
