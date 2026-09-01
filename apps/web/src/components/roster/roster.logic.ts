import type { OrchestrationThreadShell } from "@t3tools/contracts";
import {
  isGroupBotMember,
  isGroupPersonMember,
  type GroupPersonMembership,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { formatShortTimestamp, parseTimestampDate } from "../../timestampFormat";
import type { Bot, BotAvatar, BotBlobShape, Group } from "./types";

export const BLOB_SHAPES: readonly BotBlobShape[] = [
  "circle",
  "squircle",
  "square",
  "pill",
  "triangle",
  "hex",
  "cloud",
  "drop",
];

export const BLOB_COLORS: readonly string[] = [
  "#FFFFFF",
  "#E0645C",
  "#E8883A",
  "#D9A833",
  "#5BA97B",
  "#4E9BB8",
  "#5B7FD4",
  "#8B6FC9",
  "#C96FA8",
  "#7A8699",
];

export const DEFAULT_BLOB_SHAPE: BotBlobShape = "circle";
export const DEFAULT_BLOB_COLOR = "#7A8699";

export function isBotBlobShape(value: string): value is BotBlobShape {
  return (BLOB_SHAPES as readonly string[]).includes(value);
}

/**
 * Every avatar kind resolves to a paintable blob so the roster never renders
 * an empty slot: dither and image avatars (and any unknown blob shape coming
 * from persisted or server data) fall back to the default circle blob until
 * their real renderer applies.
 */
export function resolveBlobRendering(avatar: BotAvatar | null | undefined): {
  shape: BotBlobShape;
  color: string;
} {
  if (avatar?.kind !== "blob") {
    return { shape: DEFAULT_BLOB_SHAPE, color: DEFAULT_BLOB_COLOR };
  }
  // Unknown names (including the retired creature set) fall back to the
  // default circle rather than an empty slot.
  return {
    shape: isBotBlobShape(avatar.shape) ? avatar.shape : DEFAULT_BLOB_SHAPE,
    color: avatar.color || DEFAULT_BLOB_COLOR,
  };
}

/**
 * Random blob avatar for a freshly created bot. White is excluded so an
 * auto-assigned body never washes out on the light sidebar; it stays
 * pickable in the avatar picker. `random` is injectable for tests.
 */
export function randomBotAvatar(
  random: () => number = Math.random,
): Extract<BotAvatar, { kind: "blob" }> {
  const colors = BLOB_COLORS.filter((color) => color !== "#FFFFFF");
  const shape = BLOB_SHAPES[Math.floor(random() * BLOB_SHAPES.length)] ?? DEFAULT_BLOB_SHAPE;
  const color = colors[Math.floor(random() * colors.length)] ?? DEFAULT_BLOB_COLOR;
  return { kind: "blob", shape, color };
}

/** What a bot is up to right now, driving the avatar animation and indicator. */
export type RosterPresence = "idle" | "working" | "needs-you";

/** Only live bot states get a light; row selection already marks the active bot. */
export function resolveRosterIndicator(presence: RosterPresence): "needs-you" | "working" | null {
  if (presence === "working") return "working";
  if (presence === "needs-you") return "needs-you";
  return null;
}

type PresenceShell = Pick<
  OrchestrationThreadShell,
  "session" | "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness"
>;

/**
 * Presence for the thread a bot's chat points at. Pending approvals or user
 * input outrank a running turn: the bot is waiting on you, not working. The
 * running test mirrors the legacy sidebar's working indicator; background
 * liveness keeps the bot working while subagents or workflows run on after
 * the turn settles.
 */
export function resolveBotPresence(shell: PresenceShell | null): RosterPresence {
  if (shell === null) return "idle";
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return "needs-you";
  if (shell.session?.status === "running" && shell.session.activeTurnId != null) return "working";
  if (shell.backgroundLiveness === "working") return "working";
  return "idle";
}

/**
 * Phase offset for the idle blink, so a roster full of bots never blinks in
 * sync. Negative so the animation starts mid-cycle. The modulo must match the
 * `bot-blink` duration in index.css.
 */
export function blinkDelayMs(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return -(Math.abs(hash) % 6400);
}

export function resolveRosterBotId(
  selectedBotId: string | null,
  bots: ReadonlyArray<Pick<Bot, "id" | "archivedAt">>,
): string | null {
  if (
    selectedBotId !== null &&
    bots.some((bot) => bot.id === selectedBotId && bot.archivedAt === null)
  ) {
    return selectedBotId;
  }
  return bots.find((bot) => bot.archivedAt === null)?.id ?? null;
}

export interface RosterLastMessage {
  text: string;
  at: string;
}

export function resolveLatestRosterMessage(
  fallback: RosterLastMessage | null,
  messages: ReadonlyArray<{
    role: "user" | "assistant" | "system";
    text: string;
    createdAt: string;
  }>,
): RosterLastMessage | null {
  let latest: RosterLastMessage | null = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message && message.role !== "system" && message.text.trim().length > 0) {
      latest = { text: message.text, at: message.createdAt };
      break;
    }
  }
  if (!latest) return fallback;
  if (!fallback) return latest;
  return latest.at >= fallback.at ? latest : fallback;
}

export function filterRosterBots(bots: readonly Bot[], query: string): Bot[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...bots];
  return bots.filter(
    (bot) =>
      bot.name.toLowerCase().includes(needle) ||
      (bot.label?.toLowerCase().includes(needle) ?? false) ||
      (bot.description?.toLowerCase().includes(needle) ?? false),
  );
}

export function filterRosterGroups(
  groups: readonly Group[],
  bots: readonly Bot[],
  query: string,
): Group[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [...groups];
  return groups.filter(
    (group) =>
      group.name.toLowerCase().includes(needle) ||
      groupBotMembers(group, bots).some((bot) => bot.name.toLowerCase().includes(needle)),
  );
}

const BOT_DRAG_PREFIX = "bot:";
const GROUP_DROP_PREFIX = "group:";

export function rosterBotDragId(botId: string): string {
  return `${BOT_DRAG_PREFIX}${botId}`;
}

export function rosterGroupDropId(groupId: string): string {
  return `${GROUP_DROP_PREFIX}${groupId}`;
}

export function parseRosterBotDragId(id: string): string | null {
  return id.startsWith(BOT_DRAG_PREFIX) ? id.slice(BOT_DRAG_PREFIX.length) || null : null;
}

export function parseRosterGroupDropId(id: string): string | null {
  return id.startsWith(GROUP_DROP_PREFIX) ? id.slice(GROUP_DROP_PREFIX.length) || null : null;
}

export function isCurrentGroupPerson(
  authorPersonId: string | null | undefined,
  currentPersonId: string | null | undefined,
  hostPersonId: string | null | undefined,
): boolean {
  const resolvedAuthorPersonId = authorPersonId ?? hostPersonId;
  return resolvedAuthorPersonId != null && resolvedAuthorPersonId === currentPersonId;
}

export function groupContainsBot(group: Group, botId: string): boolean {
  return group.members.some((member) => isGroupBotMember(member) && member.botId === botId);
}

export function groupBotMembers(group: Group, bots: ReadonlyArray<Bot>): ReadonlyArray<Bot> {
  const memberIds = new Set<string>(
    group.members.filter(isGroupBotMember).map((member) => member.botId),
  );
  return bots.filter((bot) => memberIds.has(bot.id));
}

export function groupPersonMembers(group: Group): ReadonlyArray<GroupPersonMembership> {
  return group.members.filter(isGroupPersonMember);
}

const weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: "short" });
const numericDateFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
});
const numericDateWithYearFormatter = new Intl.DateTimeFormat(undefined, {
  month: "numeric",
  day: "numeric",
  year: "numeric",
});

/**
 * Compact roster timestamp, iMessage-style: today shows the clock time,
 * yesterday "Yesterday", the rest of the past week its weekday, older dates
 * the numeric date (with the year once the calendar year differs).
 */
export function formatRosterTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
): string {
  const date = parseTimestampDate(isoDate);
  if (!date) return "";

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return formatShortTimestamp(isoDate, timestampFormat);
  if (dayDiff === 1) return "Yesterday";
  if (dayDiff < 7) return weekdayFormatter.format(date);
  return date.getFullYear() === now.getFullYear()
    ? numericDateFormatter.format(date)
    : numericDateWithYearFormatter.format(date);
}

// Route prefixes that also produce one- or two-segment paths but are never a
// chat. Everything else with two segments is /$environmentId/$threadId.
const NON_CHAT_ROUTE_PREFIXES = new Set([
  "settings",
  "projects",
  "bots",
  "connect",
  "draft",
  "pair",
  "usage",
]);

export type RosterChatTarget = {
  kind: "thread";
  environmentId: string;
  threadId: string;
};

/**
 * Parses the legacy /$environmentId/$threadId path cached for a bot.
 * The bot page stays canonical and uses this only to recover thread identity.
 */
export function parseChatPath(pathname: string): RosterChatTarget | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  if (NON_CHAT_ROUTE_PREFIXES.has(segments[0]!)) return null;
  return { kind: "thread", environmentId: segments[0]!, threadId: segments[1]! };
}

/** True when a pathname is a chat route worth remembering for a bot. */
export function isRecordableChatPath(pathname: string): boolean {
  return parseChatPath(pathname) !== null;
}
