import { create } from "zustand";

import { randomUUID } from "../../lib/utils";
import type { RosterLastMessage } from "./roster.logic";
import type { Bot, BotAvatar, Group } from "./types";

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
}

export interface RosterSection {
  id: string;
  name: string;
  botIds: string[];
  groupIds?: string[];
  collapsed: boolean;
}

export type RosterItemRef = { kind: "bot"; id: string } | { kind: "group"; id: string };

function firstAvailableBotId(bots: readonly Bot[]): string | null {
  return bots.find((bot) => bot.archivedAt === null)?.id ?? null;
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
    const { selectedBotId, chatPathByBotId, botLayout, sections, pinnedItems } = parsed as {
      selectedBotId?: unknown;
      chatPathByBotId?: unknown;
      botLayout?: unknown;
      sections?: unknown;
      pinnedItems?: unknown;
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
          typeof (section as { collapsed?: unknown }).collapsed === "boolean",
      )
        ? {
            sections: (
              sections as Array<Omit<RosterSection, "groupIds"> & { groupIds?: string[] }>
            ).map((section) => ({
              ...section,
              groupIds: section.groupIds ?? [],
            })),
          }
        : {}),
      ...(Array.isArray(pinnedItems) &&
      pinnedItems.every(
        (item) =>
          typeof item === "object" &&
          item !== null &&
          ((item as { kind?: unknown }).kind === "bot" ||
            (item as { kind?: unknown }).kind === "group") &&
          typeof (item as { id?: unknown }).id === "string",
      )
        ? { pinnedItems: pinnedItems as RosterItemRef[] }
        : {}),
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
  environmentId: string | null;
  selectBot: (botId: string) => void;
  setBotAvatar: (botId: string, avatar: BotAvatar) => boolean;
  commitBotLayout: (bots: Bot[]) => void;
  createSection: (name: string) => void;
  toggleSection: (sectionId: string) => void;
  deleteSection: (sectionId: string) => void;
  moveGroupToSection: (groupId: string, sectionId: string | null, index?: number) => void;
  moveBotToSection: (botId: string, sectionId: string | null, index?: number) => void;
  reorderSections: (sourceIndex: number, destinationIndex: number) => void;
  setItemPinned: (item: RosterItemRef, pinned: boolean) => void;
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
    "bots" | "selectedBotId" | "chatPathByBotId" | "sections" | "pinnedItems" | "environmentId"
  >,
) {
  persistRoster(
    {
      ...(state.selectedBotId === null ? {} : { selectedBotId: state.selectedBotId }),
      chatPathByBotId: state.chatPathByBotId,
      botLayout: state.bots.map((bot) => ({ id: bot.id, pinned: bot.pinned })),
      sections: state.sections,
      pinnedItems: state.pinnedItems,
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
    if (!get().bots.some((bot) => bot.id === botId && bot.archivedAt === null)) return;
    if (sectionId !== null && !get().sections.some((section) => section.id === sectionId)) return;
    set((state) => {
      const sections = state.sections.map((section) => {
        const botIds = section.botIds.filter((id) => id !== botId);
        if (section.id !== sectionId) return { ...section, botIds };
        botIds.splice(Math.min(Math.max(index ?? botIds.length, 0), botIds.length), 0, botId);
        return { ...section, botIds };
      });
      if (sectionId !== null) return { sections };
      const assigned = new Set(sections.flatMap((section) => section.botIds));
      const unassignedIds = state.bots
        .filter((bot) => bot.archivedAt === null && !assigned.has(bot.id) && bot.id !== botId)
        .map((bot) => bot.id);
      unassignedIds.splice(
        Math.min(Math.max(index ?? unassignedIds.length, 0), unassignedIds.length),
        0,
        botId,
      );
      const unassigned = new Set(unassignedIds);
      const botsById = new Map(state.bots.map((bot) => [bot.id, bot] as const));
      let botIndex = 0;
      return {
        sections,
        bots: state.bots.map((bot) =>
          unassigned.has(bot.id) ? (botsById.get(unassignedIds[botIndex++]!) ?? bot) : bot,
        ),
      };
    });
    saveState(get());
  },

  moveGroupToSection: (groupId, sectionId, index) => {
    if (!get().groups.some((group) => group.id === groupId)) return;
    if (sectionId !== null && !get().sections.some((section) => section.id === sectionId)) return;
    set((state) => ({
      sections: state.sections.map((section) => {
        const groupIds = (section.groupIds ?? []).filter((id) => id !== groupId);
        if (section.id !== sectionId) return { ...section, groupIds };
        groupIds.splice(
          Math.min(Math.max(index ?? groupIds.length, 0), groupIds.length),
          0,
          groupId,
        );
        return { ...section, groupIds };
      }),
    }));
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
    set({
      environmentId: input.environmentId,
      bots,
      groups: input.groups,
      chatPathByBotId: switchingEnvironment
        ? (targetPersisted?.chatPathByBotId ?? {})
        : get().chatPathByBotId,
      sections: targetSections.map((section) => ({
        ...section,
        botIds: section.botIds.filter((id) => bots.some((bot) => bot.id === id)),
        groupIds: (section.groupIds ?? []).filter((id) =>
          input.groups.some((group) => group.id === id),
        ),
      })),
      pinnedItems: targetPinnedItems.filter((item) =>
        item.kind === "bot"
          ? bots.some((bot) => bot.id === item.id && bot.archivedAt === null)
          : input.groups.some((group) => group.id === item.id),
      ),
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
