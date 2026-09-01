import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotId, EnvironmentId, GroupId, ThreadId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { BotIcon, PlusIcon, SearchIcon, UsersIcon } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { reorderVisibleRosterBots, useRosterStore } from "./rosterStore";
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
  index,
}: {
  bot: Bot;
  lastMessage: RosterLastMessage | null;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
  index: number;
}) {
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const presence = useBotPresence(bot.id);
  const latestMessage = useLatestBotMessage(bot.id, lastMessage, presence === "working");
  return (
    <Draggable
      draggableId={rosterBotDragId(bot.id)}
      index={index}
      disableInteractiveElementBlocking
    >
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          role="listitem"
          className={cn("list-none", snapshot.isDragging && "z-50")}
          {...provided.draggableProps}
        >
          <div
            data-testid="roster-bot-row"
            data-bot-hover
            className={cn(
              "flex w-full items-center rounded-lg outline-none select-none",
              snapshot.isDragging
                ? "bg-sidebar-row-active text-sidebar-foreground shadow-xl"
                : isActive
                  ? "bg-sidebar-row-active text-sidebar-foreground"
                  : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
            )}
          >
            <button
              type="button"
              aria-current={isActive || undefined}
              onClick={() => onSelect(bot)}
              className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
              {...provided.dragHandleProps}
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
        </div>
      )}
    </Draggable>
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
  const members = group.members.filter(
    (member) =>
      member.kind === "bot" && bots.some((bot) => bot.id === member.botId && !bot.archivedAt),
  ).length;
  return (
    <Droppable droppableId={rosterGroupDropId(group.id)} type="roster-bot">
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          data-testid="roster-group-card"
          role="listitem"
          className="relative"
          {...provided.droppableProps}
        >
          <button
            type="button"
            aria-current={isActive || undefined}
            onClick={onSelect}
            className={cn(
              "flex h-24 w-20 flex-col items-center justify-center gap-2 rounded-xl px-1.5 text-center text-sidebar-foreground outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              snapshot.isDraggingOver
                ? "bg-sidebar-row-active ring-2 ring-ring"
                : isActive
                  ? "bg-sidebar-row-active ring-1 ring-border"
                  : "bg-transparent hover:bg-sidebar-row-hover",
            )}
          >
            <GroupMemberStack
              group={group}
              bots={bots}
              ringClassName="ring-sidebar"
              sizeClassName="size-9"
              className="shrink-0"
            />
            <span className="min-w-0 max-w-full">
              <span className="block truncate text-xs font-medium">{group.name}</span>
              <span className="sr-only">{members} bots</span>
            </span>
          </button>
          <div className="pointer-events-none absolute inset-0 opacity-0">
            {provided.placeholder}
          </div>
        </div>
      )}
    </Droppable>
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

  const visibleBots = useMemo(
    () => filterRosterBots(bots, query).filter((bot) => bot.archivedAt === null),
    [bots, query],
  );
  const visibleGroups = useMemo(
    () => filterRosterGroups(groups, bots, query),
    [bots, groups, query],
  );
  const groupRouteActive = pathname.startsWith("/groups/");
  const handleDragEnd = ({ draggableId, source, destination }: DropResult) => {
    if (!destination) return;
    const botId = parseRosterBotDragId(draggableId);
    const groupId = parseRosterGroupDropId(destination.droppableId);
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
    } else if (botId && destination.droppableId === "roster-bots") {
      const layout = reorderVisibleRosterBots(
        bots,
        visibleBots.map((bot) => bot.id),
        source.index,
        destination.index,
      );
      if (layout) useRosterStore.getState().commitBotLayout(layout);
    }
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
            {/* Icon-collapsed rail: groups first, then every visible bot. */}
            <SidebarGroup className="hidden items-center gap-1 px-0 pt-1 group-data-[collapsible=icon]:flex">
              <ul data-testid="roster-rail" className="flex flex-col items-center gap-1">
                {visibleGroups.map((group) => (
                  <li key={group.id} className="list-none">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-current={pathname === `/groups/${group.id}` || undefined}
                            onClick={() =>
                              void navigate({
                                to: "/groups/$groupId",
                                params: { groupId: group.id },
                              })
                            }
                            className={cn(
                              "flex size-9 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
                              pathname === `/groups/${group.id}`
                                ? "bg-sidebar-row-active"
                                : "hover:bg-sidebar-row-hover",
                            )}
                          >
                            <GroupMemberStack
                              group={group}
                              bots={bots}
                              ringClassName="ring-sidebar"
                              sizeClassName="size-5"
                            />
                          </button>
                        }
                      />
                      <TooltipPopup side="right">{group.name}</TooltipPopup>
                    </Tooltip>
                  </li>
                ))}
                {visibleBots.map((bot) => (
                  <li key={bot.id} className="list-none">
                    <RailBotButton
                      bot={bot}
                      isActive={!groupRouteActive && selectedBotId === bot.id}
                      onSelect={handleSelect}
                    />
                  </li>
                ))}
              </ul>
            </SidebarGroup>
            <DragDropContext onDragEnd={handleDragEnd}>
              {visibleGroups.length > 0 ? (
                <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-3 pt-2 group-data-[collapsible=icon]:hidden">
                  <h2 className="mb-2 px-1 text-xs font-medium text-sidebar-muted-foreground">
                    Groups
                  </h2>
                  <div role="list" aria-label="Groups" className="flex flex-wrap gap-2 pb-1">
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
                  </div>
                </SidebarGroup>
              ) : null}
              <div className="px-[calc(var(--sidebar-content-inset)+0.25rem)] pt-1 text-xs font-medium text-sidebar-muted-foreground group-data-[collapsible=icon]:hidden">
                Bots
              </div>
              <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden">
                <Droppable droppableId="roster-bots" type="roster-bot">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      role="list"
                      aria-label="Bots"
                      data-drag-over={snapshot.isDraggingOver || undefined}
                      className="flex min-h-12 flex-col gap-px rounded-lg transition-colors data-[drag-over=true]:bg-sidebar-row-hover"
                      {...provided.droppableProps}
                    >
                      {visibleBots.map((bot, index) => (
                        <BotRosterRow
                          key={bot.id}
                          bot={bot}
                          index={index}
                          lastMessage={lastMessageByBotId[bot.id] ?? null}
                          isActive={!groupRouteActive && selectedBotId === bot.id}
                          onSelect={handleSelect}
                        />
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
                {visibleBots.length === 0 && visibleGroups.length === 0 ? (
                  <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
                    No bots match
                  </div>
                ) : null}
              </SidebarGroup>
            </DragDropContext>
          </>
        )}
      </SidebarContent>
      {/* Rail create menu sits above the footer, like the expanded header's plus. */}
      <div className="hidden shrink-0 flex-col items-center pb-1 group-data-[collapsible=icon]:flex">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label="Create"
                className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PlusIcon className="size-4" />
              </button>
            }
          />
          <MenuPopup align="end" side="right">
            <MenuItem onClick={handleNewBot}>
              <BotIcon />
              New bot
            </MenuItem>
            <MenuItem onClick={handleNewGroup}>
              <UsersIcon />
              New group
            </MenuItem>
          </MenuPopup>
        </Menu>
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
