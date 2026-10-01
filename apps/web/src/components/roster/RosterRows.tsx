import { scopeThreadRef } from "@akeru/client-runtime/environment";
import { PLACEHOLDER_THREAD_TITLE, type ScopedThreadRef } from "@akeru/contracts";
import { ArchiveIcon, ArrowDownIcon, ArrowUpIcon, PinIcon, SettingsIcon } from "lucide-react";
import { memo, useMemo, useRef } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { cn } from "../../lib/utils";
import { useLatestGroupThreadId, useThreadMessages } from "../../state/entities";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { SidebarGroup } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BotAvatarView } from "./BotAvatarView";
import { visibleBotChatMessages } from "./botConversationPresentation";
import { useBotPresence } from "./botPresence";
import { useBotRosterUnread, useChatUnread } from "../chat/useChatUnread";
import { GroupMemberStack } from "./GroupMemberStack";
import {
  formatRosterTimestamp,
  resolveLatestRosterMessage,
  resolveRosterIndicator,
  rosterItemKey,
  type RosterItemRef,
  type RosterLastMessage,
  type RosterPresence,
} from "./roster.logic";
import type { Bot, Group } from "./types";
import { useBotChatTarget, useBotThreadCandidate } from "./useBotThreadRef";
import { type SortableRosterRowBag, sortableRootProps } from "./RosterDrag";

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

function useLatestBotMessage(
  botId: string,
  fallback: RosterLastMessage | null,
): {
  message: RosterLastMessage | null;
  taskTitle: string | null;
  threadRef: ScopedThreadRef | null;
} {
  const candidate = useBotThreadCandidate(botId);
  const { ref: threadRef, shell } = useBotChatTarget(botId, candidate);
  const messages = useThreadMessages(threadRef);
  const visibleMessages = useMemo(() => visibleBotChatMessages(messages), [messages]);
  const message = useMemo(
    () => resolveLatestRosterMessage(fallback, visibleMessages, threadRef?.threadId),
    [fallback, visibleMessages, threadRef?.threadId],
  );
  // The chat title reads as the bot's current task; the placeholder title of
  // a brand-new chat says nothing, so the chip stays hidden until a real
  // title lands.
  const shellTitle = shell?.title ?? null;
  const taskTitle = shellTitle === PLACEHOLDER_THREAD_TITLE ? null : shellTitle;
  return useMemo(() => ({ message, taskTitle, threadRef }), [message, taskTitle, threadRef]);
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

/** The group's current chat: its newest chat on the primary environment. */
function useGroupChatRef(groupId: string): ScopedThreadRef | null {
  const environmentId = usePrimaryEnvironmentId();
  const threadId = useLatestGroupThreadId(environmentId, groupId);
  return useMemo(
    () => (environmentId && threadId ? scopeThreadRef(environmentId, threadId) : null),
    [environmentId, threadId],
  );
}

function UnreadDot() {
  const { t } = useI18n();
  return (
    <span
      role="img"
      aria-label={t("Unread")}
      data-testid="roster-unread-dot"
      className="size-2 shrink-0 rounded-full bg-sidebar-foreground"
    />
  );
}

export const BotRosterRow = memo(function BotRosterRow({
  bot,
  lastMessage,
  isActive,
  chatOpen,
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
  /** Only an open chat counts as seen; bot settings still show unread replies. */
  chatOpen: boolean;
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
  const {
    message: latestMessage,
    taskTitle,
    threadRef: chatRef,
  } = useLatestBotMessage(bot.id, lastMessage);
  const unread = useBotRosterUnread(bot.id, chatRef, chatOpen);
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
            <span className="flex max-w-full items-center gap-1">
              {unread ? <UnreadDot /> : null}
              <span className="truncate text-xs font-medium">{bot.name}</span>
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate text-sm font-semibold">{bot.name}</span>
                <span className="min-w-2 flex-1" />
                {unread ? <UnreadDot /> : null}
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
              {latestMessage || taskTitle ? (
                // Messenger preview: the last thing said. A chat with no
                // messages yet shows its title instead.
                <span className="truncate text-sm text-sidebar-muted-foreground">
                  {latestMessage ? latestMessage.text : taskTitle}
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
  chatOpen,
  onSelect,
}: {
  bot: Bot;
  isActive: boolean;
  /** Only an open chat counts as seen; bot settings still show unread replies. */
  chatOpen: boolean;
  onSelect: (bot: Bot) => void;
}) {
  const presence = useBotPresence(bot.id);
  // The collapsed rail marks unread replies like the expanded row does.
  const { ref: chatRef } = useBotChatTarget(bot.id, useBotThreadCandidate(bot.id));
  const unread = useBotRosterUnread(bot.id, chatRef, chatOpen);
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
              "relative flex size-9 cursor-pointer items-center justify-center rounded-lg outline-none select-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive ? "bg-sidebar-row-active" : "bg-transparent hover:bg-sidebar-row-hover",
            )}
          >
            <RosterAvatar
              bot={bot}
              presence={presence}
              className="size-7"
              dotClassName="size-1.5"
            />
            {unread ? (
              <span className="absolute top-0.5 right-0.5 flex">
                <UnreadDot />
              </span>
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="right">{bot.name}</TooltipPopup>
    </Tooltip>
  );
}

/** One group in the icon-collapsed rail, with a name tooltip and its unread dot. */
function RailGroupButton({
  group,
  bots,
  isActive,
  onSelect,
}: {
  group: Group;
  bots: readonly Bot[];
  isActive: boolean;
  onSelect: (group: Group) => void;
}) {
  const unread = useChatUnread(useGroupChatRef(group.id)) && !isActive;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-current={isActive || undefined}
            onClick={() => onSelect(group)}
            className={cn(
              "relative flex size-9 items-center justify-center rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive ? "bg-sidebar-row-active" : "hover:bg-sidebar-row-hover",
            )}
          >
            <GroupMemberStack group={group} bots={bots} sizeClassName="size-5" />
            {unread ? (
              <span className="absolute top-0.5 right-0.5 flex">
                <UnreadDot />
              </span>
            ) : null}
          </button>
        }
      />
      <TooltipPopup side="right">{group.name}</TooltipPopup>
    </Tooltip>
  );
}

export const GroupRosterRow = memo(function GroupRosterRow({
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
  const { t } = useI18n();
  const menuTriggerRef = useRef<HTMLButtonElement>(null);
  const item = useMemo(() => ({ kind: "group" as const, id: group.id }), [group.id]);
  const unread = useChatUnread(useGroupChatRef(group.id)) && !isActive;
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
        {unread ? <UnreadDot /> : null}
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

/** Icon-collapsed roster: group buttons first, then every visible bot. */
export function RosterRail({
  groups,
  bots,
  visibleBots,
  pathname,
  activeBotId,
  onSelectBot,
  onSelectGroup,
}: {
  groups: readonly Group[];
  bots: readonly Bot[];
  visibleBots: readonly Bot[];
  pathname: string;
  /** The selected bot, or null while a group route is open. */
  activeBotId: string | null;
  onSelectBot: (bot: Bot) => void;
  onSelectGroup: (group: Group) => void;
}) {
  return (
    <SidebarGroup className="hidden items-center gap-1 px-0 pt-1 group-data-[collapsible=icon]:flex">
      <ul data-testid="roster-rail" className="flex flex-col items-center gap-1">
        {groups.map((group) => (
          <li key={group.id} className="list-none">
            <RailGroupButton
              group={group}
              bots={bots}
              isActive={pathname === `/groups/${group.id}`}
              onSelect={onSelectGroup}
            />
          </li>
        ))}
        {visibleBots.map((bot) => (
          <li key={bot.id} className="list-none">
            <RailBotButton
              bot={bot}
              isActive={activeBotId === bot.id}
              chatOpen={pathname === `/bots/${bot.id}`}
              onSelect={onSelectBot}
            />
          </li>
        ))}
      </ul>
    </SidebarGroup>
  );
}
