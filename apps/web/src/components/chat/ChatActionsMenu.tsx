import { useAtomValue } from "@effect/atom-react";
import { MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  resolveSnoozePresets,
  type SnoozePresetId,
} from "@t3tools/client-runtime/state/thread-settled";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  AlarmClockIcon,
  ArchiveIcon,
  CheckCheckIcon,
  CircleDotIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  RefreshCwIcon,
  SquarePenIcon,
  SunIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { registerChatPaletteActions, type ChatPaletteAction } from "../../chatActionsRegistry";
import { type ChatActions, useChatActions } from "../../hooks/useChatActions";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useI18n } from "../../i18n";
import { resolveShortcutCommand } from "../../keybindings";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import {
  readEnvironmentSupportsPinning,
  readEnvironmentSupportsSettlement,
  readEnvironmentSupportsSnooze,
  readEnvironmentSupportsTitleRegeneration,
  useThreadShell,
} from "../../state/entities";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { resolveChatMenuState, type ChatMenuState, watchChatVisits } from "./chatActions.logic";

/** Starts a fresh chat with the open bot. Groups keep a single chat, so they pass none. */
export interface NewChatControl {
  readonly canStart: boolean;
  readonly start: () => Promise<boolean>;
}

/**
 * Marks the open chat as seen while the page is visible and focused. It runs
 * when the chat opens, when a turn finishes, and when the page comes back into
 * view, not after Mark unread, so the chat stays unread until the user leaves
 * the chat or the window and comes back.
 */
export function useMarkChatVisited(threadRef: ScopedThreadRef | null): void {
  const shell = useThreadShell(threadRef);
  const completedAt = shell?.latestTurn?.completedAt ?? null;
  const markThreadVisited = useUiStateStore((state) => state.markThreadVisited);
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  useEffect(() => {
    if (!threadKey) return;
    return watchChatVisits({
      page: document,
      window,
      completedAt,
      now: () => new Date(),
      markVisited: (visitedAt) => markThreadVisited(threadKey, visitedAt),
    });
  }, [completedAt, markThreadVisited, threadKey]);
}

function snoozePresetLabel(id: SnoozePresetId, t: ReturnType<typeof useI18n>["t"]) {
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

/**
 * The open chat's state and its menu in the chat header: rename, regenerate
 * the title, pin, mark unread, settle, snooze, archive, and delete. The same
 * actions are published to the command palette, and `chat.new` and
 * `thread.settle` shortcuts run here while the chat is open.
 */
export function ChatActionsMenu({
  threadRef,
  newChat = null,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly newChat?: NewChatControl | null;
}) {
  const { t, formatDate } = useI18n();
  const actions = useChatActions();
  const shell = useThreadShell(threadRef);
  // Minute-quantized UTC, so the menu re-reads settle and snooze state once a minute.
  const nowMinute = useNowMinute();
  const now = `${nowMinute}:00.000Z`;
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const lastVisitedAt = useUiStateStore((state) =>
    threadRef ? state.threadLastVisitedAtById[scopedThreadKey(threadRef)] : undefined,
  );
  const [renaming, setRenaming] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");

  const state = useMemo(
    () =>
      threadRef && shell
        ? resolveChatMenuState({
            shell,
            lastVisitedAt,
            now,
            supports: {
              settlement: readEnvironmentSupportsSettlement(threadRef.environmentId),
              snooze: readEnvironmentSupportsSnooze(threadRef.environmentId),
              pinning: readEnvironmentSupportsPinning(threadRef.environmentId),
              titleRegeneration: readEnvironmentSupportsTitleRegeneration(threadRef.environmentId),
            },
          })
        : null,
    [lastVisitedAt, now, shell, threadRef],
  );

  const snoozeLabel = (id: SnoozePresetId) => snoozePresetLabel(id, t);

  const openRename = useCallback(() => {
    if (!shell) return;
    setDraftTitle(shell.title);
    setRenaming(true);
  }, [shell]);

  const paletteActions = useMemo(
    () =>
      buildChatPaletteActions({
        threadRef,
        state,
        newChat,
        actions,
        t,
        now: new Date(),
        openRename,
      }),
    [actions, newChat, openRename, state, t, threadRef],
  );

  const registryOwner = useRef({});
  useEffect(
    () => registerChatPaletteActions(registryOwner.current, paletteActions),
    [paletteActions],
  );

  const shortcutTargets = useRef({ newChat, settle: () => {} });
  shortcutTargets.current = {
    newChat,
    settle: () => {
      if (threadRef && state?.supports.settlement && state.canSettle && !state.isSettled) {
        void actions.settle(threadRef);
      }
    },
  };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      // Shortcut recording and open dialogs keep their keystrokes; chat actions
      // only answer keys pressed in the chat itself.
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture], [role='dialog'], [role='alertdialog']")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: { modelPickerOpen: isModelPickerOpen() },
      });
      if (command === "chat.new") {
        const control = shortcutTargets.current.newChat;
        if (!control) return;
        event.preventDefault();
        event.stopPropagation();
        if (control.canStart) void control.start();
        return;
      }
      if (command === "thread.settle") {
        event.preventDefault();
        event.stopPropagation();
        shortcutTargets.current.settle();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings]);

  // A bot with no chat yet has nothing to act on; its first message starts one.
  if (!threadRef || !shell || !state) return null;

  const snoozePresets = resolveSnoozePresets(new Date());
  const snoozedUntilLabel = state.snoozedUntil
    ? formatDate(new Date(state.snoozedUntil), {
        weekday: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : null;

  return (
    <>
      {state.isPinned ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                role="img"
                aria-label={t("Pinned")}
                className="flex size-7 items-center justify-center text-muted-foreground"
              />
            }
          >
            <PinIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{t("Pinned")}</TooltipPopup>
        </Tooltip>
      ) : null}
      {snoozedUntilLabel ? (
        <span
          data-testid="chat-state-snoozed"
          className="me-1 rounded-md border border-border px-1.5 py-px text-xs text-muted-foreground"
        >
          {t("Snoozed until {time}", { time: snoozedUntilLabel })}
        </span>
      ) : state.isSettled ? (
        <span
          data-testid="chat-state-settled"
          className="me-1 rounded-md border border-border px-1.5 py-px text-xs text-muted-foreground"
        >
          {t("Settled")}
        </span>
      ) : null}
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <Button
                    type="button"
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("Chat actions")}
                    data-testid="chat-actions-trigger"
                  />
                }
              />
            }
          >
            <AppIcon icon={MoreHorizontalIcon} />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{t("Chat actions")}</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end" data-testid="chat-actions-menu">
          {newChat ? (
            <MenuItem disabled={!newChat.canStart} onClick={() => void newChat.start()}>
              <SquarePenIcon />
              {t("New chat")}
            </MenuItem>
          ) : null}
          <MenuItem onClick={openRename}>
            <PencilIcon />
            {t("Rename chat")}
          </MenuItem>
          {state.supports.titleRegeneration ? (
            <MenuItem
              disabled={state.isRegeneratingTitle}
              onClick={() => void actions.regenerateTitle(threadRef)}
            >
              <RefreshCwIcon />
              {state.isRegeneratingTitle ? t("Regenerating…") : t("Regenerate title")}
            </MenuItem>
          ) : null}
          <MenuSeparator />
          {state.supports.pinning ? (
            state.isPinned ? (
              <MenuItem onClick={() => void actions.unpin(threadRef)}>
                <PinOffIcon />
                {t("Unpin chat")}
              </MenuItem>
            ) : (
              <MenuItem onClick={() => void actions.pin(threadRef)}>
                <PinIcon />
                {t("Pin chat")}
              </MenuItem>
            )
          ) : null}
          <MenuItem disabled={!state.canMarkUnread} onClick={() => actions.markUnread(threadRef)}>
            <CircleDotIcon />
            {t("Mark unread")}
          </MenuItem>
          {state.supports.settlement ? (
            state.isSettled ? (
              <MenuItem onClick={() => void actions.unsettle(threadRef)}>
                <UndoIcon />
                {t("Un-settle chat")}
              </MenuItem>
            ) : (
              <MenuItem disabled={!state.canSettle} onClick={() => void actions.settle(threadRef)}>
                <CheckCheckIcon />
                {t("Settle chat")}
              </MenuItem>
            )
          ) : null}
          {state.supports.snooze ? (
            state.isSnoozed ? (
              <MenuItem onClick={() => void actions.unsnooze(threadRef)}>
                <SunIcon />
                {t("Wake chat")}
              </MenuItem>
            ) : (
              <MenuSub>
                <MenuSubTrigger disabled={!state.canSnooze}>
                  <AlarmClockIcon />
                  {t("Snooze")}
                </MenuSubTrigger>
                <MenuSubPopup>
                  {snoozePresets.map((preset) => (
                    <MenuItem
                      key={preset.id}
                      onClick={() => void actions.snooze(threadRef, preset.snoozedUntil)}
                    >
                      <span className="flex-1">{snoozeLabel(preset.id)}</span>
                      <span className="text-xs text-muted-foreground">{preset.whenLabel}</span>
                    </MenuItem>
                  ))}
                </MenuSubPopup>
              </MenuSub>
            )
          ) : null}
          <MenuSeparator />
          <MenuItem disabled={!state.canArchive} onClick={() => void actions.archive(threadRef)}>
            <ArchiveIcon />
            {t("Archive chat")}
          </MenuItem>
          <MenuItem variant="destructive" onClick={() => void actions.delete(threadRef)}>
            <Trash2Icon />
            {t("Delete chat")}
          </MenuItem>
        </MenuPopup>
      </Menu>
      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogPopup className="max-w-md" bottomStickOnMobile={false}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const title = draftTitle.trim();
              if (!title) return;
              setRenaming(false);
              if (title !== shell.title) void actions.rename(threadRef, title);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("Rename chat")}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <Input
                autoFocus
                aria-label={t("Chat title")}
                maxLength={200}
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
              />
            </DialogPanel>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setRenaming(false)}>
                {t("Cancel")}
              </Button>
              <Button type="submit" disabled={draftTitle.trim().length === 0}>
                {t("Save")}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
