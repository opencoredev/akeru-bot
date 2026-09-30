import {
  DndContext,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToFirstScrollableAncestor } from "@dnd-kit/modifiers";
import { SortableContext, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useAtomValue } from "@effect/atom-react";
import { PencilEdit02Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { BotId, GroupId, PLACEHOLDER_THREAD_TITLE } from "@t3tools/contracts";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronDownIcon,
  PinIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
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
import { useI18n } from "../../i18n";
import { resolveShortcutCommand } from "../../keybindings";
import { isPreviewFocused } from "../../lib/previewFocus";
import { cn, randomUUID } from "../../lib/utils";
import { isModelPickerOpen } from "../../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { botEnvironment } from "../../state/bots";
import { useThreadMessages } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SidebarChromeFooter, SidebarStatusStack } from "../sidebar/SidebarChrome";
import { AkeruWordmark } from "../AkeruWordmark";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { AppIcon } from "../ui/app-icon";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarContent, SidebarGroup, SidebarHeader, SidebarTrigger } from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { DEFAULT_BOT_RUNTIME_MODE } from "./botSandbox";
import { visibleBotChatMessages } from "./botConversationPresentation";
import { useBotPresence } from "./botPresence";
import { NewBotDialog } from "./NewBotDialog";
import { NewGroupDialog, type NewGroupInput } from "./NewGroupDialog";
import { GroupMemberStack } from "./GroupMemberStack";
import {
  archivedRosterBots,
  buildRosterListItems,
  filterRosterBots,
  filterRosterGroups,
  formatRosterTimestamp,
  isRecordableChatPath,
  planRosterDrop,
  resolveLatestRosterMessage,
  resolveRosterDropTarget,
  resolveRosterIndicator,
  rosterItemKey,
  rosterItemsEqual,
  rosterItemsForZone,
  rosterListItemId,
  rosterMarkerId,
  rosterZoneHeading,
  orderRosterBotsForShortcuts,
  resolveRosterShortcutBot,
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
  restrictRosterDragAxis,
} from "./roster.drag";
import { createRosterListMotion } from "./roster.motion";
import { RosterDragLifecycle, RosterPointerSensor } from "./roster.pointer";
import { useRosterStore } from "./rosterStore";
import type { Bot, BotAvatar, Group } from "./types";
import { useBotChatTarget, useBotThreadCandidate, useBotThreadRef } from "./useBotThreadRef";

/** Avatar with a warning needs-you light and an accent working light. */
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
            indicator === "working" ? "bg-primary" : "bg-warning",
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
  const { t } = useI18n();
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
          <AkeruWordmark />
        </Link>
        <div className="flex items-center justify-end">
          <Menu>
            <MenuTrigger
              render={
                <Button
                  aria-label={t("Create")}
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
                {t("New bot")}
              </MenuItem>
              <MenuItem onClick={onNewGroup}>
                <UsersIcon />
                {t("New group")}
              </MenuItem>
            </MenuPopup>
          </Menu>
        </div>
      </div>
    </SidebarHeader>
  );
});

/**
 * Header for the roster when it sits inside the experimental rail layout:
 * the wordmark as the panel title, with search and create beside it.
 */
function RosterPanelHeader({
  onNewBot,
  onNewGroup,
  onSearch,
}: {
  onNewBot: () => void;
  onNewGroup: () => void;
  onSearch: () => void;
}) {
  const iconButton =
    "size-8! rounded-lg text-sidebar-muted-foreground hover:text-sidebar-foreground [-webkit-app-region:no-drag]";
  return (
    <SidebarHeader
      className={cn(
        "h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-1 py-0 pl-4 pr-2.5",
        isElectron && "drag-region",
      )}
    >
      <Link
        to="/"
        className="min-w-0 flex-1 rounded-md text-sidebar-foreground outline-none ring-ring focus-visible:ring-2 [-webkit-app-region:no-drag]"
      >
        <AkeruWordmark className="text-[26px]" />
      </Link>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Search"
              className={iconButton}
              size="icon"
              variant="ghost"
              onClick={onSearch}
            >
              <AppIcon icon={Search01Icon} className="size-[18px]" />
            </Button>
          }
        />
        <TooltipPopup>Search</TooltipPopup>
      </Tooltip>
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label="Create"
              data-testid="roster-new-bot"
              className={iconButton}
              size="icon"
              variant="ghost"
            >
              <AppIcon icon={PencilEdit02Icon} className="size-[18px]" />
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
    </SidebarHeader>
  );
}

function useLatestBotMessage(
  botId: string,
  fallback: RosterLastMessage | null,
): { message: RosterLastMessage | null; taskTitle: string | null } {
  const candidate = useBotThreadCandidate(botId);
  const { ref: threadRef, shell } = useBotChatTarget(botId, candidate);
  const messages = useThreadMessages(threadRef);
  const visibleMessages = useMemo(() => visibleBotChatMessages(messages), [messages]);
  const message = useMemo(
    () => resolveLatestRosterMessage(fallback, visibleMessages),
    [fallback, visibleMessages],
  );
  // The chat title reads as the bot's current task; the placeholder title of
  // a brand-new chat says nothing, so the chip stays hidden until a real
  // title lands.
  const shellTitle = shell?.title ?? null;
  const taskTitle = shellTitle === PLACEHOLDER_THREAD_TITLE ? null : shellTitle;
  return useMemo(() => ({ message, taskTitle }), [message, taskTitle]);
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

const ROSTER_DRAG_LABEL_HEIGHT = 24;

/** Stable row actions, so memoized rows skip re-rendering when the sidebar does. */
const setRosterItemPinned = (item: RosterItemRef, pinned: boolean) =>
  useRosterStore.getState().setItemPinned(item, pinned);
const nudgeRosterItem = (item: RosterItemRef, delta: -1 | 1) =>
  useRosterStore.getState().nudgeRosterItem(item, delta);

function commandFailureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The environment rejected the change.";
}

/**
 * The roster row focus lands on once an archived one is gone: the row that takes
 * its place, else the row above it, else nothing — meaning the roster list
 * itself, because the row focus would have returned to is on its way out.
 * Keys are `rosterItemKey` values, so a surviving group can take the focus too.
 */
export function focusTargetAfterRosterArchive(
  rowKeys: readonly string[],
  archivedKey: string,
): string | null {
  const index = rowKeys.indexOf(archivedKey);
  if (index === -1) return rowKeys[0] ?? null;
  return rowKeys[index + 1] ?? rowKeys[index - 1] ?? null;
}

/**
 * Runs one create-bot submission at a time. `NewBotDialog` stays mounted while
 * the command is awaited, so a second submit would dispatch a second create and
 * leave the pending-selection id on whichever request happened to settle last.
 * The latch is a ref rather than state because both submits land before React
 * has re-rendered the dialog with `submitting`.
 */
export async function runCreateBotOnce(
  inFlight: { current: boolean },
  create: () => Promise<void>,
): Promise<void> {
  if (inFlight.current) return;
  inFlight.current = true;
  try {
    await create();
  } finally {
    inFlight.current = false;
  }
}

const rosterFullTimestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** Unabbreviated date for the roster row's compact timestamp tooltip. */
function formatRosterFullTimestamp(isoDate: string): string {
  const parsed = new Date(isoDate);
  return Number.isNaN(parsed.getTime()) ? "" : rosterFullTimestampFormatter.format(parsed);
}

const BotRosterRow = memo(function BotRosterRow({
  bot,
  lastMessage,
  isActive,
  onSelect,
  onOpenSettings,
  pinned,
  onPin,
  canMoveUp,
  canMoveDown,
  onNudge,
  onArchive,
  sortable,
}: {
  bot: Bot;
  lastMessage: RosterLastMessage | null;
  isActive: boolean;
  onSelect: (bot: Bot) => void;
  onOpenSettings: (bot: Bot) => void;
  pinned: boolean;
  onPin: (item: RosterItemRef, pinned: boolean) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onNudge: (item: RosterItemRef, delta: -1 | 1) => void;
  onArchive: (bot: Bot) => void;
  sortable: SortableRosterRowBag;
}) {
  const { t, formatDate } = useI18n();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const item = useMemo(() => ({ kind: "bot" as const, id: bot.id }), [bot.id]);
  const timestampFormat = useClientSettings((s) => s.timestampFormat);
  const presence = useBotPresence(bot.id);
  const { message: latestMessage, taskTitle } = useLatestBotMessage(bot.id, lastMessage);
  return (
    <li
      role="listitem"
      data-roster-item
      data-pinned={pinned || undefined}
      className={cn(
        "list-none touch-pan-y",
        pinned ? "my-2 w-18 flex-none" : "w-full flex-none",
        sortable.isDragging && "z-50",
      )}
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
          "relative flex w-full items-center outline-none select-none",
          pinned ? "rounded-xl" : "rounded-lg",
          sortable.isDragging
            ? "bg-[linear-gradient(var(--sidebar-row-active),var(--sidebar-row-active)),linear-gradient(var(--sidebar),var(--sidebar))] text-sidebar-foreground shadow-lg"
            : isActive
              ? "bg-sidebar-row-active text-sidebar-foreground"
              : pinned
                ? "bg-sidebar-row-hover/50 text-sidebar-foreground hover:bg-sidebar-row-hover"
                : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        )}
      >
        <button
          type="button"
          data-roster-row={rosterItemKey({ kind: "bot", id: bot.id })}
          aria-current={isActive || undefined}
          onClick={() => onSelect(bot)}
          className={cn(
            "flex min-w-0 flex-1 cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
            pinned
              ? "min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-center"
              : "items-center gap-2.5 rounded-lg px-2 py-1.5 text-left",
          )}
        >
          <RosterAvatar bot={bot} presence={presence} className={pinned ? "size-12" : "size-10"} />
          {pinned ? (
            <span className="max-w-full truncate text-xs font-medium">{bot.name}</span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 shrink truncate text-sm font-semibold">{bot.name}</span>
                {taskTitle ? (
                  <span className="min-w-0 shrink-[2] truncate rounded-md border border-sidebar-foreground/10 bg-sidebar-foreground/6 px-1.5 py-px text-[11px] text-sidebar-muted-foreground">
                    {taskTitle}
                  </span>
                ) : null}
                <span className="min-w-2 flex-1" />
                {latestMessage ? (
                  // The compact label collapses to a bare numeric date once a
                  // chat is over a week old ("1/15"), which reads like a count
                  // rather than a date. Keep the compact form — the roster has
                  // no room for more — and let the machine-readable datetime
                  // plus hover text say what it actually is.
                  <time
                    dateTime={latestMessage.at}
                    aria-label={t("Last message {time}", {
                      time: formatRosterFullTimestamp(latestMessage.at),
                    })}
                    className="shrink-0 text-xs tabular-nums text-sidebar-muted-foreground"
                  >
                    {formatRosterTimestamp(
                      latestMessage.at,
                      timestampFormat,
                      Date.now(),
                      t,
                      formatDate,
                    )}
                  </time>
                ) : null}
              </span>
              {latestMessage ? (
                <span className="truncate text-sm text-sidebar-muted-foreground">
                  {latestMessage.text}
                </span>
              ) : null}
            </span>
          )}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                ref={menuTriggerRef}
                type="button"
                aria-label={t("Actions for {name}", { name: bot.name })}
                className="absolute right-2 top-1/2 size-px -translate-y-1/2 overflow-hidden opacity-0 outline-none focus-visible:size-7 focus-visible:overflow-visible focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
              />
            }
          />
          <MenuPopup align="end">
            <MenuItem onClick={() => onOpenSettings(bot)}>
              <SettingsIcon />
              {t("Bot settings")}
            </MenuItem>
            <MenuItem onClick={() => onPin(item, !pinned)}>
              <PinIcon />
              {pinned ? t("Unpin") : t("Pin")}
            </MenuItem>
            <MenuItem disabled={!canMoveUp} onClick={() => onNudge(item, -1)}>
              <ArrowUpIcon />
              {t("Move up")}
            </MenuItem>
            <MenuItem disabled={!canMoveDown} onClick={() => onNudge(item, 1)}>
              <ArrowDownIcon />
              {t("Move down")}
            </MenuItem>
            <MenuItem variant="destructive" onClick={() => onArchive(bot)}>
              <ArchiveIcon />
              {t("Archive bot")}
            </MenuItem>
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

const GroupRosterRow = memo(function GroupRosterRow({
  group,
  bots,
  isActive,
  onSelect,
  pinned,
  onPin,
  canMoveUp,
  canMoveDown,
  onNudge,
  sortable,
}: {
  group: Group;
  bots: readonly Bot[];
  isActive: boolean;
  onSelect: (group: Group) => void;
  pinned: boolean;
  onPin: (item: RosterItemRef, pinned: boolean) => void;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onNudge: (item: RosterItemRef, delta: -1 | 1) => void;
  sortable: SortableRosterRowBag;
}) {
  const { t, plural } = useI18n();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const item = useMemo(() => ({ kind: "group" as const, id: group.id }), [group.id]);
  const members = group.members.filter(
    (member) =>
      member.kind === "bot" && bots.some((bot) => bot.id === member.botId && !bot.archivedAt),
  ).length;
  return (
    <li
      role="listitem"
      data-roster-item
      data-testid="roster-group-card"
      data-pinned={pinned || undefined}
      onContextMenu={(event) => {
        event.preventDefault();
        menuTriggerRef.current?.click();
      }}
      className={cn(
        "relative flex touch-pan-y items-center",
        pinned ? "my-2 w-18 flex-none rounded-xl" : "w-full flex-none rounded-lg",
        sortable.isDragging && "z-50 bg-sidebar shadow-xl",
        isActive
          ? "bg-sidebar-row-active"
          : pinned && "bg-sidebar-row-hover/50 hover:bg-sidebar-row-hover",
      )}
      {...sortableRootProps(sortable)}
    >
      <button
        type="button"
        data-roster-row={rosterItemKey({ kind: "group", id: group.id })}
        aria-current={isActive || undefined}
        onClick={() => onSelect(group)}
        className={cn(
          "flex min-w-0 flex-1 cursor-grab outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing",
          pinned
            ? "min-h-20 flex-col items-center justify-center gap-1.5 rounded-xl px-2 py-2 text-center"
            : "items-center gap-2.5 rounded-lg px-2 py-1.5 text-left hover:bg-sidebar-row-hover",
        )}
      >
        <GroupMemberStack
          group={group}
          bots={bots}
          sizeClassName={pinned ? "size-12" : "size-10"}
        />
        <span
          className={cn(
            "min-w-0 max-w-full truncate",
            pinned ? "text-xs font-medium" : "flex-1 text-sm font-semibold",
          )}
        >
          {group.name}
        </span>
      </button>
      <Menu>
        <MenuTrigger
          render={
            <button
              ref={menuTriggerRef}
              type="button"
              aria-label={t("Actions for {name}", { name: group.name })}
              className="absolute right-2 top-1/2 size-px -translate-y-1/2 overflow-hidden opacity-0 outline-none focus-visible:size-7 focus-visible:overflow-visible focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        />
        <MenuPopup align="end">
          <MenuItem onClick={() => onPin(item, !pinned)}>
            <PinIcon />
            {pinned ? t("Unpin") : t("Pin")}
          </MenuItem>
          <MenuItem disabled={!canMoveUp} onClick={() => onNudge(item, -1)}>
            <ArrowUpIcon />
            {t("Move up")}
          </MenuItem>
          <MenuItem disabled={!canMoveDown} onClick={() => onNudge(item, 1)}>
            <ArrowDownIcon />
            {t("Move down")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </li>
  );
});

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
  label: string | null;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableRosterMarker
      marker={props.marker}
      data-testid={`roster-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0 w-full flex-none"
    >
      {props.visible ? (
        <div
          aria-hidden={props.label === null ? true : undefined}
          className={cn(
            "roster-drag-boundary-label absolute inset-x-2 top-1 h-4",
            props.label !== null && "flex items-center gap-2",
          )}
        >
          {props.label !== null ? (
            <>
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
            </>
          ) : null}
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
      className="relative mx-0.5 -mb-px h-0 w-full flex-none"
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
  const restoreBotCommand = useAtomCommand(botEnvironment.restore, { reportFailure: false });
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
  const archivedBots = useMemo(() => archivedRosterBots(bots), [bots]);
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
  const zoneByEntryId = useMemo(() => {
    const map = new Map<string, RosterZone>();
    for (const item of rosterListItems) {
      if (item.kind === "entry") map.set(rosterListItemId(item), item.zone);
    }
    return map;
  }, [rosterListItems]);
  const [dragState, setDragState] = useState<{
    readonly activeId: string;
    readonly from: RosterZone;
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
  const restrictRosterAxis = useCallback(
    (args: Parameters<typeof restrictRosterDragAxis>[0]) =>
      restrictRosterDragAxis(args, zoneByEntryId.get(String(args.active?.id)) ?? null),
    [zoneByEntryId],
  );
  const handleRosterDragStart = useCallback(
    (event: DragStartEvent) => {
      const activeId = String(event.active.id);
      const from = zoneByEntryId.get(activeId);
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
        targetZone: from,
        activationY:
          event.activatorEvent instanceof PointerEvent ? event.activatorEvent.clientY : null,
      });
    },
    [zoneByEntryId],
  );
  const handleRosterDragOver = useCallback(
    (event: DragOverEvent) => {
      const activeId = String(event.active.id);
      const target = event.over
        ? resolveRosterDropTarget(rosterListItems, activeId, String(event.over.id), null)
        : null;
      setDragState((current) =>
        current === null || current.activeId !== activeId
          ? current
          : { ...current, targetZone: target?.zone ?? null },
      );
    },
    [rosterListItems],
  );
  const handleRosterDragEnd = useCallback(
    (event: DragEndEvent) => {
      const activeId = String(event.active.id);
      const overId = event.over ? String(event.over.id) : null;
      if (overId === null) return;
      const from = zoneByEntryId.get(activeId);
      const target = resolveRosterDropTarget(rosterListItems, activeId, overId, null);
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
    [rosterListItems, visiblePinnedItems, zoneByEntryId],
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
        boundaryLabelHeight: ROSTER_DRAG_LABEL_HEIGHT,
      }),
    [rosterListItems],
  );
  const dndCollisionDetection = useMemo(
    () =>
      createRosterCollisionDetection(
        (id) => {
          if (dragState === null) return true;
          return resolveRosterDropTarget(rosterListItems, dragState.activeId, id, null) !== null;
        },
        {
          items: rosterListItems,
          activationY: dragState?.activationY ?? null,
        },
      ),
    [dragState, rosterListItems],
  );
  const dragTargetZone = dragState?.targetZone ?? null;
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
  }, [keybindings, navigate, previewOpen, shortcutBots]);

  const [newBotOpen, setNewBotOpen] = useState(false);
  const [newGroupOpen, setNewGroupOpen] = useState(false);
  const [archivingBot, setArchivingBot] = useState<Bot | null>(null);
  const [archivedOpen, setArchivedOpen] = useState(false);
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
        description: commandFailureMessage(result),
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

  const handleRestoreBot = async (bot: Bot) => {
    if (environmentId === null) {
      toastManager.add({ type: "error", title: t("Connect an environment first") });
      return;
    }
    const result = await restoreBotCommand({
      environmentId,
      input: { botId: BotId.make(bot.id) },
    });
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: t("Could not restore {name}", { name: bot.name }),
        description: commandFailureMessage(result),
      });
    }
  };

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
        className="gap-0 [overflow-anchor:none]"
        fixedHeader={
          chrome === "panel" && !searchOpen && query.length === 0 ? null : (
            <SidebarGroup className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden">
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
        {bots.every((bot) => bot.archivedAt !== null) ? (
          <div className="px-2 py-6 text-center text-sm text-sidebar-muted-foreground">
            {t("No bots yet")}
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
                  restrictRosterAxis,
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
        {archivedBots.length > 0 ? (
          <SidebarGroup
            data-testid="roster-archived"
            className="px-[var(--sidebar-content-inset)] pb-1 pt-1 group-data-[collapsible=icon]:hidden"
          >
            <button
              type="button"
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}
              className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs font-medium text-sidebar-muted-foreground outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <ChevronDownIcon
                className={cn("size-3.5 transition-transform", !archivedOpen && "-rotate-90")}
              />
              <span>{t("Archived")}</span>
              <span
                className="tabular-nums"
                aria-label={t("{count} archived", { count: archivedBots.length })}
              >
                {archivedBots.length}
              </span>
            </button>
            {archivedOpen ? (
              <ul role="list" aria-label={t("Archived bots")} className="flex flex-col gap-px">
                {archivedBots.map((bot) => (
                  <li
                    key={bot.id}
                    className="flex list-none items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-sidebar-row-hover"
                  >
                    <BotAvatarView
                      avatar={bot.avatar}
                      name={bot.name}
                      className="size-8 opacity-60"
                    />
                    <span className="min-w-0 flex-1 truncate text-sm text-sidebar-muted-foreground">
                      {bot.name}
                    </span>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            aria-label={t("Restore {name}", { name: bot.name })}
                            onClick={() => void handleRestoreBot(bot)}
                            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            <ArchiveRestoreIcon className="size-4" />
                          </button>
                        }
                      />
                      <TooltipPopup side="top">{t("Restore")}</TooltipPopup>
                    </Tooltip>
                  </li>
                ))}
              </ul>
            ) : null}
          </SidebarGroup>
        ) : null}
      </SidebarContent>
      {/* Rail create menu sits above the footer, like the expanded header's plus. */}
      <div className="hidden shrink-0 flex-col items-center pb-1 group-data-[collapsible=icon]:flex">
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={t("Create")}
                className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground outline-none select-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <PlusIcon className="size-4" />
              </button>
            }
          />
          <MenuPopup align="end" side="right">
            <MenuItem onClick={handleNewBot}>
              <BotIcon />
              {t("New bot")}
            </MenuItem>
            <MenuItem onClick={handleNewGroup}>
              <UsersIcon />
              {t("New group")}
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
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
