import { DragDropContext, Draggable, Droppable, type DropResult } from "@hello-pangea/dnd";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotId, EnvironmentId, GroupId, ThreadId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderInputIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
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
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { DEFAULT_BOT_RUNTIME_MODE } from "./botSandbox";
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
  parseRosterBotDragId,
  parseRosterGroupDropId,
  rosterBotDragId,
  rosterGroupDropId,
  type RosterLastMessage,
  type RosterPresence,
} from "./roster.logic";
import { useRosterStore, type RosterItemRef, type RosterSection } from "./rosterStore";
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
  onNewSection,
}: {
  onNewBot: () => void;
  onNewGroup: () => void;
  onNewSection: () => void;
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
              <MenuItem onClick={onNewSection}>
                <FolderInputIcon />
                New section
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
  const visibleMessages = useMemo(() => visibleBotChatMessages(messages), [messages]);
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
  pinned,
  sections,
  onPin,
  onMove,
  dragDisabled,
}: {
  bot: Bot;
  lastMessage: RosterLastMessage | null;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
  index: number;
  pinned: boolean;
  sections: readonly RosterSection[];
  onPin: (pinned: boolean) => void;
  onMove: (sectionId: string | null) => void;
  dragDisabled: boolean;
}) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const presence = useBotPresence(bot.id);
  const latestMessage = useLatestBotMessage(bot.id, lastMessage);
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: bot.id });
  return (
    <Draggable
      draggableId={rosterBotDragId(bot.id)}
      index={index}
      isDragDisabled={dragDisabled}
      disableInteractiveElementBlocking
    >
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          role="listitem"
          className={cn("list-none touch-pan-y", snapshot.isDragging && "z-50")}
          {...provided.draggableProps}
        >
          <div
            data-testid="roster-bot-row"
            data-bot-hover
            onContextMenu={(event) => {
              event.preventDefault();
              menuTriggerRef.current?.click();
            }}
            className={cn(
              "relative flex w-full items-center rounded-lg outline-none select-none",
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
            <Menu>
              <MenuTrigger
                render={
                  <button
                    ref={menuTriggerRef}
                    type="button"
                    aria-label={`Actions for ${bot.name}`}
                    className="absolute right-2 top-1/2 size-px -translate-y-1/2 overflow-hidden opacity-0 outline-none focus-visible:size-7 focus-visible:overflow-visible focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              />
              <MenuPopup align="end">
                <MenuItem onClick={() => onPin(!pinned)}>
                  <PinIcon />
                  {pinned ? "Unpin" : "Pin"}
                </MenuItem>
                <MenuSub>
                  <MenuSubTrigger>
                    <FolderInputIcon />
                    Move to
                  </MenuSubTrigger>
                  <MenuSubPopup>
                    {sections.map((section) => (
                      <MenuItem key={section.id} onClick={() => onMove(section.id)}>
                        {section.name}
                      </MenuItem>
                    ))}
                    <MenuItem onClick={() => onMove(null)}>Unassigned</MenuItem>
                  </MenuSubPopup>
                </MenuSub>
              </MenuPopup>
            </Menu>
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
  pinned,
  onPin,
  index,
  sections,
  onMove,
  dragDisabled,
}: {
  group: Group;
  bots: readonly Bot[];
  isActive: boolean;
  onSelect: () => void;
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  index: number;
  sections: readonly RosterSection[];
  onMove: (sectionId: string | null) => void;
  dragDisabled: boolean;
}) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const members = group.members.filter(
    (member) =>
      member.kind === "bot" && bots.some((bot) => bot.id === member.botId && !bot.archivedAt),
  ).length;
  return (
    <Draggable
      draggableId={rosterGroupDropId(group.id)}
      index={index}
      isDragDisabled={dragDisabled}
    >
      {(dragProvided, dragSnapshot) => (
        <div
          ref={dragProvided.innerRef}
          {...dragProvided.draggableProps}
          role="listitem"
          data-testid="roster-group-card"
          onContextMenu={(event) => {
            event.preventDefault();
            menuTriggerRef.current?.click();
          }}
          className={cn(
            "relative flex touch-pan-y items-center rounded-lg",
            dragSnapshot.isDragging && "z-50 bg-sidebar shadow-xl",
            isActive && "bg-sidebar-row-active",
          )}
        >
          <button
            type="button"
            aria-current={isActive || undefined}
            onClick={onSelect}
            {...dragProvided.dragHandleProps}
            className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
          >
            <GroupMemberStack group={group} bots={bots} sizeClassName="size-10" />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.name}</span>
            <span className="text-xs text-sidebar-muted-foreground">{members}</span>
          </button>
          <Menu>
            <MenuTrigger
              render={
                <button
                  ref={menuTriggerRef}
                  type="button"
                  aria-label={`Actions for ${group.name}`}
                  className="absolute right-2 top-1/2 size-px -translate-y-1/2 overflow-hidden opacity-0 outline-none focus-visible:size-7 focus-visible:overflow-visible focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            />
            <MenuPopup align="end">
              <MenuItem onClick={() => onPin(!pinned)}>
                <PinIcon />
                {pinned ? "Unpin" : "Pin"}
              </MenuItem>
              <MenuSub>
                <MenuSubTrigger>
                  <FolderInputIcon />
                  Move to
                </MenuSubTrigger>
                <MenuSubPopup>
                  {sections.map((section) => (
                    <MenuItem key={section.id} onClick={() => onMove(section.id)}>
                      {section.name}
                    </MenuItem>
                  ))}
                  <MenuItem onClick={() => onMove(null)}>Unassigned</MenuItem>
                </MenuSubPopup>
              </MenuSub>
            </MenuPopup>
          </Menu>
        </div>
      )}
    </Draggable>
  );
}

function PinnedRosterItem({
  item,
  bots,
  groups,
  onSelectBot,
  onSelectGroup,
}: {
  item: RosterItemRef;
  bots: readonly Bot[];
  groups: readonly Group[];
  onSelectBot: (bot: Bot) => void;
  onSelectGroup: (group: Group) => void;
}) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const bot = item.kind === "bot" ? bots.find((candidate) => candidate.id === item.id) : null;
  const group = item.kind === "group" ? groups.find((candidate) => candidate.id === item.id) : null;
  if (!bot && !group) return null;
  const label = bot?.name ?? group!.name;
  return (
    <div
      className="relative w-20 shrink-0"
      onContextMenu={(event) => {
        event.preventDefault();
        menuTriggerRef.current?.click();
      }}
    >
      <button
        type="button"
        title={label}
        onClick={() => (bot ? onSelectBot(bot) : onSelectGroup(group!))}
        className="flex w-full flex-col items-center gap-1.5 rounded-xl px-1 py-2 text-sidebar-foreground outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring"
      >
        {bot ? (
          <BotAvatarView avatar={bot.avatar} name={bot.name} className="size-12" />
        ) : (
          <span className="flex size-14 items-center justify-center">
            <GroupMemberStack group={group!} bots={bots} sizeClassName="size-14" />
          </span>
        )}
        <span className="w-full truncate text-[11px] font-medium">{label}</span>
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button
              ref={menuTriggerRef}
              type="button"
              aria-label={`Actions for pinned ${label}`}
              className="absolute right-2 top-2 size-px overflow-hidden opacity-0 outline-none focus-visible:size-7 focus-visible:overflow-visible focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        />
        <MenuPopup align="center">
          <MenuItem onClick={() => useRosterStore.getState().setItemPinned(item, false)}>
            <PinIcon />
            Unpin
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
}

export default function BotRosterSidebar() {
  useServerRosterSync();
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const createBotCommand = useAtomCommand(botEnvironment.create, {
    reportFailure: false,
  });
  const createGroupCommand = useAtomCommand(botEnvironment.groups.create, {
    reportFailure: false,
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const { bots, groups, lastMessageByBotId, selectedBotId, sections, pinnedItems } = useRosterStore(
    useShallow((state) => ({
      bots: state.bots,
      groups: state.groups,
      lastMessageByBotId: state.lastMessageByBotId,
      selectedBotId: state.selectedBotId,
      sections: state.sections,
      pinnedItems: state.pinnedItems,
    })),
  );
  const [query, setQuery] = useState("");

  const visibleBots = useMemo(
    () => filterRosterBots(bots, query).filter((bot) => bot.archivedAt === null),
    [bots, query],
  );
  const pinnedBots = visibleBots.filter((bot) => bot.pinned);
  const unpinnedBots = visibleBots.filter((bot) => !bot.pinned);
  const groupSections = useMemo(
    () => buildGroupedRosterSections(dragLayout ?? bots, groups, query),
    [bots, dragLayout, groups, query],
  );
  const groupRouteActive = pathname.startsWith("/groups/");
  const pinnedBotIds = useMemo(
    () => new Set(pinnedItems.filter((item) => item.kind === "bot").map((item) => item.id)),
    [pinnedItems],
  );
  const assignedBotIds = useMemo(
    () => new Set(sections.flatMap((section) => section.botIds)),
    [sections],
  );
  const botsBySection = useMemo(
    () =>
      new Map(
        sections.map((section) => [
          section.id,
          section.botIds
            .map((id) => visibleBots.find((bot) => bot.id === id))
            .filter((bot): bot is Bot => bot !== undefined && !pinnedBotIds.has(bot.id)),
        ]),
      ),
    [pinnedBotIds, sections, visibleBots],
  );
  const unassignedBots = useMemo(
    () => visibleBots.filter((bot) => !assignedBotIds.has(bot.id) && !pinnedBotIds.has(bot.id)),
    [assignedBotIds, pinnedBotIds, visibleBots],
  );
  const pinnedGroupIds = useMemo(
    () => new Set(pinnedItems.filter((item) => item.kind === "group").map((item) => item.id)),
    [pinnedItems],
  );
  const assignedGroupIds = useMemo(
    () => new Set(sections.flatMap((section) => section.groupIds ?? [])),
    [sections],
  );
  const groupsBySection = useMemo(
    () =>
      new Map(
        sections.map((section) => [
          section.id,
          (section.groupIds ?? [])
            .map((id) => visibleGroups.find((group) => group.id === id))
            .filter(
              (group): group is Group => group !== undefined && !pinnedGroupIds.has(group.id),
            ),
        ]),
      ),
    [pinnedGroupIds, sections, visibleGroups],
  );
  const unassignedGroups = useMemo(
    () =>
      visibleGroups.filter(
        (group) => !assignedGroupIds.has(group.id) && !pinnedGroupIds.has(group.id),
      ),
    [assignedGroupIds, pinnedGroupIds, visibleGroups],
  );
  const handleDragEnd = ({ draggableId, source, destination, type }: DropResult) => {
    if (!destination) return;
    if (type === "roster-section") {
      useRosterStore.getState().reorderSections(source.index, destination.index);
      return;
    }
    if (type === "roster-group") {
      const groupId = parseRosterGroupDropId(draggableId);
      if (!groupId) return;
      if (destination.droppableId.startsWith("section-groups:")) {
        useRosterStore
          .getState()
          .moveGroupToSection(
            groupId,
            destination.droppableId.slice("section-groups:".length),
            destination.index,
          );
      } else if (destination.droppableId === "roster-unassigned-groups") {
        useRosterStore.getState().moveGroupToSection(groupId, null, destination.index);
      }
      return;
    }
    const botId = parseRosterBotDragId(draggableId);
    if (botId && destination.droppableId.startsWith("section:")) {
      useRosterStore
        .getState()
        .moveBotToSection(
          botId,
          destination.droppableId.slice("section:".length),
          destination.index,
        );
    } else if (botId && destination.droppableId === "roster-unassigned") {
      useRosterStore.getState().moveBotToSection(botId, null, destination.index);
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
      toastManager.add({
        type: "error",
        title: "Connect an environment first",
      });
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
        runtimeMode: DEFAULT_BOT_RUNTIME_MODE,
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
      toastManager.add({
        type: "error",
        title: "Connect an environment first",
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
      toastManager.add({ type: "error", title: "Could not create group" });
      return;
    }
    setNewGroupOpen(false);
    void navigate({ to: "/groups/$groupId", params: { groupId } });
  };

  const handleNewSection = () => {
    const name = window.prompt("Section name");
    if (name) useRosterStore.getState().createSection(name);
  };

  const handleSelectGroup = (group: Group) => {
    void navigate({ to: "/groups/$groupId", params: { groupId: group.id } });
  };

  const isPinned = (item: RosterItemRef) =>
    pinnedItems.some((candidate) => candidate.kind === item.kind && candidate.id === item.id);

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
      <RosterSidebarHeader
        onNewBot={handleNewBot}
        onNewGroup={handleNewGroup}
        onNewSection={handleNewSection}
      />
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
                            <GroupMemberStack group={group} bots={bots} sizeClassName="size-5" />
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
              {pinnedItems.length > 0 ? (
                <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-3 pt-3 group-data-[collapsible=icon]:hidden">
                  <div
                    className="flex justify-center gap-2 overflow-x-auto px-2 py-1"
                    role="list"
                    aria-label="Pinned bots and groups"
                  >
                    {pinnedItems.map((item) => (
                      <PinnedRosterItem
                        key={`${item.kind}:${item.id}`}
                        item={item}
                        bots={bots}
                        groups={groups}
                        onSelectBot={handleSelect}
                        onSelectGroup={handleSelectGroup}
                      />
                    ))}
                  </div>
                </SidebarGroup>
              ) : null}
              <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden">
                <Droppable droppableId="roster-sections" type="roster-section">
                  {(sectionsProvided) => (
                    <div ref={sectionsProvided.innerRef} {...sectionsProvided.droppableProps}>
                      {sections.map((section, sectionIndex) => {
                        const sectionBots = botsBySection.get(section.id) ?? [];
                        const sectionGroups = groupsBySection.get(section.id) ?? [];
                        const collapsed = query.length === 0 && section.collapsed;
                        return (
                          <Draggable
                            key={section.id}
                            draggableId={`section:${section.id}`}
                            index={sectionIndex}
                            isDragDisabled={query.length > 0}
                          >
                            {(sectionProvided, sectionSnapshot) => (
                              <section
                                ref={sectionProvided.innerRef}
                                className={cn(
                                  "mb-1 rounded-lg",
                                  sectionSnapshot.isDragging && "bg-sidebar shadow-xl",
                                )}
                                {...sectionProvided.draggableProps}
                              >
                                <div
                                  className="relative flex h-8 items-center rounded-md hover:bg-sidebar-row-hover"
                                  onContextMenu={(event) => {
                                    event.preventDefault();
                                    event.currentTarget
                                      .querySelector<HTMLButtonElement>("[data-section-actions]")
                                      ?.click();
                                  }}
                                >
                                  <button
                                    type="button"
                                    aria-expanded={!collapsed}
                                    onClick={() =>
                                      useRosterStore.getState().toggleSection(section.id)
                                    }
                                    className="flex min-w-0 flex-1 cursor-grab items-center gap-1.5 px-2 text-left text-xs font-medium text-sidebar-muted-foreground active:cursor-grabbing"
                                    {...sectionProvided.dragHandleProps}
                                  >
                                    {collapsed ? (
                                      <ChevronRightIcon className="size-3.5" />
                                    ) : (
                                      <ChevronDownIcon className="size-3.5" />
                                    )}
                                    <span className="truncate">{section.name}</span>
                                    <span className="tabular-nums">
                                      {sectionBots.length + sectionGroups.length}
                                    </span>
                                  </button>
                                  <Menu>
                                    <MenuTrigger
                                      render={
                                        <button
                                          type="button"
                                          data-section-actions
                                          aria-label={`Actions for ${section.name}`}
                                          className="absolute right-2 top-1/2 size-px -translate-y-1/2 overflow-hidden opacity-0 outline-none focus-visible:size-7 focus-visible:overflow-visible focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
                                        />
                                      }
                                    />
                                    <MenuPopup align="end">
                                      <MenuItem
                                        variant="destructive"
                                        onClick={() =>
                                          useRosterStore.getState().deleteSection(section.id)
                                        }
                                      >
                                        <Trash2Icon />
                                        Delete section
                                      </MenuItem>
                                    </MenuPopup>
                                  </Menu>
                                </div>
                                <Droppable
                                  droppableId={`section-groups:${section.id}`}
                                  type="roster-group"
                                >
                                  {(provided, snapshot) => (
                                    <div
                                      ref={provided.innerRef}
                                      role="list"
                                      aria-label={`${section.name} groups`}
                                      data-drag-over={snapshot.isDraggingOver || undefined}
                                      className={cn(
                                        "rounded-lg data-[drag-over=true]:bg-sidebar-row-hover",
                                        collapsed
                                          ? "min-h-2"
                                          : sectionGroups.length > 0
                                            ? "min-h-10"
                                            : "min-h-1",
                                      )}
                                      {...provided.droppableProps}
                                    >
                                      {!collapsed
                                        ? sectionGroups.map((group, index) => (
                                            <GroupRosterRow
                                              key={group.id}
                                              group={group}
                                              bots={bots}
                                              index={index}
                                              sections={sections}
                                              dragDisabled={query.length > 0}
                                              isActive={pathname === `/groups/${group.id}`}
                                              onSelect={() => handleSelectGroup(group)}
                                              pinned={false}
                                              onPin={(pinned) =>
                                                useRosterStore.getState().setItemPinned(
                                                  {
                                                    kind: "group",
                                                    id: group.id,
                                                  },
                                                  pinned,
                                                )
                                              }
                                              onMove={(sectionId) =>
                                                useRosterStore
                                                  .getState()
                                                  .moveGroupToSection(group.id, sectionId)
                                              }
                                            />
                                          ))
                                        : null}
                                      {provided.placeholder}
                                    </div>
                                  )}
                                </Droppable>
                                <Droppable droppableId={`section:${section.id}`} type="roster-bot">
                                  {(provided, snapshot) => (
                                    <div
                                      ref={provided.innerRef}
                                      role="list"
                                      aria-label={section.name}
                                      data-drag-over={snapshot.isDraggingOver || undefined}
                                      className={cn(
                                        "rounded-lg data-[drag-over=true]:bg-sidebar-row-hover",
                                        collapsed ? "min-h-2" : "min-h-10",
                                      )}
                                      {...provided.droppableProps}
                                    >
                                      {!collapsed
                                        ? sectionBots.map((bot, index) => (
                                            <BotRosterRow
                                              key={bot.id}
                                              bot={bot}
                                              index={index}
                                              lastMessage={lastMessageByBotId[bot.id] ?? null}
                                              isActive={
                                                !groupRouteActive && selectedBotId === bot.id
                                              }
                                              onSelect={handleSelect}
                                              pinned={isPinned({
                                                kind: "bot",
                                                id: bot.id,
                                              })}
                                              sections={sections}
                                              onPin={(pinned) =>
                                                useRosterStore
                                                  .getState()
                                                  .setItemPinned(
                                                    { kind: "bot", id: bot.id },
                                                    pinned,
                                                  )
                                              }
                                              onMove={(sectionId) =>
                                                useRosterStore
                                                  .getState()
                                                  .moveBotToSection(bot.id, sectionId)
                                              }
                                              dragDisabled={query.length > 0}
                                            />
                                          ))
                                        : null}
                                      {provided.placeholder}
                                    </div>
                                  )}
                                </Droppable>
                              </section>
                            )}
                          </Draggable>
                        );
                      })}
                      {sectionsProvided.placeholder}
                    </div>
                  )}
                </Droppable>
                <div className="flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-sidebar-muted-foreground">
                  <ChevronDownIcon className="size-3.5" />
                  <span>Unassigned</span>
                  <span className="tabular-nums">
                    {unassignedBots.length + unassignedGroups.length}
                  </span>
                </div>
                <Droppable droppableId="roster-unassigned-groups" type="roster-group">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      role="list"
                      aria-label="Unassigned groups"
                      data-drag-over={snapshot.isDraggingOver || undefined}
                      className="min-h-1 rounded-lg data-[drag-over=true]:bg-sidebar-row-hover"
                      {...provided.droppableProps}
                    >
                      {unassignedGroups.map((group, index) => (
                        <GroupRosterRow
                          key={group.id}
                          group={group}
                          bots={bots}
                          index={index}
                          sections={sections}
                          dragDisabled={query.length > 0}
                          isActive={pathname === `/groups/${group.id}`}
                          onSelect={() => handleSelectGroup(group)}
                          pinned={false}
                          onPin={(pinned) =>
                            useRosterStore
                              .getState()
                              .setItemPinned({ kind: "group", id: group.id }, pinned)
                          }
                          onMove={(sectionId) =>
                            useRosterStore.getState().moveGroupToSection(group.id, sectionId)
                          }
                        />
                      ))}
                      {provided.placeholder}
                    </div>
                  )}
                </Droppable>
                <Droppable droppableId="roster-unassigned" type="roster-bot">
                  {(provided, snapshot) => (
                    <div
                      ref={provided.innerRef}
                      role="list"
                      aria-label="Unassigned"
                      data-drag-over={snapshot.isDraggingOver || undefined}
                      className="min-h-10 rounded-lg data-[drag-over=true]:bg-sidebar-row-hover"
                      {...provided.droppableProps}
                    >
                      {unassignedBots.map((bot, index) => (
                        <BotRosterRow
                          key={bot.id}
                          bot={bot}
                          index={index}
                          lastMessage={lastMessageByBotId[bot.id] ?? null}
                          isActive={!groupRouteActive && selectedBotId === bot.id}
                          onSelect={handleSelect}
                          pinned={isPinned({ kind: "bot", id: bot.id })}
                          sections={sections}
                          onPin={(pinned) =>
                            useRosterStore
                              .getState()
                              .setItemPinned({ kind: "bot", id: bot.id }, pinned)
                          }
                          onMove={(sectionId) =>
                            useRosterStore.getState().moveBotToSection(bot.id, sectionId)
                          }
                          dragDisabled={query.length > 0}
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
