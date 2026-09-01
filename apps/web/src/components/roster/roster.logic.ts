import type { OrchestrationThreadShell } from "@t3tools/contracts";
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

export interface RosterSection {
  id: "pinned" | "unpinned";
  name: "Pinned" | "Bots";
  bots: Bot[];
}

function lastMessageSortValue(
  bot: Bot,
  lastMessageByBotId: Readonly<Record<string, RosterLastMessage>>,
): number | null {
  const at = lastMessageByBotId[bot.id]?.at;
  if (at === undefined) return null;
  return parseTimestampDate(at)?.getTime() ?? null;
}

/** Latest conversation first; bots without messages trail, alphabetized. */
export function compareRosterBots(
  a: Bot,
  b: Bot,
  lastMessageByBotId: Readonly<Record<string, RosterLastMessage>>,
): number {
  const aAt = lastMessageSortValue(a, lastMessageByBotId);
  const bAt = lastMessageSortValue(b, lastMessageByBotId);
  if (aAt !== null && bAt !== null && aAt !== bAt) return bAt - aAt;
  if (aAt !== null && bAt === null) return -1;
  if (aAt === null && bAt !== null) return 1;
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

type RosterSectionsInput = readonly Bot[] | { bots: readonly Bot[] };

function isPreviousRosterSectionsInput(
  input: RosterSectionsInput,
): input is { bots: readonly Bot[] } {
  return !Array.isArray(input);
}

/**
 * Pinned and unpinned bots keep their persisted order within each section.
 * The object form covers a previous caller that can remain mounted during HMR.
 */
export function buildRosterSections(input: RosterSectionsInput): RosterSection[] {
  const bots = isPreviousRosterSectionsInput(input) ? input.bots : input;
  const visibleBots = bots.filter((bot) => bot.archivedAt === null);
  const pinned = visibleBots.filter((bot) => bot.pinned);
  const unpinned = visibleBots.filter((bot) => !bot.pinned);
  return [
    ...(pinned.length > 0 ? [{ id: "pinned", name: "Pinned", bots: pinned } as const] : []),
    ...(unpinned.length > 0 ? [{ id: "unpinned", name: "Bots", bots: unpinned } as const] : []),
  ];
}

export const ROSTER_TILE_LIMIT = 5;

/** Visible bots, pinned first, with persisted order preserved in each partition. */
export function buildRosterStrip(
  bots: readonly Bot[],
  _lastMessageByBotId: Readonly<Record<string, RosterLastMessage>>,
): Bot[] {
  const visible = bots.filter((bot) => bot.archivedAt === null);
  return [...visible.filter((bot) => bot.pinned), ...visible.filter((bot) => !bot.pinned)];
}

/** The expanded roster shows pinned bots in a fixed grid, never a carousel. */
export function buildRosterTiles(
  bots: readonly Bot[],
  _lastMessageByBotId: Readonly<Record<string, RosterLastMessage>>,
): Bot[] {
  return bots.filter((bot) => bot.archivedAt === null && bot.pinned).slice(0, ROSTER_TILE_LIMIT);
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

export interface RosterGroupSection {
  readonly id: string;
  readonly name: string;
  readonly bots: ReadonlyArray<Bot>;
}

/**
 * Assigned groups first, then every bot without a group under Unassigned.
 * A matching group keeps every member so stacked avatars stay visible.
 */
export function buildGroupedRosterSections(
  bots: ReadonlyArray<Bot>,
  groups: ReadonlyArray<Group>,
  query = "",
): ReadonlyArray<RosterGroupSection> {
  const needle = query.trim().toLowerCase();
  const active = bots.filter((bot) => bot.archivedAt === null && bot.pinned === false);
  const assigned = groups.flatMap((group) => {
    const groupBots = active.filter((bot) => bot.groupId === group.id);
    const matchesQuery =
      needle.length === 0 ||
      group.name.toLowerCase().includes(needle) ||
      filterRosterBots(groupBots, query).length > 0;
    return groupBots.length > 0 && matchesQuery
      ? [{ id: group.id, name: group.name, bots: groupBots }]
      : [];
  });
  const unassigned = active.filter((bot) => bot.groupId === null);
  const visibleUnassigned = needle.length === 0 ? unassigned : filterRosterBots(unassigned, query);
  return [
    ...assigned,
    ...(visibleUnassigned.length > 0
      ? [{ id: "unassigned", name: "Unassigned", bots: visibleUnassigned }]
      : []),
  ];
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
