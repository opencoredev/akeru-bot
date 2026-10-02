import { Match } from "effect";
import type { OrchestrationThreadShell } from "@akeru/contracts";
import {
  isGroupBotMember,
  isGroupPersonMember,
  type GroupPersonMembership,
} from "@akeru/contracts";
import { createTranslator } from "@akeru/client-runtime/i18n";
import type { TimestampFormat } from "@akeru/contracts/settings";
import { threadJumpIndexFromCommand } from "../../keybindings";
import { formatShortTimestamp, parseTimestampDate } from "../../timestampFormat";
import type { RosterItemRef } from "./rosterDrop.logic";
import type { RosterLastMessage } from "./rosterMessagePreview.logic";
import type { Bot, Group } from "./types";

export {
  BLOB_SHAPES,
  blobShapeLabel,
  BLOB_COLORS,
  resolveBlobColor,
  resolveBlobEyes,
  resolveBlobOutline,
  isBotAvatarColor,
  resolveBlobRendering,
  randomBotAvatar,
  botAvatarSeed,
} from "./rosterAvatar.logic";

export { type RosterLastMessage, resolveLatestRosterMessage } from "./rosterMessagePreview.logic";

export {
  type RosterItemRef,
  rosterItemKey,
  rosterItemsEqual,
  moveRosterItemInOrder,
  rosterEntryId,
  parseRosterEntryId,
  rosterSectionItems,
  type RosterZone,
  rosterItemsForZone,
  type RosterListMarker,
  rosterMarkerId,
  parseRosterSectionHeaderId,
  type RosterListItem,
  rosterListItemId,
  buildRosterListItems,
  resolveRosterDropTarget,
  type RosterDropPlan,
  planRosterDrop,
} from "./rosterDrop.logic";

type Translate = (message: string, params?: Record<string, string | number>) => string;

const englishTranslate: Translate = createTranslator("en").translate;

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

/**
 * The unpinned zone holds bots and groups, so the heading says what is actually
 * under it rather than calling a group a bot.
 */
export function rosterZoneHeading(items: readonly RosterItemRef[]): string {
  const hasBots = items.some((item) => item.kind === "bot");
  const hasGroups = items.some((item) => item.kind === "group");

  if (hasGroups && hasBots) return "Bots and groups";

  if (hasGroups) return "Groups";

  return "Bots";
}

/** Archived bots, newest archive first, for the roster's restore list. */
export function archivedRosterBots(bots: readonly Bot[]): Bot[] {
  return bots
    .filter((bot) => bot.archivedAt !== null)
    .toSorted((left, right) => (right.archivedAt ?? "").localeCompare(left.archivedAt ?? ""));
}

export const ROSTER_TILE_LIMIT = 5;

export function buildRosterStrip(
  bots: readonly Bot[],
  _lastMessageByBotId: Readonly<Record<string, RosterLastMessage>>,
): Bot[] {
  const visible = bots.filter((bot) => bot.archivedAt === null);

  return [...visible.filter((bot) => bot.pinned), ...visible.filter((bot) => !bot.pinned)];
}

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

type RosterShortcutItem = { kind: "bot" | "group"; id: string };

type RosterShortcutSection = { botIds: readonly string[] };

export function orderRosterBotsForShortcuts(
  bots: readonly Bot[],
  pinnedItems: readonly RosterShortcutItem[],
  sections: readonly RosterShortcutSection[],
): Bot[] {
  const botsById = new Map(
    bots.flatMap((bot) => (bot.archivedAt === null ? [[bot.id, bot] as const] : [])),
  );

  const ordered: Bot[] = [];
  const addedIds = new Set<string>();

  const addBot = (botId: string) => {
    const bot = botsById.get(botId);

    if (!bot || addedIds.has(botId)) return;
    addedIds.add(botId);
    ordered.push(bot);
  };

  for (const item of pinnedItems) {
    if (item.kind === "bot") addBot(item.id);
  }

  for (const section of sections) {
    for (const botId of section.botIds) addBot(botId);
  }

  for (const bot of bots) addBot(bot.id);

  return ordered;
}

export function resolveRosterShortcutBot(command: string, orderedBots: readonly Bot[]): Bot | null {
  const index = threadJumpIndexFromCommand(command);

  return index === null ? null : (orderedBots[index] ?? null);
}

/**
 * The bot `thread.previous` or `thread.next` moves to, in shortcut order and
 * wrapping at the ends. With no bot open (a group chat, say), previous starts
 * from the last bot and next from the first.
 */
export function resolveAdjacentRosterBot(
  command: string,
  orderedBots: readonly Bot[],
  selectedBotId: string | null,
): Bot | null {
  const step = Match.value(command).pipe(
    Match.when("thread.previous", () => -1),
    Match.when("thread.next", () => 1),
    Match.orElse(() => 0),
  );

  if (step === 0 || orderedBots.length === 0) return null;
  const index = orderedBots.findIndex((bot) => bot.id === selectedBotId);

  if (index === -1) return (step === 1 ? orderedBots[0] : orderedBots.at(-1)) ?? null;
  const next = orderedBots[(index + step + orderedBots.length) % orderedBots.length] ?? null;

  return next?.id === selectedBotId ? null : next;
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

export interface RosterGroupSection {
  readonly id: string;
  readonly name: string;
  readonly group?: Group | null;
  readonly bots: ReadonlyArray<Bot>;
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

type FormatDate = (value: Date, options: Intl.DateTimeFormatOptions) => string;

const browserFormatDate: FormatDate = (value, options) =>
  new Intl.DateTimeFormat(undefined, options).format(value);

/**
 * Compact roster timestamp, iMessage-style: today shows the clock time,
 * yesterday "Yesterday", the rest of the past week its weekday, older dates
 * the numeric date (with the year once the calendar year differs).
 */
export function formatRosterTimestamp(
  isoDate: string,
  timestampFormat: TimestampFormat,
  nowMs: number = Date.now(),
  t: Translate = englishTranslate,
  formatDate: FormatDate = browserFormatDate,
): string {
  const date = parseTimestampDate(isoDate);

  if (!date) return "";

  const now = new Date(nowMs);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const startOfMessageDay = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfMessageDay) / 86_400_000);

  if (dayDiff <= 0) return formatShortTimestamp(isoDate, timestampFormat);

  if (dayDiff === 1) return t("Yesterday");

  if (dayDiff < 7) return formatDate(date, { weekday: "short" });

  return date.getFullYear() === now.getFullYear()
    ? formatDate(date, { month: "numeric", day: "numeric" })
    : formatDate(date, { month: "numeric", day: "numeric", year: "numeric" });
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
