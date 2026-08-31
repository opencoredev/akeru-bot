import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, snapCenterToCursor } from "@dnd-kit/modifiers";
import {
  SortableContext,
  rectSortingStrategy,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotId, EnvironmentId, GroupId, ThreadId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { BotIcon, PlusIcon, SearchIcon, UsersIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { cn, randomUUID } from "../../lib/utils";
import { botEnvironment } from "../../state/bots";
import { useThreadMessages, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarChromeFooter } from "../sidebar/SidebarChrome";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { visibleBotChatMessages } from "./botConversationPresentation";
import { useBotPresence } from "./botPresence";
import { findLatestBotThreadTarget } from "./botThreadRuntime.logic";
import { NewBotDialog } from "./NewBotDialog";
import { NewGroupDialog, type NewGroupInput } from "./NewGroupDialog";
import { GroupMemberStack } from "./GroupMemberStack";
import {
  buildRosterStrip,
  filterRosterBots,
  filterRosterGroups,
  formatRosterTimestamp,
  isRecordableChatPath,
  parseChatPath,
  resolveLatestRosterMessage,
  resolveRosterIndicator,
  groupContainsBot,
  parseRosterBotDragId,
  parseRosterGroupDropId,
  rosterBotDragId,
  rosterGroupDropId,
  type RosterLastMessage,
  type RosterPresence,
} from "./roster.logic";
import { moveRosterBot, useRosterStore } from "./rosterStore";
import type { Bot, BotAvatar, Group } from "./types";
import { useServerRosterSync } from "./useServerRoster";

/** Avatar with a yellow needs-you light and a green working light. */
function RosterAvatar({
  bot,
  presence,
  className,
  dotClassName,
}: {
  bot: Bot;
  presence: RosterPresence;
  className: string;
  dotClassName?: string;
}) {
  const indicator = resolveRosterIndicator(presence);
  return (
    <span className="relative shrink-0">
      <BotAvatarView avatar={bot.avatar} name={bot.name} state={presence} className={className} />
      {indicator !== null ? (
        <span
          data-testid="bot-presence-dot"
          data-status={indicator}
          className={cn(
            "absolute -bottom-px -right-px rounded-full ring-1 ring-sidebar",
            indicator === "working" ? "bg-success" : "bg-warning",
            dotClassName ?? "size-2",
          )}
        />
      ) : null}
    </span>
  );
}

/**
 * Minimal roster chrome: traffic-light drag space, an optional environment
 * pill, and the new-bot button. No brand row and no stage artwork. The
 * fixed SidebarControl trigger overlays the left edge on desktop, so content
 * starts at the titlebar inset. Icon-collapsed mode empties the row and the
 * rail supplies its own new-bot button.
 */
const RosterSidebarHeader = memo(function RosterSidebarHeader({
  onNewBot,
  onNewGroup,
}: {
  onNewBot: () => void;
  onNewGroup: () => void;
}) {
  return (
    <SidebarHeader
      className={cn(
        "h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 px-3 py-0 md:px-2",
        isElectron && "drag-region",
      )}
    >
      <div className="grid min-w-0 flex-1 grid-cols-[1fr_auto_1fr] items-center group-data-[collapsible=icon]:hidden">
        <div className="flex items-center justify-start">
          <SidebarTrigger className="md:hidden" />
        </div>
        <Link
          to="/"
          className="flex items-center justify-center rounded-md text-sidebar-foreground outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]"
        >
          <span className="truncate text-xl leading-none tracking-tight [font-family:var(--font-brand-serif)]">
            akeru
          </span>
        </Link>
        <div className="flex items-center justify-end">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label="Create"
                  data-testid="roster-new-bot"
                  className="size-[var(--workspace-titlebar-control-size)]! [-webkit-app-region:no-drag]"
                  size="icon"
                  variant="ghost"
                >
                  <PlusIcon />
                </Button>
              }
            />
            <MenuPopup align="end">
              <MenuItem onClick={onNewBot}>
                <BotIcon />
                New bot
              </MenuItem>
              <MenuItem onClick={onNewGroup}>
                <UsersIcon />
                New group
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </SidebarHeader>
  );
});

const BotStripTile = memo(function BotStripTile({
  bot,
  isActive,
  onSelect,
}: {
  bot: Bot;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
}) {
  const presence = useBotPresence(bot.id);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rosterBotDragId(bot.id),
  });
  return (
    <li
      ref={setNodeRef}
      className={cn("list-none touch-pan-y", isDragging && "opacity-0")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...listeners}
    >
      <button
        type="button"
        data-testid="roster-strip-tile"
        data-bot-hover
        aria-current={isActive || undefined}
        onClick={() => onSelect(bot)}
        className={cn(
          "flex w-20 cursor-grab flex-col items-center gap-2 rounded-xl px-1 pb-2 pt-3 outline-none select-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          isActive ? "bg-sidebar-row-active" : "bg-transparent hover:bg-sidebar-row-hover",
        )}
      >
        <RosterAvatar bot={bot} presence={presence} className="size-14" />
        <span className="w-full truncate text-center text-xs text-sidebar-foreground">
          {bot.name}
        </span>
      </button>
    </li>
  );
});

function useLatestBotMessage(
  botId: string,
  fallback: RosterLastMessage | null,
  working: boolean,
): RosterLastMessage | null {
  const rememberedPath = useRosterStore((state) => state.chatPathByBotId[botId]);
  const environmentId = usePrimaryEnvironmentId();
  const threadShells = useThreadShells();
  const threadRef = useMemo(() => {
    const durableTarget = environmentId
      ? findLatestBotThreadTarget(botId, environmentId, threadShells)
      : null;
    const target = durableTarget ?? (rememberedPath ? parseChatPath(rememberedPath) : null);
    return target
      ? scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId))
      : null;
  }, [botId, environmentId, rememberedPath, threadShells]);
  const messages = useThreadMessages(threadRef);
  const visibleMessages = useMemo(
    () => visibleBotChatMessages(messages, working),
    [messages, working],
  );
  return useMemo(
    () => resolveLatestRosterMessage(fallback, visibleMessages),
    [fallback, visibleMessages],
  );
}

const BotRosterRow = memo(function BotRosterRow({
  bot,
  lastMessage,
  isActive,
  onSelect,
}: {
  bot: Bot;
  lastMessage: RosterLastMessage | null;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
}) {
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const presence = useBotPresence(bot.id);
  const latestMessage = useLatestBotMessage(bot.id, lastMessage, presence === "working");
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: rosterBotDragId(bot.id),
  });
  return (
    <li
      ref={setNodeRef}
      className={cn("list-none touch-pan-y", isDragging && "opacity-0")}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...listeners}
    >
      <div
        data-testid="roster-bot-row"
        data-bot-hover
        className={cn(
          "flex w-full items-center rounded-lg outline-none select-none",
          isActive
            ? "bg-sidebar-row-active text-sidebar-foreground"
            : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <button
          type="button"
          aria-current={isActive || undefined}
          onClick={() => onSelect(bot)}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RosterAvatar bot={bot} presence={presence} className="size-10" />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">{bot.name}</span>
              {latestMessage ? (
                <span className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground">
                  {formatRosterTimestamp(latestMessage.at, timestampFormat)}
                </span>
              ) : null}
            </span>
            {latestMessage ? (
              <span className="truncate text-[13px] text-sidebar-muted-foreground">
                {latestMessage.text}
              </span>
            ) : null}
          </span>
        </button>
      </div>
    </li>
  );
});

/** One avatar in the icon-collapsed rail, with a name tooltip. */
function RailBotButton({
  bot,
  isActive,
  onSelect,
}: {
  bot: Bot;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
}) {
  const presence = useBotPresence(bot.id);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-bot-hover
            aria-current={isActive || undefined}
            onClick={() => onSelect(bot)}
            className={cn(
              "flex size-9 cursor-pointer items-center justify-center rounded-lg outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive ? "bg-sidebar-row-active" : "bg-transparent hover:bg-sidebar-row-hover",
            )}
          >
            <RosterAvatar
              bot={bot}
              presence={presence}
              className="size-7"
              dotClassName="size-1.5"
            />
          </button>
        }
      />
      <TooltipPopup side="right">{bot.name}</TooltipPopup>
    </Tooltip>
  );
}

function GroupRosterRow({
  group,
  bots,
  isActive,
  onSelect,
}: {
  group: Group;
  bots: readonly Bot[];
  isActive: boolean;
  onSelect: () => void;
}) {
  const { isOver, setNodeRef } = useDroppable({ id: rosterGroupDropId(group.id) });
  const members = group.members.filter((member) => member.kind === "bot").length;
  return (
    <li ref={setNodeRef} data-testid="roster-group-row" className="list-none">
      <button
        type="button"
        aria-current={isActive || undefined}
        onClick={onSelect}
        className={cn(
          "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sidebar-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          isOver
            ? "bg-sidebar-row-active ring-2 ring-ring"
            : isActive
              ? "bg-sidebar-row-active"
              : "hover:bg-sidebar-row-hover",
        )}
      >
        <GroupMemberStack
          group={group}
          bots={bots}
          ringClassName="ring-sidebar"
          sizeClassName="size-10"
          className="w-[3.5rem] shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{group.name}</span>
          <span className="block text-[13px] text-sidebar-muted-foreground">{members} bots</span>
        </span>
      </button>
    </li>
  );
}

function RosterDropZone({
  id,
  className,
  children,
}: {
  id: "pinned-zone" | "unpinned-zone";
  className?: string;
  children: ReactNode;
}) {
  const { isOver, setNodeRef } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-drop-zone={id}
      data-drag-over={isOver || undefined}
      className={className}
    >
      {children}
    </div>
  );
}

function BotDragOverlay({ bot }: { bot: Bot }) {
  const presence = useBotPresence(bot.id);
  return (
    <div className="flex w-20 cursor-grabbing flex-col items-center gap-2 rounded-xl bg-sidebar-row-hover px-1 pb-2 pt-3 text-sidebar-foreground shadow-xl select-none">
      <RosterAvatar bot={bot} presence={presence} className="size-14" />
      <span className="w-full truncate text-center text-xs">{bot.name}</span>
    </div>
  );
}

export default function BotRosterSidebar() {
  useServerRosterSync();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const createBotCommand = useAtomCommand(botEnvironment.create, { reportFailure: false });
  const createGroupCommand = useAtomCommand(botEnvironment.groups.create, {
    reportFailure: false,
  });
  const assignGroupMemberCommand = useAtomCommand(botEnvironment.groups.assignMember, {
    reportFailure: false,
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { bots, groups, lastMessageByBotId, selectedBotId } = useRosterStore(
    useShallow((state) => ({
      bots: state.bots,
      groups: state.groups,
      lastMessageByBotId: state.lastMessageByBotId,
      selectedBotId: state.selectedBotId,
    })),
  );
  const [query, setQuery] = useState("");
  const [dragLayout, setDragLayout] = useState<Bot[] | null>(null);
  const dragLayoutRef = useRef<Bot[] | null>(null);
  const [activeBotId, setActiveBotId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const strip = useMemo(
    () => buildRosterStrip(bots, lastMessageByBotId),
    [bots, lastMessageByBotId],
  );
  const visibleBots = useMemo(
    () => filterRosterBots(dragLayout ?? bots, query).filter((bot) => bot.archivedAt === null),
    [bots, dragLayout, query],
  );
  const pinnedBots = visibleBots.filter((bot) => bot.pinned);
  const unpinnedBots = visibleBots.filter((bot) => !bot.pinned);
  const visibleGroups = useMemo(
    () => filterRosterGroups(groups, bots, query),
    [bots, groups, query],
  );
  const activeBot =
    activeBotId === null
      ? null
      : ((dragLayout ?? bots).find((bot) => bot.id === activeBotId) ?? null);

  const resolveDrop = (layout: readonly Bot[], overId: string) => {
    if (overId === "pinned-zone") return { overBotId: null, pinned: true } as const;
    if (overId === "unpinned-zone") return { overBotId: null, pinned: false } as const;
    const overBotId = parseRosterBotDragId(overId);
    const overBot = overBotId ? layout.find((bot) => bot.id === overBotId) : null;
    return overBot ? { overBotId: overBot.id, pinned: overBot.pinned } : null;
  };
  const handleDragStart = ({ active }: DragStartEvent) => {
    dragLayoutRef.current = bots;
    setActiveBotId(parseRosterBotDragId(String(active.id)));
    setDragLayout(bots);
  };
  const handleDragOver = ({ active, over }: DragOverEvent) => {
    if (!over) return;
    setDragLayout((current) => {
      const layout = current ?? bots;
      if (parseRosterGroupDropId(String(over.id))) return layout;
      const drop = resolveDrop(layout, String(over.id));
      if (!drop) return layout;
      const activeId = parseRosterBotDragId(String(active.id));
      if (!activeId) return layout;
      const next = moveRosterBot(layout, activeId, drop.overBotId, drop.pinned) ?? layout;
      dragLayoutRef.current = next;
      return next;
    });
  };
  const finishDrag = () => {
    dragLayoutRef.current = null;
    setActiveBotId(null);
    setDragLayout(null);
  };
  const handleDragEnd = ({ active, over }: DragEndEvent) => {
    const botId = parseRosterBotDragId(String(active.id));
    const groupId = over ? parseRosterGroupDropId(String(over.id)) : null;
    const group = groupId ? groups.find((candidate) => candidate.id === groupId) : null;
    if (botId && group) {
      if (environmentId && !groupContainsBot(group, botId)) {
        void assignGroupMemberCommand({
          environmentId,
          input: {
            groupId: GroupId.make(group.id),
            botId: BotId.make(botId),
            role: "specialist",
          },
        }).then((result) => {
          if (result._tag === "Failure") {
            toastManager.add({ type: "error", title: `Could not add bot to ${group.name}` });
          }
        });
      }
    } else if (over && dragLayoutRef.current) {
      useRosterStore.getState().commitBotLayout(dragLayoutRef.current);
    }
    finishDrag();
  };

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

  const handleSelect = (bot: Bot) => {
    pendingClickedBotIdRef.current = bot.id;
    useRosterStore.getState().selectBot(bot.id);
    void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
  };

  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [pendingCreatedBotId, setPendingCreatedBotId] = useState<string | null>(null);
  const handleNewBot = () => setNewBotOpen(true);
  const handleNewGroup = () => setNewGroupOpen(true);
  const handleCreateBot = async ({ name, avatar }: { name: string; avatar: BotAvatar }) => {
    if (environmentId === null) {
      toastManager.add({ type: "error", title: "Connect an environment first" });
      return;
    }
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
        runtimeMode: "full-access",
        usageCap: null,
        groupId: null,
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not create bot" });
      return;
    }
    setNewBotOpen(false);
    setPendingCreatedBotId(botId);
  };

  const handleCreateGroup = async (input: NewGroupInput) => {
    if (environmentId === null) {
      toastManager.add({ type: "error", title: "Connect an environment first" });
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
      toastManager.add({ type: "error", title: "Could not create group" });
      return;
    }
    setNewGroupOpen(false);
    void navigate({ to: "/groups/$groupId", params: { groupId } });
  };

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
      <RosterSidebarHeader onNewBot={handleNewBot} onNewGroup={handleNewGroup} />
      <SidebarContent
        className="gap-0"
        fixedHeader={
          <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden">
            <label className="flex h-9 items-center gap-2 rounded-lg bg-sidebar-row-hover px-2.5 ring-ring focus-within:ring-2">
              <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground" />
              <input
                type="text"
                data-testid="roster-search-input"
                placeholder="Search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape" && query.length > 0) {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
                className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground"
              />
            </label>
          </SidebarGroup>
        }
      >
        {bots.every((bot) => bot.archivedAt !== null) ? (
          <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
            No bots yet
          </div>
        ) : (
          <>
            {/* Icon-collapsed rail: every visible bot, recency order. */}
            <SidebarGroup className="hidden items-center gap-1 px-0 pt-1 group-data-[collapsible=icon]:flex">
              <ul data-testid="roster-rail" className="flex flex-col items-center gap-1">
                {strip.map((bot) => (
                  <li key={bot.id} className="list-none">
                    <RailBotButton
                      bot={bot}
                      isActive={selectedBotId === bot.id}
                      onSelect={handleSelect}
                    />
                  </li>
                ))}
              </ul>
            </SidebarGroup>
            <DndContext
              collisionDetection={closestCenter}
              sensors={sensors}
              modifiers={[restrictToFirstScrollableAncestor]}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDragCancel={finishDrag}
              onDragEnd={handleDragEnd}
            >
              {pinnedBots.length > 0 || activeBotId !== null ? (
                <SidebarGroup className="px-4 pb-3 pt-2 group-data-[collapsible=icon]:hidden">
                  <RosterDropZone
                    id="pinned-zone"
                    className="min-h-24 rounded-xl transition-colors data-[drag-over=true]:bg-sidebar-row-hover"
                  >
                    <SortableContext
                      items={pinnedBots.map((bot) => rosterBotDragId(bot.id))}
                      strategy={rectSortingStrategy}
                    >
                      <ul
                        data-testid="roster-strip"
                        className={cn(
                          "grid min-h-24 place-items-center gap-x-1 gap-y-2",
                          pinnedBots.length === 1 ? "grid-cols-1" : "grid-cols-3",
                        )}
                      >
                        {pinnedBots.map((bot) => (
                          <BotStripTile
                            key={bot.id}
                            bot={bot}
                            isActive={selectedBotId === bot.id}
                            onSelect={handleSelect}
                          />
                        ))}
                      </ul>
                    </SortableContext>
                  </RosterDropZone>
                </SidebarGroup>
              ) : null}
              <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden">
                <RosterDropZone
                  id="unpinned-zone"
                  className="min-h-12 rounded-lg transition-colors data-[drag-over=true]:bg-sidebar-row-hover"
                >
                  <SortableContext
                    items={unpinnedBots.map((bot) => rosterBotDragId(bot.id))}
                    strategy={verticalListSortingStrategy}
                  >
                    <div className="flex flex-col gap-2">
                      {visibleGroups.length > 0 ? (
                        <ul aria-label="Groups" className="flex flex-col gap-px">
                          {visibleGroups.map((group) => (
                            <GroupRosterRow
                              key={group.id}
                              group={group}
                              bots={bots}
                              isActive={pathname === `/groups/${group.id}`}
                              onSelect={() =>
                                void navigate({
                                  to: "/groups/$groupId",
                                  params: { groupId: group.id },
                                })
                              }
                            />
                          ))}
                        </ul>
                      ) : null}
                      <ul aria-label="Bots" className="flex min-h-12 flex-col gap-px">
                        {unpinnedBots.map((bot) => (
                          <BotRosterRow
                            key={bot.id}
                            bot={bot}
                            lastMessage={lastMessageByBotId[bot.id] ?? null}
                            isActive={selectedBotId === bot.id}
                            onSelect={handleSelect}
                          />
                        ))}
                      </ul>
                    </div>
                  </SortableContext>
                  {unpinnedBots.length === 0 &&
                  pinnedBots.length === 0 &&
                  visibleGroups.length === 0 ? (
                    <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
                      No bots match
                    </div>
                  ) : null}
                </RosterDropZone>
              </SidebarGroup>
              <DragOverlay modifiers={[snapCenterToCursor]}>
                {activeBot ? <BotDragOverlay bot={activeBot} /> : null}
              </DragOverlay>
            </DndContext>
          </>
        )}
      </SidebarContent>
      {/* Rail new-bot sits above the footer, like the expanded header's plus. */}
      <div className="hidden shrink-0 flex-col items-center pb-1 group-data-[collapsible=icon]:flex">
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label="New bot"
                onClick={handleNewBot}
                className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PlusIcon className="size-4" />
              </button>
            }
          />
          <TooltipPopup side="right">New bot</TooltipPopup>
        </Tooltip>
      </div>
      {newBotOpen ? (
        <NewBotDialog
          open
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
      <SidebarChromeFooter />
    </>
  );
}
