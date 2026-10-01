import {
  resolveSnoozePresets,
  type SnoozePresetId,
} from "@akeru/client-runtime/state/thread-settled";
import type { ScopedThreadRef } from "@akeru/contracts";
import { type ChatPaletteAction } from "../../chatActionsRegistry";
import { type ChatActions } from "../../hooks/useChatActions";
import { useI18n } from "../../i18n";
import { type ChatMenuState } from "./chatActions.logic";
import { type NewChatControl } from "./ChatActionsMenu";

export function snoozePresetLabel(id: SnoozePresetId, t: ReturnType<typeof useI18n>["t"]) {
  switch (id) {
    case "hour":
      return t("In 1 hour");
    case "three-hours":
      return t("In 3 hours");
    case "evening":
      return t("This evening");
    case "tomorrow":
      return t("Tomorrow");
    case "next-week":
      return t("Next week");
  }
}

/**
 * The open chat's palette rows, in the order its header menu lists them. Snooze
 * presets are resolved against `now`; running one re-resolves it at run time.
 */
export function buildChatPaletteActions({
  threadRef,
  state,
  newChat,
  actions,
  t,
  now,
  openRename,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly state: ChatMenuState | null;
  readonly newChat: NewChatControl | null;
  readonly actions: ChatActions;
  readonly t: ReturnType<typeof useI18n>["t"];
  readonly now: Date;
  readonly openRename: () => void;
}): ChatPaletteAction[] {
  const list: ChatPaletteAction[] = [];

  if (newChat?.canStart) {
    list.push({
      id: "new",
      title: t("New chat"),
      searchTerms: ["new chat", "fresh", "start over"],
      shortcutCommand: "chat.new",
      run: async () => {
        await newChat.start();
      },
    });
  }

  if (!threadRef || !state) return list;
  list.push({
    id: "rename",
    title: t("Rename chat"),
    searchTerms: ["rename", "title"],
    run: openRename,
  });

  if (state.supports.titleRegeneration && !state.isRegeneratingTitle) {
    list.push({
      id: "regenerate-title",
      title: t("Regenerate title"),
      searchTerms: ["regenerate", "title"],
      run: async () => {
        await actions.regenerateTitle(threadRef);
      },
    });
  }

  if (state.supports.pinning) {
    list.push(
      state.isPinned
        ? {
            id: "unpin",
            title: t("Unpin chat"),
            searchTerms: ["unpin"],
            run: async () => {
              await actions.unpin(threadRef);
            },
          }
        : {
            id: "pin",
            title: t("Pin chat"),
            searchTerms: ["pin"],
            run: async () => {
              await actions.pin(threadRef);
            },
          },
    );
  }

  if (state.canMarkUnread) {
    list.push({
      id: "mark-unread",
      title: t("Mark unread"),
      searchTerms: ["unread"],
      run: () => actions.markUnread(threadRef),
    });
  }

  if (state.supports.settlement) {
    if (state.isSettled) {
      list.push({
        id: "unsettle",
        title: t("Un-settle chat"),
        searchTerms: ["unsettle", "reopen"],
        run: async () => {
          await actions.unsettle(threadRef);
        },
      });
    } else if (state.canSettle) {
      list.push({
        id: "settle",
        title: t("Settle chat"),
        searchTerms: ["settle", "done"],
        shortcutCommand: "thread.settle",
        run: async () => {
          await actions.settle(threadRef);
        },
      });
    }
  }

  if (state.supports.snooze) {
    if (state.isSnoozed) {
      list.push({
        id: "unsnooze",
        title: t("Wake chat"),
        searchTerms: ["wake", "unsnooze"],
        run: async () => {
          await actions.unsnooze(threadRef);
        },
      });
    } else if (state.canSnooze) {
      for (const preset of resolveSnoozePresets(now)) {
        const when = snoozePresetLabel(preset.id, t);
        list.push({
          id: `snooze:${preset.id}`,
          title: t("Snooze chat: {when}", { when }),
          description: preset.whenLabel,
          searchTerms: ["snooze", "later", "remind", preset.label],
          run: async () => {
            // Re-resolve so a palette left open still snoozes relative to now.
            const current = resolveSnoozePresets(new Date()).find(
              (candidate) => candidate.id === preset.id,
            );

            if (current) await actions.snooze(threadRef, current.snoozedUntil);
          },
        });
      }
    }
  }

  if (state.canArchive) {
    list.push({
      id: "archive",
      title: t("Archive chat"),
      searchTerms: ["archive"],
      run: async () => {
        await actions.archive(threadRef);
      },
    });
  }

  list.push({
    id: "delete",
    title: t("Delete chat"),
    searchTerms: ["delete", "remove"],
    run: async () => {
      await actions.delete(threadRef);
    },
  });

  return list;
}
