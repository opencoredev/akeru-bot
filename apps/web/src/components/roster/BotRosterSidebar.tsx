import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { useAtomValue } from "@effect/atom-react";
import { BotId, GroupId } from "@akeru/contracts";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import { useI18n } from "../../i18n";
import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { randomUUID } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarChromeFooter, SidebarStatusStack } from "../sidebar/SidebarChrome";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { SidebarContent, SidebarGroup } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { DEFAULT_BOT_RUNTIME_MODE } from "./botSandbox";
import { NewBotDialog } from "./NewBotDialog";
import { NewGroupDialog, type NewGroupInput } from "./NewGroupDialog";
import {
  buildRosterListItems,
  filterRosterBots,
  filterRosterGroups,
  isRecordableChatPath,
  rosterItemKey,
  rosterItemsEqual,
  rosterItemsForZone,
  rosterListItemId,
  orderRosterBotsForShortcuts,
  resolveAdjacentRosterBot,
  resolveRosterShortcutBot,
  type RosterItemRef,
} from "./roster.logic";
import { RosterDragLifecycle } from "./roster.pointer";
import { useRosterStore } from "./rosterStore";
import { resolveRosterListState } from "./rosterRouteSelection";
import { RosterArchivedSection } from "./RosterArchivedSection";
import { RosterLoadStatus } from "./RosterLoadStatus";
import { useRosterLoadState } from "./useServerRoster";
import type { Bot, BotAvatar, Group } from "./types";
import { useBotThreadRef } from "./useBotThreadRef";
import {
  RosterDragBoundary,
  RosterSectionPlaceholder,
  SortableRosterMarker,
  SortableRosterRow,
  useRosterDragController,
} from "./RosterDrag";
import { BotRosterRow, GroupRosterRow, RosterRail } from "./RosterRows";
import { RosterPanelHeader, RosterRailCreateMenu, RosterSidebarHeader } from "./RosterHeaders";
import {
  commandFailureMessage,
  focusTargetAfterRosterArchive,
  runCreateBotOnce,
} from "./rosterCommands.logic";

export { focusTargetAfterRosterArchive, runCreateBotOnce } from "./rosterCommands.logic";

export { RosterPanelHeader } from "./RosterHeaders";

/** Stable row actions, so memoized rows skip re-rendering when the sidebar does. */
const setRosterItemPinned = (item: RosterItemRef, pinned: boolean) =>
  useRosterStore.getState().setItemPinned(item, pinned);

const nudgeRosterItem = (item: RosterItemRef, delta: -1 | 1) =>
  useRosterStore.getState().nudgeRosterItem(item, delta);

/** `panel` drops the roster's own chrome for the experimental rail layout. */
export default function BotRosterSidebar({ chrome = "full" }: { chrome?: "full" | "panel" } = {}) {
  const [searchOpen, setSearchOpen] = useState(false);
  const { t } = useI18n();
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentId = usePrimaryEnvironmentId();

  const createBotCommand = useAtomCommand(botEnvironment.create, {
    reportFailure: false,
  });

  const createGroupCommand = useAtomCommand(botEnvironment.groups.create, {
    reportFailure: false,
  });

  const archiveBotCommand = useAtomCommand(botEnvironment.archive, { reportFailure: false });
  const pathname = useLocation({ select: (location) => location.pathname });

  const { bots, groups, lastMessageByBotId, selectedBotId, pinnedItems, unassignedItems } =
    useRosterStore(
      useShallow((state) => ({
        bots: state.bots,
        groups: state.groups,
        lastMessageByBotId: state.lastMessageByBotId,
        selectedBotId: state.selectedBotId,
        pinnedItems: state.pinnedItems,
        unassignedItems: state.unassignedItems,
      })),
    );

  const rosterEnvironmentId = useRosterStore((state) => state.environmentId);
  const rosterListState = resolveRosterListState(environmentId, rosterEnvironmentId, bots);
  const rosterLoadState = useRosterLoadState();
  const [query, setQuery] = useState("");

  const activeBotThreadRef = useBotThreadRef(
    pathname.startsWith("/bots/") ? (selectedBotId ?? "") : "",
  );

  const previewOpen = useRightPanelStore((state) =>
    activeBotThreadRef
      ? selectActiveRightPanel(state.byThreadKey, activeBotThreadRef) === "preview"
      : false,
  );

  const visibleBots = useMemo(
    () => filterRosterBots(bots, query).filter((bot) => bot.archivedAt === null),
    [bots, query],
  );

  const visibleGroups = useMemo(
    () => filterRosterGroups(groups, bots, query),
    [bots, groups, query],
  );

  const groupRouteActive = pathname.startsWith("/groups/");
  const botRouteActive = pathname.startsWith("/bots/");
  const searching = query.trim().length > 0;

  const pinnedKeys = useMemo(
    () => new Set(pinnedItems.map((item) => rosterItemKey(item))),
    [pinnedItems],
  );

  const liveItem = useCallback(
    (item: RosterItemRef) => {
      if (item.kind === "bot") return visibleBots.some((bot) => bot.id === item.id);

      return visibleGroups.some((group) => group.id === item.id);
    },
    [visibleBots, visibleGroups],
  );

  const visiblePinnedItems = useMemo(() => pinnedItems.filter(liveItem), [liveItem, pinnedItems]);

  const visibleUnassignedItems = useMemo(() => {
    const remaining = (item: RosterItemRef) =>
      liveItem(item) && !pinnedKeys.has(rosterItemKey(item));

    if (unassignedItems.length > 0) {
      const ordered = unassignedItems.filter(remaining);
      const seen = new Set(ordered.map(rosterItemKey));

      for (const group of visibleGroups) {
        const item = { kind: "group" as const, id: group.id };

        if (remaining(item) && !seen.has(rosterItemKey(item))) ordered.push(item);
      }

      for (const bot of visibleBots) {
        const item = { kind: "bot" as const, id: bot.id };

        if (remaining(item) && !seen.has(rosterItemKey(item))) ordered.push(item);
      }

      return ordered;
    }

    return [
      ...visibleGroups.map((group) => ({ kind: "group" as const, id: group.id })),
      ...visibleBots.map((bot) => ({ kind: "bot" as const, id: bot.id })),
    ].filter(remaining);
  }, [liveItem, pinnedKeys, unassignedItems, visibleBots, visibleGroups]);

  const rosterListItems = useMemo(
    () =>
      buildRosterListItems({
        pinnedItems: visiblePinnedItems,
        sections: [],
        unassignedItems: visibleUnassignedItems,
      }),
    [visiblePinnedItems, visibleUnassignedItems],
  );

  const {
    dragState,
    dragTargetZone,
    rosterListRef,
    listRef: attachListMotionRef,
    cancelRosterDrag,
    sortableIds,
    sortingStrategy,
    dndContextProps,
  } = useRosterDragController({ rosterListItems, visiblePinnedItems });

  // Remember the chat route the selected bot lands on, so re-selecting the
  // bot returns to its conversation. The first run after a selection change
  // is skipped: the route still belongs to the previously selected bot.
  const lastSelectedBotIdRef = useRef<string | null>(selectedBotId);
  const pendingClickedBotIdRef = useRef<string | null>(null);
  useEffect(() => {
    const selectionChanged = lastSelectedBotIdRef.current !== selectedBotId;
    const selectionCameFromClick = pendingClickedBotIdRef.current === selectedBotId;
    lastSelectedBotIdRef.current = selectedBotId;

    if (selectionCameFromClick) pendingClickedBotIdRef.current = null;

    if ((selectionChanged && selectionCameFromClick) || selectedBotId === null) return;

    if (!isRecordableChatPath(pathname)) return;
    useRosterStore.getState().recordChatPath(selectedBotId, pathname);
  }, [pathname, selectedBotId]);

  const handleSelect = useCallback(
    (bot: Bot) => {
      pendingClickedBotIdRef.current = bot.id;
      useRosterStore.getState().selectBot(bot.id);
      void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
    },
    [navigate],
  );

  const handleOpenBotSettings = useCallback(
    (bot: Bot) => {
      useRosterStore.getState().selectBot(bot.id);
      void navigate({ to: "/bots/$botId/settings", params: { botId: bot.id } });
    },
    [navigate],
  );

  const shortcutBots = useMemo(
    () => orderRosterBotsForShortcuts(bots, pinnedItems, []),
    [bots, pinnedItems],
  );

  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;

      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });

      const bot =
        resolveRosterShortcutBot(command ?? "", shortcutBots) ??
        resolveAdjacentRosterBot(
          command ?? "",
          shortcutBots,
          botRouteActive ? useRosterStore.getState().selectedBotId : null,
        );

      if (!bot) return;

      event.preventDefault();
      event.stopPropagation();
      pendingClickedBotIdRef.current = bot.id;
      useRosterStore.getState().selectBot(bot.id);
      void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
    };

    window.addEventListener("keydown", onWindowKeyDown);

    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [botRouteActive, keybindings, navigate, previewOpen, shortcutBots]);

  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [archivingBot, setArchivingBot] = useState<Bot | null>(null);
  const [pendingArchivedBotId, setPendingArchivedBotId] = useState<string | null>(null);
  // Archiving is the one close that cannot go back where it came from: the row
  // menu button focus was on leaves with the row. The confirm names its survivor
  // here and holds it past the close, so the dialog does not restore focus onto
  // a button the projection is about to remove.
  const archivedFocusTarget = useRef<string | null | undefined>(undefined);
  const rosterSearchRef = useRef<HTMLInputElement | null>(null);

  /** Row keys in the order the roster renders them, so the survivor is the next one down. */
  const rosterRowKeys = useMemo(
    () =>
      rosterListItems.flatMap((item) => (item.kind === "entry" ? [rosterItemKey(item.item)] : [])),
    [rosterListItems],
  );

  const focusRosterRow = useCallback((rowKey: string | null) => {
    const list = rosterListRef.current;

    for (const row of rowKey === null
      ? []
      : (list?.querySelectorAll<HTMLElement>("[data-roster-row]") ?? [])) {
      if (row.dataset.rosterRow === rowKey) {
        row.focus();

        return;
      }
    }

    // Nothing survived in the list, or the last bot took the list with it.
    (list ?? rosterSearchRef.current)?.focus();
  }, []);

  const handleArchiveBot = async (bot: Bot) => {
    if (environmentId === null) {
      // Nothing was archived, so the dialog restores focus to the row menu itself.
      setArchivingBot(null);
      toastManager.add({ type: "error", title: t("Connect an environment first") });

      return;
    }

    const botKey = rosterItemKey({ kind: "bot", id: bot.id });
    archivedFocusTarget.current = focusTargetAfterRosterArchive(rosterRowKeys, botKey);
    setArchivingBot(null);

    const result = await archiveBotCommand({
      environmentId,
      input: { botId: BotId.make(bot.id) },
    });

    if (result._tag === "Failure") {
      // The row stayed, so focus goes back to it rather than to its replacement.
      archivedFocusTarget.current = undefined;
      focusRosterRow(botKey);
      // Archiving is refused with a reason (a group boss, a group left too small), so say it.
      toastManager.add({
        type: "error",
        title: t("Could not archive {name}", { name: bot.name }),
        description: commandFailureMessage(result, t),
      });

      return;
    }

    setPendingArchivedBotId(bot.id);
  };

  // The exit waits for the roster projection. Navigating on the command's reply
  // sends `/` a selection it still resolves to the archived bot, which bounces
  // straight back into the chat being left; focus would land on a row that is
  // about to be removed. Once the bot is gone from the live roster the survivor
  // is real, and the selection is re-read because the user may have opened
  // another bot while the archive was in flight.
  useEffect(() => {
    if (pendingArchivedBotId === null) return;

    if (bots.some((bot) => bot.id === pendingArchivedBotId && bot.archivedAt === null)) return;
    const focusTarget = archivedFocusTarget.current ?? null;
    archivedFocusTarget.current = undefined;
    setPendingArchivedBotId(null);
    focusRosterRow(focusTarget);

    if (useRosterStore.getState().selectedBotId === pendingArchivedBotId) {
      void navigate({ to: "/", replace: true });
    }
  }, [bots, focusRosterRow, navigate, pendingArchivedBotId]);

  const [pendingCreatedBotId, setPendingCreatedBotId] = useState<string | null>(null);
  const [creatingBot, setCreatingBot] = useState(false);
  const creatingBotRef = useRef(false);
  const handleNewBot = () => setNewBotOpen(true);
  const handleNewGroup = () => setNewGroupOpen(true);

  const handleCreateBot = ({ name, avatar }: { name: string; avatar: BotAvatar }) =>
    runCreateBotOnce(creatingBotRef, async () => {
      if (environmentId === null) {
        toastManager.add({
          type: "error",
          title: t("Connect an environment first"),
        });

        return;
      }

      setCreatingBot(true);

      try {
        const botId = BotId.make(`bot-${randomUUID()}`);

        const result = await createBotCommand({
          environmentId,
          input: {
            botId,
            name: name.trim(),
            title: "Assistant",
            label: null,
            description: null,
            avatar,
            engine: null,
            sandbox: null,
            runtimeMode: DEFAULT_BOT_RUNTIME_MODE,
            usageCap: null,
            groupId: null,
          },
        });

        if (result._tag === "Failure") {
          toastManager.add({ type: "error", title: t("Could not create bot") });

          return;
        }

        setNewBotOpen(false);
        setPendingCreatedBotId(botId);
      } finally {
        setCreatingBot(false);
      }
    });

  const handleCreateGroup = async (input: NewGroupInput) => {
    if (environmentId === null) {
      toastManager.add({
        type: "error",
        title: t("Connect an environment first"),
      });

      return;
    }

    const groupId = GroupId.make(`group-${randomUUID()}`);

    const result = await createGroupCommand({
      environmentId,
      input: {
        groupId,
        name: input.name,
        bossBotId: BotId.make(input.bossBotId),
        specialistBotIds: input.specialistBotIds.map((botId) => BotId.make(botId)),
      },
    });

    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: t("Could not create group") });

      return;
    }

    setNewGroupOpen(false);
    void navigate({ to: "/groups/$groupId", params: { groupId } });
  };

  const handleSelectGroup = useCallback(
    (group: Group) => {
      void navigate({ to: "/groups/$groupId", params: { groupId: group.id } });
    },
    [navigate],
  );

  useEffect(() => {
    if (pendingCreatedBotId === null) return;
    const bot = bots.find((candidate) => candidate.id === pendingCreatedBotId);

    if (!bot) return;
    const store = useRosterStore.getState();
    store.selectBot(bot.id);
    setPendingCreatedBotId(null);
    void navigate({ to: "/", replace: true });
  }, [bots, navigate, pendingCreatedBotId]);

  return (
    <>
      {chrome === "panel" ? (
        <RosterPanelHeader
          onNewBot={handleNewBot}
          onNewGroup={handleNewGroup}
          onSearch={() => setSearchOpen(true)}
        />
      ) : (
        <RosterSidebarHeader onNewBot={handleNewBot} onNewGroup={handleNewGroup} />
      )}
      <SidebarContent
        className="gap-0 overflow-anchor-none"
        fixedHeader={
          chrome === "panel" && !searchOpen && query.length === 0 ? null : (
            <SidebarGroup className="px-(--sidebar-content-inset) pb-1 pt-1 group-data-[collapsible=icon]:hidden">
              <label className="flex h-9 items-center gap-2 rounded-lg bg-sidebar-row-hover px-2.5 ring-ring focus-within:ring-2">
                <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
                <input
                  type="text"
                  ref={rosterSearchRef}
                  data-testid="roster-search-input"
                  placeholder={t("Search")}
                  autoFocus={chrome === "panel"}
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onBlur={() => {
                    if (query.length === 0) setSearchOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape" && query.length > 0) {
                      event.stopPropagation();
                      setQuery("");
                    } else if (event.key === "Escape") {
                      setSearchOpen(false);
                    }
                  }}
                  className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
                />
              </label>
            </SidebarGroup>
          )
        }
      >
        {rosterListState === "loading" ? (
          <RosterLoadStatus state={rosterLoadState} variant="sidebar" />
        ) : rosterListState === "empty" ? (
          <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
            {t("No bots yet")}
          </div>
        ) : (
          <>
            {/* Icon-collapsed rail: groups first, then every visible bot. */}
            <RosterRail
              groups={visibleGroups}
              bots={bots}
              visibleBots={visibleBots}
              pathname={pathname}
              activeBotId={groupRouteActive ? null : selectedBotId}
              onSelectBot={handleSelect}
              onSelectGroup={handleSelectGroup}
            />
            <SidebarGroup className="px-(--sidebar-content-inset) pb-1 pt-1 group-data-[collapsible=icon]:hidden">
              <DndContext {...dndContextProps}>
                <RosterDragLifecycle onUnmount={cancelRosterDrag} />
                <SortableContext items={sortableIds} strategy={sortingStrategy}>
                  <ul
                    ref={attachListMotionRef}
                    role="list"
                    // Focusable only on purpose: where focus lands when an
                    // archived row leaves and no sibling row survives it.
                    tabIndex={-1}
                    aria-label={t("Bots and groups")}
                    className="relative flex flex-wrap justify-center gap-x-1 gap-y-px"
                  >
                    {rosterListItems.map((item) => {
                      if (item.kind === "entry") {
                        const pinned = pinnedKeys.has(rosterItemKey(item.item));

                        const zoneOrder = rosterItemsForZone(item.zone, {
                          pinnedItems: visiblePinnedItems,
                          sections: [],
                          unassignedItems: visibleUnassignedItems,
                        });

                        const zoneIndex = zoneOrder.findIndex((candidate) =>
                          rosterItemsEqual(candidate, item.item),
                        );

                        const canMoveUp = !searching && zoneIndex > 0;

                        const canMoveDown =
                          !searching && zoneIndex >= 0 && zoneIndex < zoneOrder.length - 1;

                        return (
                          <SortableRosterRow
                            key={rosterListItemId(item)}
                            id={rosterListItemId(item)}
                            disabled={searching}
                          >
                            {(bag) =>
                              item.item.kind === "bot"
                                ? (() => {
                                    const bot = bots.find(
                                      (candidate) => candidate.id === item.item.id,
                                    );

                                    if (!bot) return null;

                                    return (
                                      <BotRosterRow
                                        bot={bot}
                                        lastMessage={lastMessageByBotId[bot.id] ?? null}
                                        isActive={!groupRouteActive && selectedBotId === bot.id}
                                        chatOpen={pathname === `/bots/${bot.id}`}
                                        onSelect={handleSelect}
                                        onOpenSettings={handleOpenBotSettings}
                                        pinned={pinned}
                                        onPin={setRosterItemPinned}
                                        canMoveUp={canMoveUp}
                                        canMoveDown={canMoveDown}
                                        onNudge={nudgeRosterItem}
                                        onArchive={setArchivingBot}
                                        sortable={bag}
                                      />
                                    );
                                  })()
                                : (() => {
                                    const group = groups.find(
                                      (candidate) => candidate.id === item.item.id,
                                    );

                                    if (!group) return null;

                                    return (
                                      <GroupRosterRow
                                        group={group}
                                        bots={bots}
                                        isActive={pathname === `/groups/${group.id}`}
                                        onSelect={handleSelectGroup}
                                        pinned={pinned}
                                        onPin={setRosterItemPinned}
                                        canMoveUp={canMoveUp}
                                        canMoveDown={canMoveDown}
                                        onNudge={nudgeRosterItem}
                                        sortable={bag}
                                      />
                                    );
                                  })()
                            }
                          </SortableRosterRow>
                        );
                      }

                      const from = dragState?.from ?? null;
                      const dragging = from !== null;

                      switch (item.marker) {
                        case "pinned-header":
                          return (
                            <RosterDragBoundary
                              key="pinned-header"
                              marker="pinned-header"
                              label={t("Pinned")}
                              visible={dragging}
                              isDropTarget={dragTargetZone === "pinned"}
                            />
                          );
                        case "pinned-divider":
                          return (
                            <RosterDragBoundary
                              key="pinned-divider"
                              marker="pinned-divider"
                              label={null}
                              visible={dragging}
                              isDropTarget={dragTargetZone !== null && dragTargetZone !== "pinned"}
                            />
                          );
                        case "unassigned-header":
                          // Unlabeled drop anchor: the pinned divider marks the
                          // boundary while dragging, so the list needs no heading.
                          return (
                            <SortableRosterMarker
                              key="unassigned-header"
                              marker="unassigned-header"
                              data-testid="roster-unassigned-header"
                              className="relative -mb-px h-0 w-full flex-none"
                            />
                          );
                        case "unassigned-placeholder":
                          return (
                            <RosterSectionPlaceholder
                              key="unassigned-placeholder"
                              marker="unassigned-placeholder"
                              label={t("Bots")}
                              showHint={
                                dragging &&
                                (visibleUnassignedItems.length === 0 ||
                                  (dragState?.from === "unassigned" &&
                                    visibleUnassignedItems.length === 1 &&
                                    dragTargetZone !== null &&
                                    dragTargetZone !== "unassigned"))
                              }
                              isDropTarget={dragTargetZone === "unassigned"}
                            />
                          );
                        default:
                          return null;
                      }
                    })}
                  </ul>
                </SortableContext>
              </DndContext>
              {visibleBots.length === 0 && visibleGroups.length === 0 ? (
                <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
                  {t("No bots match")}
                </div>
              ) : null}
            </SidebarGroup>
          </>
        )}
        {/* Archiving is reversible, so the way back stays in the roster itself. */}
        <RosterArchivedSection bots={bots} />
      </SidebarContent>
      {/* Rail create menu sits above the footer, like the expanded header's plus. */}
      <RosterRailCreateMenu onNewBot={handleNewBot} onNewGroup={handleNewGroup} />
      {newBotOpen ? (
        <NewBotDialog
          open
          submitting={creatingBot}
          onOpenChange={setNewBotOpen}
          onCreate={(input) => void handleCreateBot(input)}
        />
      ) : null}
      {newGroupOpen ? (
        <NewGroupDialog
          open
          bots={bots}
          onOpenChange={setNewGroupOpen}
          onCreate={(input) => void handleCreateGroup(input)}
        />
      ) : null}
      <AlertDialog
        open={archivingBot !== null}
        onOpenChange={(open) => {
          if (!open) setArchivingBot(null);
        }}
      >
        {archivingBot ? (
          <AlertDialogPopup
            // Cancelling belongs back on the row menu it came from. Archiving does
            // not: that row is on its way out of the projection, so the archive
            // effect places focus on the survivor and this must not move it after.
            finalFocus={() => archivedFocusTarget.current === undefined}
          >
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("Archive {name}?", { name: archivingBot.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {t(
                  "{name} leaves the roster and stops taking messages. Its chat history is kept, and you can restore it from Archived at any time.",
                  { name: archivingBot.name },
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {t("Cancel")}
              </AlertDialogClose>
              <Button variant="destructive" onClick={() => void handleArchiveBot(archivingBot)}>
                {t("Archive")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        ) : null}
      </AlertDialog>
      {chrome === "panel" ? (
        <SidebarStatusStack className="shrink-0 p-2" />
      ) : (
        <SidebarChromeFooter />
      )}
    </>
  );
}
