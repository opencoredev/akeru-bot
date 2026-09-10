import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { BotId, EnvironmentId, GroupId, ThreadId } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FolderInputIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  SearchIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { isTerminalFocused } from "../../lib/terminalFocus";
import { cn, randomUUID } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { botEnvironment } from "../../state/bots";
import { useThreadMessages, useThreadShells } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../../terminalUiStateStore";
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
  buildRosterListItems,
  filterRosterBots,
  filterRosterGroups,
  formatRosterTimestamp,
  isRecordableChatPath,
  parseChatPath,
  parseRosterEntryId,
  parseRosterSectionHeaderId,
  planRosterDrop,
  planRosterSectionDrop,
  resolveLatestRosterMessage,
  resolveRosterDropTarget,
  resolveRosterDropVerb,
  resolveRosterIndicator,
  rosterItemKey,
  rosterItemsEqual,
  rosterItemsForZone,
  rosterListItemId,
  rosterMarkerId,
  rosterSectionItems,
  rosterZoneHasVisibleEntries,
  rosterZonesEqual,
  orderRosterBotsForShortcuts,
  resolveRosterShortcutBot,
  type RosterDropVerb,
  type RosterItemRef,
  type RosterLastMessage,
  type RosterListMarker,
  type RosterPresence,
  type RosterZone,
} from "./roster.logic";
import {
  animateRosterLayoutChanges,
  createRosterCollisionDetection,
  createRosterSortingStrategy,
  restrictBelowRosterLabel,
} from "./roster.drag";
import { createRosterListMotion } from "./roster.motion";
import { RosterDragLifecycle, RosterPointerSensor } from "./roster.pointer";
import { useRosterStore, type RosterSection } from "./rosterStore";
import type { Bot, BotAvatar, Group } from "./types";
import { useBotThreadRef } from "./useBotThreadRef";

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

type SortableRosterRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

function SortableRosterRow(props: {
  id: string;
  disabled: boolean;
  children: (bag: SortableRosterRowBag) => ReactNode;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.id,
    disabled: { draggable: props.disabled },
    animateLayoutChanges: animateRosterLayoutChanges,
  });
  const bag = useMemo(
    () => ({ listeners, setNodeRef, transform, transition, isDragging }),
    [listeners, setNodeRef, transform, transition, isDragging],
  );
  return props.children(bag);
}

function sortableRootProps(sortable: SortableRosterRowBag) {
  return {
    ref: sortable.setNodeRef,
    style: {
      transform: CSS.Translate.toString(sortable.transform),
      transition: sortable.transition,
      visibility:
        !sortable.isDragging && sortable.transform?.scaleY === 0 ? ("hidden" as const) : undefined,
    },
    ...sortable.listeners,
  };
}

const dropVerbBadge: Record<RosterDropVerb, ReactNode> = {
  pin: (
    <>
      <PinIcon aria-hidden className="size-3" />
      Pin
    </>
  ),
  unpin: (
    <>
      <PinOffIcon aria-hidden className="size-3" />
      Unpin
    </>
  ),
  move: (
    <>
      <FolderInputIcon aria-hidden className="size-3" />
      Move
    </>
  ),
};

const ROSTER_DRAG_LABEL_HEIGHT = 24;

const BotRosterRow = memo(function BotRosterRow({
  bot,
  lastMessage,
  isActive,
  onSelect,
  pinned,
  sections,
  onPin,
  onMove,
  canMoveUp,
  canMoveDown,
  onNudge,
  sortable,
  dropVerb,
}: {
  bot: Bot;
  lastMessage: RosterLastMessage | null;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
  pinned: boolean;
  sections: readonly RosterSection[];
  onPin: (pinned: boolean) => void;
  onMove: (sectionId: string | null) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onNudge: (delta: -1 | 1) => void;
  sortable: SortableRosterRowBag;
  dropVerb: RosterDropVerb | null;
}) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const presence = useBotPresence(bot.id);
  const latestMessage = useLatestBotMessage(bot.id, lastMessage);
  return (
    <li
      role="listitem"
      data-roster-item
      className={cn("list-none touch-pan-y", sortable.isDragging && "z-50")}
      {...sortableRootProps(sortable)}
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
          sortable.isDragging
            ? "bg-[linear-gradient(var(--sidebar-row-active),var(--sidebar-row-active)),linear-gradient(var(--sidebar),var(--sidebar))] text-sidebar-foreground shadow-lg"
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
          {sortable.isDragging && dropVerb !== null ? (
            <span
              role="status"
              data-testid="roster-drop-verb"
              className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[11px] font-medium text-primary"
            >
              {dropVerbBadge[dropVerb]}
            </span>
          ) : null}
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
            <MenuItem disabled={!canMoveUp} onClick={() => onNudge(-1)}>
              <ArrowUpIcon />
              Move up
            </MenuItem>
            <MenuItem disabled={!canMoveDown} onClick={() => onNudge(1)}>
              <ArrowDownIcon />
              Move down
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
  pinned,
  onPin,
  sections,
  onMove,
  canMoveUp,
  canMoveDown,
  onNudge,
  sortable,
  dropVerb,
}: {
  group: Group;
  bots: readonly Bot[];
  isActive: boolean;
  onSelect: () => void;
  pinned: boolean;
  onPin: (pinned: boolean) => void;
  sections: readonly RosterSection[];
  onMove: (sectionId: string | null) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onNudge: (delta: -1 | 1) => void;
  sortable: SortableRosterRowBag;
  dropVerb: RosterDropVerb | null;
}) {
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const members = group.members.filter(
    (member) =>
      member.kind === "bot" && bots.some((bot) => bot.id === member.botId && !bot.archivedAt),
  ).length;
  return (
    <li
      role="listitem"
      data-roster-item
      data-testid="roster-group-card"
      onContextMenu={(event) => {
        event.preventDefault();
        menuTriggerRef.current?.click();
      }}
      className={cn(
        "relative flex touch-pan-y items-center rounded-lg",
        sortable.isDragging && "z-50 bg-sidebar shadow-xl",
        isActive && "bg-sidebar-row-active",
      )}
      {...sortableRootProps(sortable)}
    >
      <button
        type="button"
        aria-current={isActive || undefined}
        onClick={onSelect}
        className="flex min-w-0 flex-1 cursor-grab items-center gap-2.5 rounded-lg px-2 py-1.5 text-left outline-none hover:bg-sidebar-row-hover focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      >
        <GroupMemberStack group={group} bots={bots} sizeClassName="size-10" />
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{group.name}</span>
        <span className="text-xs text-sidebar-muted-foreground">{members}</span>
        {sortable.isDragging && dropVerb !== null ? (
          <span
            role="status"
            data-testid="roster-drop-verb"
            className="pointer-events-none ml-auto inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-1.5 text-[11px] font-medium text-primary"
          >
            {dropVerbBadge[dropVerb]}
          </span>
        ) : null}
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
          <MenuItem disabled={!canMoveUp} onClick={() => onNudge(-1)}>
            <ArrowUpIcon />
            Move up
          </MenuItem>
          <MenuItem disabled={!canMoveDown} onClick={() => onNudge(1)}>
            <ArrowDownIcon />
            Move down
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
    </li>
  );
}

function SortableRosterMarker(props: {
  marker: RosterListMarker;
  className?: string;
  children?: ReactNode;
  draggable?: boolean;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition, listeners } = useSortable({
    id: rosterMarkerId(props.marker),
    disabled: { draggable: props.draggable !== true },
    animateLayoutChanges: animateRosterLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition:
          typeof props.marker !== "string" && props.marker.kind === "section-placeholder"
            ? "none"
            : props.marker === "unassigned-placeholder"
              ? "none"
              : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
      {...(props.draggable ? listeners : {})}
    >
      {props.children}
    </li>
  );
}

function RosterDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableRosterMarker
      marker={props.marker}
      data-testid={`roster-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="roster-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableRosterMarker>
  );
}

function RosterSectionPlaceholder(props: {
  marker: RosterListMarker;
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableRosterMarker
      marker={props.marker}
      data-testid="roster-section-placeholder"
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableRosterMarker>
  );
}

export default function BotRosterSidebar() {
  const navigate = useNavigate();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const environmentId = usePrimaryEnvironmentId();
  const createBotCommand = useAtomCommand(botEnvironment.create, {
    reportFailure: false,
  });
  const createGroupCommand = useAtomCommand(botEnvironment.groups.create, {
    reportFailure: false,
  });
  const pathname = useLocation({ select: (location) => location.pathname });
  const {
    bots,
    groups,
    lastMessageByBotId,
    selectedBotId,
    sections,
    pinnedItems,
    unassignedItems,
  } = useRosterStore(
    useShallow((state) => ({
      bots: state.bots,
      groups: state.groups,
      lastMessageByBotId: state.lastMessageByBotId,
      selectedBotId: state.selectedBotId,
      sections: state.sections,
      pinnedItems: state.pinnedItems,
      unassignedItems: state.unassignedItems,
    })),
  );
  const [query, setQuery] = useState("");
  const activeBotThreadRef = useBotThreadRef(
    pathname.startsWith("/bots/") ? (selectedBotId ?? "") : "",
  );
  const terminalOpen = useTerminalUiStateStore((state) =>
    activeBotThreadRef
      ? selectThreadTerminalUiState(state.terminalUiStateByThreadKey, activeBotThreadRef)
          .terminalOpen
      : false,
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
  const visibleSectionLayouts = useMemo(
    () =>
      sections.map((section) => ({
        id: section.id,
        name: section.name,
        collapsed: !searching && section.collapsed,
        items: rosterSectionItems(section).filter(
          (item) => liveItem(item) && !pinnedKeys.has(rosterItemKey(item)),
        ),
      })),
    [liveItem, pinnedKeys, searching, sections],
  );
  const assignedKeys = useMemo(
    () => new Set(sections.flatMap((section) => rosterSectionItems(section).map(rosterItemKey))),
    [sections],
  );
  const visibleUnassignedItems = useMemo(() => {
    const remaining = (item: RosterItemRef) =>
      liveItem(item) &&
      !pinnedKeys.has(rosterItemKey(item)) &&
      !assignedKeys.has(rosterItemKey(item));
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
  }, [assignedKeys, liveItem, pinnedKeys, unassignedItems, visibleBots, visibleGroups]);
  const rosterListItems = useMemo(
    () =>
      buildRosterListItems({
        pinnedItems: visiblePinnedItems,
        sections: visibleSectionLayouts,
        unassignedItems: visibleUnassignedItems,
      }),
    [visiblePinnedItems, visibleSectionLayouts, visibleUnassignedItems],
  );
  const firstSectionId = sections[0]?.id ?? null;
  const zoneByEntryId = useMemo(() => {
    const map = new Map<string, RosterZone>();
    for (const item of rosterListItems) {
      if (item.kind === "entry") map.set(rosterListItemId(item), item.zone);
    }
    return map;
  }, [rosterListItems]);
  const [dragState, setDragState] = useState<{
    readonly activeId: string;
    readonly from: RosterZone | "section";
    readonly targetZone: RosterZone | null;
    readonly activationY: number | null;
  } | null>(null);
  const listMotionRef = useRef<ReturnType<typeof createRosterListMotion> | null>(null);
  const rosterListRef = useRef<HTMLUListElement | null>(null);
  const dragLabelOffsetRef = useRef(0);
  const dragSensorRef = useRef<RosterPointerSensor | null>(null);
  const attachListMotionRef = useCallback((node: HTMLUListElement | null) => {
    rosterListRef.current = node;
    listMotionRef.current?.dispose();
    listMotionRef.current = node === null ? null : createRosterListMotion(node);
    listMotionRef.current?.update(false);
  }, []);
  const finishRosterDrag = useCallback((started: boolean) => {
    dragSensorRef.current = null;
    if (started) {
      listMotionRef.current?.release();
      setDragState(null);
    }
  }, []);
  const attachDragSensor = useCallback((sensor: RosterPointerSensor) => {
    dragSensorRef.current = sensor;
  }, []);
  const cancelRosterDrag = useCallback(() => {
    dragSensorRef.current?.cancel();
  }, []);
  const dndSensors = useSensors(
    useSensor(RosterPointerSensor, {
      distance: 6,
      onAttach: attachDragSensor,
      onFinish: finishRosterDrag,
    }),
  );
  const restrictBelowPins = useCallback(
    (args: Parameters<typeof restrictBelowRosterLabel>[0]) =>
      restrictBelowRosterLabel(args, dragLabelOffsetRef.current),
    [],
  );
  const handleRosterDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      const sectionId = parseRosterSectionHeaderId(activeId);
      const from = sectionId ? ("section" as const) : zoneByEntryId.get(activeId);
      if (from === undefined) return;
      listMotionRef.current?.suspend();
      const list = rosterListRef.current;
      const header = list?.querySelector<HTMLElement>('[data-testid="roster-pinned-header"]');
      if (list && header) {
        const listRect = list.getBoundingClientRect();
        const scale = list.offsetWidth > 0 ? listRect.width / list.offsetWidth : 1;
        dragLabelOffsetRef.current =
          header.getBoundingClientRect().top - listRect.top + ROSTER_DRAG_LABEL_HEIGHT * scale;
      } else {
        dragLabelOffsetRef.current = 0;
      }
      setDragState({
        activeId,
        from,
        targetZone: from === "section" ? null : from,
        activationY:
          event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
      });
    },
    [zoneByEntryId],
  );
  const handleRosterDragOver = useCallback(
    (event: DragOverEvent) => {
      const activeId = String(event.active.id);
      if (parseRosterSectionHeaderId(activeId)) return;
      const target = event.over
        ? resolveRosterDropTarget(rosterListItems, activeId, String(event.over.id), firstSectionId)
        : null;
      setDragState((current) =>
        current === null || current.activeId !== activeId
          ? current
          : { ...current, targetZone: target?.zone ?? null },
      );
    },
    [firstSectionId, rosterListItems],
  );
  const handleRosterDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (overId === null) return;
      const sectionId = parseRosterSectionHeaderId(activeId);
      if (sectionId) {
        useRosterStore.getState().applyRosterDrop(
          planRosterSectionDrop({
            sectionIds: sections.map((section) => section.id),
            activeSectionId: sectionId,
            overId,
          }),
        );
        return;
      }
      const from = zoneByEntryId.get(activeId);
      const target = resolveRosterDropTarget(rosterListItems, activeId, overId, firstSectionId);
      if (from === undefined || target === null) return;
      useRosterStore.getState().applyRosterDrop(
        planRosterDrop({
          activeId,
          from,
          target,
          pinnedOrder: visiblePinnedItems,
        }),
      );
    },
    [firstSectionId, rosterListItems, sections, visiblePinnedItems, zoneByEntryId],
  );
  useEffect(() => {
    if (
      dragState !== null &&
      !rosterListItems.some((item) => rosterListItemId(item) === dragState.activeId)
    ) {
      cancelRosterDrag();
    }
  }, [cancelRosterDrag, dragState, rosterListItems]);
  const listMotionPaused = dragState !== null;
  const rosterListOrderKey = useMemo(
    () =>
      rosterListItems
        .map((item) =>
          item.kind === "entry"
            ? `${rosterItemKey(item.item)}:${rosterListItemId(item)}`
            : rosterListItemId(item),
        )
        .join("\0"),
    [rosterListItems],
  );
  useLayoutEffect(() => {
    void rosterListOrderKey;
    listMotionRef.current?.update(!listMotionPaused && rosterListItems.length > 0);
  }, [listMotionPaused, rosterListItems.length, rosterListOrderKey]);
  const sortableIds = useMemo(() => rosterListItems.map(rosterListItemId), [rosterListItems]);
  const rosterSortingStrategy = useMemo(
    () =>
      createRosterSortingStrategy({
        items: rosterListItems,
        firstSectionId,
        boundaryLabelHeight: ROSTER_DRAG_LABEL_HEIGHT,
      }),
    [firstSectionId, rosterListItems],
  );
  const dndCollisionDetection = useMemo(
    () =>
      createRosterCollisionDetection(
        (id) => {
          if (dragState === null) return true;
          if (dragState.from === "section") {
            return (
              parseRosterSectionHeaderId(id) !== null || id === rosterMarkerId("unassigned-header")
            );
          }
          return (
            resolveRosterDropTarget(rosterListItems, dragState.activeId, id, firstSectionId) !==
            null
          );
        },
        {
          items: rosterListItems,
          activationY: dragState?.activationY ?? null,
          firstSectionId,
        },
      ),
    [dragState, firstSectionId, rosterListItems],
  );
  const dragTargetZone = dragState?.targetZone ?? null;
  const dropVerbFor = (id: string): RosterDropVerb | null => {
    if (dragState === null || dragState.activeId !== id || dragState.from === "section")
      return null;
    return resolveRosterDropVerb(dragState.from, dragTargetZone);
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

  const shortcutBots = useMemo(
    () => orderRosterBotsForShortcuts(bots, pinnedItems, sections),
    [bots, pinnedItems, sections],
  );
  useEffect(() => {
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen,
          previewFocus: isPreviewFocused(),
          previewOpen,
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      const bot = resolveRosterShortcutBot(command ?? "", shortcutBots);
      if (!bot) return;

      event.preventDefault();
      event.stopPropagation();
      pendingClickedBotIdRef.current = bot.id;
      useRosterStore.getState().selectBot(bot.id);
      void navigate({ to: "/bots/$botId", params: { botId: bot.id } });
    };

    window.addEventListener("keydown", onWindowKeyDown);
    return () => window.removeEventListener("keydown", onWindowKeyDown);
  }, [keybindings, navigate, previewOpen, shortcutBots, terminalOpen]);

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
            <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden">
              <DndContext
                sensors={dndSensors}
                collisionDetection={dndCollisionDetection}
                modifiers={[
                  restrictToVerticalAxis,
                  restrictBelowPins,
                  restrictToFirstScrollableAncestor,
                ]}
                onDragStart={handleRosterDragStart}
                onDragOver={handleRosterDragOver}
                onDragEnd={handleRosterDragEnd}
              >
                <RosterDragLifecycle onUnmount={cancelRosterDrag} />
                <SortableContext items={sortableIds} strategy={rosterSortingStrategy}>
                  <ul
                    ref={attachListMotionRef}
                    role="list"
                    aria-label="Bots and groups"
                    className="relative flex flex-col gap-px"
                  >
                    {rosterListItems.map((item) => {
                      if (item.kind === "entry") {
                        const dropVerb = dropVerbFor(rosterListItemId(item));
                        const pinned = pinnedKeys.has(rosterItemKey(item.item));
                        const zoneOrder = rosterItemsForZone(item.zone, {
                          pinnedItems: visiblePinnedItems,
                          sections: visibleSectionLayouts,
                          unassignedItems: visibleUnassignedItems,
                        });
                        const zoneIndex = zoneOrder.findIndex((candidate) =>
                          rosterItemsEqual(candidate, item.item),
                        );
                        const canMoveUp = !searching && zoneIndex > 0;
                        const canMoveDown =
                          !searching && zoneIndex >= 0 && zoneIndex < zoneOrder.length - 1;
                        const onNudge = (delta: -1 | 1) =>
                          useRosterStore.getState().nudgeRosterItem(item.item, delta);
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
                                        onSelect={handleSelect}
                                        pinned={pinned}
                                        sections={sections}
                                        onPin={(nextPinned) =>
                                          useRosterStore
                                            .getState()
                                            .setItemPinned({ kind: "bot", id: bot.id }, nextPinned)
                                        }
                                        onMove={(sectionId) =>
                                          useRosterStore
                                            .getState()
                                            .moveBotToSection(bot.id, sectionId)
                                        }
                                        canMoveUp={canMoveUp}
                                        canMoveDown={canMoveDown}
                                        onNudge={onNudge}
                                        sortable={bag}
                                        dropVerb={dropVerb}
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
                                        onSelect={() => handleSelectGroup(group)}
                                        pinned={pinned}
                                        sections={sections}
                                        onPin={(nextPinned) =>
                                          useRosterStore
                                            .getState()
                                            .setItemPinned(
                                              { kind: "group", id: group.id },
                                              nextPinned,
                                            )
                                        }
                                        onMove={(sectionId) =>
                                          useRosterStore
                                            .getState()
                                            .moveGroupToSection(group.id, sectionId)
                                        }
                                        canMoveUp={canMoveUp}
                                        canMoveDown={canMoveDown}
                                        onNudge={onNudge}
                                        sortable={bag}
                                        dropVerb={dropVerb}
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
                              label="Pinned"
                              visible={dragging}
                              isDropTarget={dragTargetZone === "pinned"}
                            />
                          );
                        case "pinned-divider":
                          return (
                            <RosterDragBoundary
                              key="pinned-divider"
                              marker="pinned-divider"
                              label={sections[0]?.name ?? "Unassigned"}
                              visible={dragging}
                              isDropTarget={dragTargetZone !== null && dragTargetZone !== "pinned"}
                            />
                          );
                        case "unassigned-header":
                          return (
                            <SortableRosterMarker
                              key="unassigned-header"
                              marker="unassigned-header"
                              data-testid="roster-unassigned-header"
                              className="relative"
                            >
                              <div
                                className={cn(
                                  "flex h-8 items-center gap-1.5 px-2 text-xs font-medium text-sidebar-muted-foreground",
                                  dragging && "text-sidebar-foreground/80",
                                  dragTargetZone === "unassigned" && "text-primary",
                                )}
                              >
                                <ChevronDownIcon className="size-3.5" />
                                <span>Unassigned</span>
                                <span className="tabular-nums">
                                  {visibleUnassignedItems.length}
                                </span>
                                <span
                                  aria-hidden
                                  className={cn(
                                    "h-px min-w-2 flex-1",
                                    dragTargetZone === "unassigned"
                                      ? "bg-primary/50"
                                      : "bg-sidebar-border/60",
                                  )}
                                />
                              </div>
                            </SortableRosterMarker>
                          );
                        case "unassigned-placeholder":
                          return (
                            <RosterSectionPlaceholder
                              key="unassigned-placeholder"
                              marker="unassigned-placeholder"
                              label="Unassigned"
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
                        default: {
                          if (typeof item.marker !== "object") return null;
                          const marker = item.marker;
                          if (marker.kind === "section-header") {
                            const section = sections.find(
                              (candidate) => candidate.id === marker.sectionId,
                            );
                            if (!section) return null;
                            const layout = visibleSectionLayouts.find(
                              (candidate) => candidate.id === section.id,
                            );
                            const collapsed = layout?.collapsed ?? section.collapsed;
                            const count = layout?.items.length ?? 0;
                            const zone = { sectionId: section.id };
                            const sectionIndex = sections.findIndex(
                              (candidate) => candidate.id === section.id,
                            );
                            return (
                              <SortableRosterMarker
                                key={rosterMarkerId(item.marker)}
                                marker={item.marker}
                                draggable={!searching}
                                data-testid="roster-section-header"
                                className="relative"
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
                                    className={cn(
                                      "flex min-w-0 flex-1 cursor-grab items-center gap-1.5 px-2 text-left text-xs font-medium text-sidebar-muted-foreground active:cursor-grabbing",
                                      rosterZonesEqual(dragTargetZone ?? "pinned", zone) &&
                                        "text-primary",
                                    )}
                                  >
                                    {collapsed ? (
                                      <ChevronRightIcon className="size-3.5" />
                                    ) : (
                                      <ChevronDownIcon className="size-3.5" />
                                    )}
                                    <span className="truncate">{section.name}</span>
                                    <span className="tabular-nums">{count}</span>
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
                                        disabled={searching || sectionIndex <= 0}
                                        onClick={() =>
                                          useRosterStore
                                            .getState()
                                            .reorderSections(sectionIndex, sectionIndex - 1)
                                        }
                                      >
                                        <ArrowUpIcon />
                                        Move up
                                      </MenuItem>
                                      <MenuItem
                                        disabled={searching || sectionIndex >= sections.length - 1}
                                        onClick={() =>
                                          useRosterStore
                                            .getState()
                                            .reorderSections(sectionIndex, sectionIndex + 1)
                                        }
                                      >
                                        <ArrowDownIcon />
                                        Move down
                                      </MenuItem>
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
                              </SortableRosterMarker>
                            );
                          }
                          const zone = { sectionId: marker.sectionId };
                          const layout = visibleSectionLayouts.find(
                            (candidate) => candidate.id === marker.sectionId,
                          );
                          const activeEntry = dragState && parseRosterEntryId(dragState.activeId);
                          return (
                            <RosterSectionPlaceholder
                              key={rosterMarkerId(item.marker)}
                              marker={item.marker}
                              label={layout?.name ?? "Section"}
                              showHint={
                                dragging &&
                                (layout?.items.length === 0 ||
                                  layout?.collapsed === true ||
                                  (activeEntry !== null &&
                                    dragState?.from !== "section" &&
                                    dragState !== null &&
                                    rosterZonesEqual(dragState.from, zone) &&
                                    !rosterZoneHasVisibleEntries(
                                      rosterListItems,
                                      zone,
                                      activeEntry ?? undefined,
                                    ) &&
                                    dragTargetZone !== null &&
                                    !rosterZonesEqual(dragTargetZone, zone)))
                              }
                              isDropTarget={
                                dragTargetZone !== null && rosterZonesEqual(dragTargetZone, zone)
                              }
                            />
                          );
                        }
                      }
                    })}
                  </ul>
                </SortableContext>
              </DndContext>
              {visibleBots.length === 0 && visibleGroups.length === 0 ? (
                <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
                  No bots match
                </div>
              ) : null}
            </SidebarGroup>
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
