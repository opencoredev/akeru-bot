import { channelProviderLabel as sharedChannelProviderLabel } from "@t3tools/client-runtime/channel-presentation";
import { formatDate } from "@t3tools/client-runtime/i18n";
import type { OrchestrationMessage } from "@t3tools/contracts";
import type { RosterPresence } from "./roster.logic";

export const channelProviderLabel = sharedChannelProviderLabel;

/**
 * One measure for the transcript, the composer, and everything docked between them.
 * Centering a capped column keeps the reading width steady when the right panel opens,
 * so a message does not reflow just because a side surface appeared.
 */
export const CONVERSATION_MEASURE_CLASS_NAME = "mx-auto w-full max-w-[46rem]";

export function isBotConversationWorking(input: {
  sending: boolean;
  respondingToUserInput: boolean;
  presence: RosterPresence;
  /** The provider turn is still open, even when presence has not caught up yet. */
  turnRunning?: boolean;
  /** A question is on screen; the bot is waiting on the person, not working. */
  waitingForUserInput?: boolean;
}): boolean {
  if (input.waitingForUserInput && !input.respondingToUserInput) return false;
  return (
    input.sending ||
    input.respondingToUserInput ||
    input.presence === "working" ||
    (input.turnRunning ?? false)
  );
}

const SESSION_GAP_MS = 4 * 60 * 60 * 1000;
const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function clockLabel(date: Date): string {
  const hours = date.getHours();
  const suffix = hours < 12 ? "AM" : "PM";
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(date.getMinutes()).padStart(2, "0")} ${suffix}`;
}

const SEPARATOR_DAY_OPTIONS: Intl.DateTimeFormatOptions = {
  weekday: "short",
  month: "short",
  day: "numeric",
};
const SEPARATOR_TIME_OPTIONS: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };

function isEnglish(locale: string): boolean {
  return locale === "en" || locale.startsWith("en-");
}

function isSameDay(left: Date, right: Date): boolean {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  );
}

/**
 * Label for the separator above a message, or null when it continues the same sitting.
 * A separator appears for the first message, when the day changes, and after a long
 * enough gap that the next message reads as a new session. Callers pass the translated
 * `todayLabel` and the interface locale; English keeps its fixed "Sun, Aug 16 1:54 PM"
 * form and other locales use their own date and time order.
 */
export function conversationSeparatorLabel(
  createdAt: string,
  previousCreatedAt: string | null,
  now: Date = new Date(),
  todayLabel = "Today",
  locale = "en",
): string | null {
  const current = new Date(createdAt);
  if (Number.isNaN(current.getTime())) return null;

  if (previousCreatedAt !== null) {
    const previous = new Date(previousCreatedAt);
    const settled =
      !Number.isNaN(previous.getTime()) &&
      isSameDay(previous, current) &&
      current.getTime() - previous.getTime() < SESSION_GAP_MS;
    if (settled) return null;
  }

  const today = isSameDay(current, now);
  if (!isEnglish(locale)) {
    const day = today ? todayLabel : formatDate(locale, current, SEPARATOR_DAY_OPTIONS);
    return `${day} ${formatDate(locale, current, SEPARATOR_TIME_OPTIONS)}`;
  }
  const day = today
    ? todayLabel
    : `${WEEKDAY_NAMES[current.getDay()]}, ${MONTH_NAMES[current.getMonth()]} ${current.getDate()}`;
  return `${day} ${clockLabel(current)}`;
}

export interface BotConversationEntry {
  readonly message: OrchestrationMessage;
  /** Rendered above the message when the conversation resumes after a break. */
  readonly separator: string | null;
  /** First message of a run by one author: the only one that carries the name and avatar. */
  readonly startsGroup: boolean;
}

/**
 * Turns the visible messages into rendered turns. Consecutive messages from one author
 * form a group so a long answer reads as one reply rather than a stack of small ones.
 */
export function buildBotConversationEntries(
  messages: ReadonlyArray<OrchestrationMessage>,
  now: Date = new Date(),
  todayLabel = "Today",
  locale = "en",
): ReadonlyArray<BotConversationEntry> {
  return messages.map((message, index) => {
    const previous = index === 0 ? null : messages[index - 1];
    const separator = conversationSeparatorLabel(
      message.createdAt,
      previous?.createdAt ?? null,
      now,
      todayLabel,
      locale,
    );
    const sameAuthor =
      previous !== null &&
      previous !== undefined &&
      previous.role === message.role &&
      (previous.respondingBotId ?? null) === (message.respondingBotId ?? null) &&
      (previous.authorPersonId ?? null) === (message.authorPersonId ?? null);
    return { message, separator, startsGroup: separator !== null || !sameAuthor };
  });
}

/**
 * Bot chat shows each user message and one final assistant answer per turn.
 * Provider progress and intermediate assistant records stay behind the working
 * status so one provider turn cannot appear as several bot replies.
 */
export function visibleBotChatMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  working = false,
): ReadonlyArray<OrchestrationMessage> {
  const latestAssistantIndexByResponse = new Map<string, number>();
  let precedingUserId = "before-first-user";
  let lastUserIndex = -1;

  messages.forEach((message, index) => {
    if (message.role === "user" && String(message.id).startsWith("routine:")) return;
    if (message.role === "user") {
      precedingUserId = message.id;
      lastUserIndex = index;
      return;
    }
    if (message.role !== "assistant" || message.streaming) return;
    latestAssistantIndexByResponse.set(message.turnId ?? precedingUserId, index);
  });

  precedingUserId = "before-first-user";
  return messages.filter((message, index) => {
    if (message.role === "user" && String(message.id).startsWith("routine:")) return false;
    if (message.role === "user") {
      precedingUserId = message.id;
      return true;
    }
    if (message.role !== "assistant" || message.streaming) return false;
    if (working && index > lastUserIndex) return false;
    return latestAssistantIndexByResponse.get(message.turnId ?? precedingUserId) === index;
  });
}
