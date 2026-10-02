import { Predicate } from "effect";
import {
  delegationActions,
  threadDelegations,
} from "@akeru/client-runtime/delegation-presentation";
import { botChatTimeline } from "@akeru/client-runtime/state/bot-chat-timeline";
import {
  derivePendingApprovals,
  derivePendingUserInputs,
  type PendingApproval,
  type PendingUserInput,
} from "@akeru/client-runtime/pending-requests";
import type {
  AkeruDelegationRecord,
  ChannelProvider,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Arr from "effect/Array";
import { buildBotStepMeters, type BotStepMeterData } from "@akeru/client-runtime/bot-step-usage";
import type {
  CollapsedWorkLogEntry,
  DerivedWorkLogEntry,
  RawThreadFeedEntry,
  ThreadFeedActivity,
  ThreadFeedEntry,
} from "./threadActivityTypes";
import {
  activityOrder,
  buildWorkEntryExpandedBody,
  deriveWorkLogEntries,
  memoizeValue,
  workEntryHasExpandedBody,
  workEntryHeading,
  workEntryIcon,
  workEntryPreview,
  workEntryStatus,
  workLogEntryIsToolLike,
} from "./threadWorkLog";

export type {
  ThreadFeedActivity,
  ThreadFeedEntry,
  ThreadFeedLatestTurn,
} from "./threadActivityTypes";

export {
  buildPendingUserInputAnswers,
  isPendingUserInputOptionSelected,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
} from "./pendingUserInputAnswers";

export type { PendingUserInputDraftAnswer } from "./pendingUserInputAnswers";

export { deriveGroupSpeakerLabels, deriveThreadFeedPresentation } from "./threadFeedPresentation";

export type { PendingApproval, PendingUserInput };

export { derivePendingApprovals, derivePendingUserInputs };

function isEmptyMessage(entry: RawThreadFeedEntry): boolean {
  if (entry.type !== "message") {
    return false;
  }

  const hasText = entry.message.text.trim().length > 0;
  const hasAttachments = (entry.message.attachments ?? []).length > 0;

  return !hasText && !hasAttachments;
}

function groupAdjacentActivities(entries: ReadonlyArray<RawThreadFeedEntry>): ThreadFeedEntry[] {
  const grouped: ThreadFeedEntry[] = [];
  // Mutable backing array for the trailing group so appending an activity is
  // O(1) instead of re-copying the group (which made this loop quadratic on
  // long tool runs). The array is only mutated while it is the trailing group.
  let openGroupActivities: ThreadFeedActivity[] | null = null;
  let openGroupTurnId: TurnId | null = null;

  for (const entry of entries) {
    // Skip empty messages so they don't break activity grouping.
    if (isEmptyMessage(entry)) {
      continue;
    }

    if (entry.type !== "activity") {
      grouped.push(entry);
      openGroupActivities = null;
      continue;
    }

    if (openGroupActivities !== null && openGroupTurnId === entry.turnId) {
      openGroupActivities.push(entry.activity);
      continue;
    }

    openGroupActivities = [entry.activity];
    openGroupTurnId = entry.turnId;
    grouped.push({
      type: "activity-group",
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.turnId,
      activities: openGroupActivities,
    });
  }

  return grouped;
}

export interface ThreadFeedDelegations {
  readonly delegations: ReadonlyArray<AkeruDelegationRecord>;
  readonly waitingOnChildren: boolean;
}

const EMPTY_THREAD_FEED_DELEGATIONS: ThreadFeedDelegations = {
  delegations: [],
  waitingOnChildren: false,
};

/**
 * The delegation slice of the environment snapshot that feeds the selected
 * chat's cards and its waiting line. Scoped to one thread: callers pass the
 * ids separately, never a joined key, so no separator can desync. JSON keeps
 * the atom quiet unless this chat's cards actually changed.
 */
export function deriveThreadFeedDelegations(
  threadId: ThreadId | undefined,
  snapshotDelegations: ReadonlyArray<AkeruDelegationRecord> | undefined,
): string {
  if (!threadId) {
    return JSON.stringify(EMPTY_THREAD_FEED_DELEGATIONS);
  }

  return JSON.stringify(threadDelegations(snapshotDelegations ?? [], threadId));
}

/**
 * Sorts activities into lifecycle order. `derivePendingApprovals` and
 * `derivePendingUserInputs` both expect this ordering; sorting once and
 * passing the result to both avoids re-sorting the full activity history
 * per derivation.
 */
export function sortThreadActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<OrchestrationThreadActivity> {
  return Arr.sort(activities, activityOrder);
}

/**
 * Drops the `delegation.<state>` delivery activities whose record renders as a
 * card; the card already shows that state and result. Activities without a
 * card, such as `delegation.retry.failed`, stay in the work log.
 */
function withoutCardedDelegationActivities(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  delegations: ReadonlyArray<AkeruDelegationRecord>,
): ReadonlyArray<OrchestrationThreadActivity> {
  if (delegations.length === 0) return activities;
  const cardIds = new Set<string>(delegations.map((delegation) => delegation.delegationId));

  return activities.filter((activity) => {
    if (!activity.kind.startsWith("delegation.")) return true;

    const payload =
      activity.payload && Predicate.isObject(activity.payload) ? activity.payload : null;

    const delegationId = payload?.delegationId;

    return !Predicate.isString(delegationId) || !cardIds.has(delegationId);
  });
}

const activityFeedDerivations = new WeakMap<
  ReadonlyArray<OrchestrationThreadActivity>,
  {
    readonly delegations: ReadonlyArray<AkeruDelegationRecord>;
    readonly botStepMeters: ReturnType<typeof buildBotStepMeters>;
    readonly workLogEntries: ReturnType<typeof deriveWorkLogEntries>;
  }
>();

const NO_FEED_DELEGATIONS: ReadonlyArray<AkeruDelegationRecord> = Object.freeze([]);

function deriveActivityFeed(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  delegations: ReadonlyArray<AkeruDelegationRecord>,
) {
  const cached = activityFeedDerivations.get(activities);

  if (cached !== undefined && sameEntries(cached.delegations, delegations)) return cached;

  const derivation = {
    delegations,
    botStepMeters: buildBotStepMeters(activities),
    workLogEntries: deriveWorkLogEntries(
      withoutCardedDelegationActivities(activities, delegations),
    ),
  };

  activityFeedDerivations.set(activities, derivation);

  return derivation;
}

export function buildThreadFeed(
  thread: Pick<OrchestrationThread, "messages" | "activities">,
  options?: {
    readonly loadedMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
    readonly localMessages?: ReadonlyArray<OrchestrationThread["messages"][number]>;
    /**
     * Delegations this chat started, from the environment snapshot's
     * `delegations` list (thread detail payloads do not carry them).
     * `botChatTimeline` anchors each card to the turn that asked for it. Cards
     * stay outside collapsed work, and the `delegation.<state>` work-log rows
     * for a record that has a card are dropped so it shows once.
     */
    readonly delegations?: ReadonlyArray<AkeruDelegationRecord>;
  },
): ThreadFeedEntry[] {
  const loadedMessages = options?.loadedMessages ?? thread.messages;

  const messages = options?.localMessages
    ? [...loadedMessages, ...options.localMessages]
    : loadedMessages;

  // Assistant replies to a channel-originated user message deliver back to that
  // provider; track the nearest preceding channel origin so the feed can label
  // delivery state without rescanning messages at render time.
  const channelProviderByMessageId = new Map<string, ChannelProvider>();
  {
    let lastChannelProvider: ChannelProvider | null = null;

    for (const message of messages) {
      if (message.role === "user") {
        lastChannelProvider = message.channelOrigin?.provider ?? null;
      } else if (message.role === "assistant" && lastChannelProvider !== null) {
        channelProviderByMessageId.set(message.id, lastChannelProvider);
      }
    }
  }

  const oldestLoadedMessageCreatedAt =
    options?.loadedMessages !== undefined ? (loadedMessages[0]?.createdAt ?? null) : null;

  const { botStepMeters, workLogEntries } = deriveActivityFeed(
    thread.activities,
    options?.delegations ?? NO_FEED_DELEGATIONS,
  );

  const timed: Array<{ readonly at: number; readonly entry: RawThreadFeedEntry }> = [];

  for (const message of messages) {
    const entry = messageFeedEntry(
      message,
      message.turnId === null ? undefined : botStepMeters.get(message.turnId),
      channelProviderByMessageId.get(message.id),
    );

    timed.push({ at: Date.parse(entry.createdAt), entry });
  }

  for (const collapsed of workLogEntries) {
    if (
      options?.loadedMessages !== undefined &&
      oldestLoadedMessageCreatedAt !== null &&
      collapsed.entry.createdAt < oldestLoadedMessageCreatedAt
    ) {
      continue;
    }

    const entry = activityFeedEntry(collapsed);
    timed.push({ at: Date.parse(entry.createdAt), entry });
  }

  // Timestamps are parsed once above; sorting on numbers avoids allocating a
  // Date per comparison.
  timed.sort((left, right) => compareFeedTimes(left.at, right.at));

  return mergeDelegationCards(
    groupAdjacentActivities(timed.map((item) => item.entry)),
    messages,
    options?.delegations ?? [],
  );
}

export function createThreadFeedBuilder() {
  let previous:
    | {
        readonly messages: OrchestrationThread["messages"];
        readonly activities: OrchestrationThread["activities"];
        readonly loadedMessages: ReadonlyArray<OrchestrationThread["messages"][number]> | undefined;
        readonly localMessages: ReadonlyArray<OrchestrationThread["messages"][number]> | undefined;
        readonly delegations: ReadonlyArray<AkeruDelegationRecord>;
        readonly feed: ThreadFeedEntry[];
      }
    | undefined;

  return (
    thread: Pick<OrchestrationThread, "messages" | "activities">,
    options?: Parameters<typeof buildThreadFeed>[1],
  ): ThreadFeedEntry[] => {
    const delegations = options?.delegations ?? NO_FEED_DELEGATIONS;

    if (
      previous !== undefined &&
      previous.messages === thread.messages &&
      previous.activities === thread.activities &&
      previous.loadedMessages === options?.loadedMessages &&
      previous.localMessages === options?.localMessages &&
      sameEntries(previous.delegations, delegations)
    ) {
      return previous.feed;
    }

    const feed = buildThreadFeed(thread, options);
    previous = {
      messages: thread.messages,
      activities: thread.activities,
      loadedMessages: options?.loadedMessages,
      localMessages: options?.localMessages,
      delegations,
      feed,
    };

    return feed;
  };
}

/** Same ordering as `Order.Date`: stable ties, unparsable times first. */
function compareFeedTimes(left: number, right: number): number {
  if (left === right) return 0;
  const leftInvalid = Number.isNaN(left);
  const rightInvalid = Number.isNaN(right);

  if (leftInvalid && rightInvalid) return 0;

  if (leftInvalid) return -1;

  if (rightInvalid) return 1;

  return left < right ? -1 : 1;
}

type MessageFeedEntry = Extract<RawThreadFeedEntry, { type: "message" }>;

// Feed entries are cached on their source objects so unchanged rows keep their
// identity while a turn streams, letting the list skip re-rendering them.
const messageFeedEntryCache = new WeakMap<
  OrchestrationThread["messages"][number],
  MessageFeedEntry
>();

function messageFeedEntry(
  message: OrchestrationThread["messages"][number],
  botStepMeter: BotStepMeterData | undefined,
  channelProvider: ChannelProvider | undefined,
): MessageFeedEntry {
  const cached = messageFeedEntryCache.get(message);

  if (
    cached !== undefined &&
    cached.channelProvider === channelProvider &&
    botStepMetersEqual(cached.botStepMeter, botStepMeter)
  ) {
    return cached;
  }

  const entry: MessageFeedEntry = {
    type: "message",
    id: message.id,
    createdAt: message.createdAt,
    message,
    ...(channelProvider === undefined ? {} : { channelProvider }),
    ...(message.turnId === null ? {} : { botStepMeter }),
  };

  messageFeedEntryCache.set(message, entry);

  return entry;
}

function botStepMetersEqual(
  left: BotStepMeterData | undefined,
  right: BotStepMeterData | undefined,
): boolean {
  if (left === right) return true;

  if (left === undefined || right === undefined) return false;

  return (
    left.tokens === right.tokens &&
    left.costUsd === right.costUsd &&
    left.hardStopReached === right.hardStopReached &&
    (left.engine === right.engine ||
      (left.engine.provider === right.engine.provider &&
        left.engine.model === right.engine.model &&
        left.engine.options === right.engine.options))
  );
}

type ActivityFeedEntry = Extract<RawThreadFeedEntry, { type: "activity" }>;

// Keyed on the newest source entry; reused only when every source matches.
const activityFeedEntryCache = new WeakMap<
  DerivedWorkLogEntry,
  { readonly sources: ReadonlyArray<DerivedWorkLogEntry>; readonly entry: ActivityFeedEntry }
>();

function activityFeedEntry(collapsed: CollapsedWorkLogEntry): ActivityFeedEntry {
  const key = collapsed.sources[collapsed.sources.length - 1]!;
  const cached = activityFeedEntryCache.get(key);

  if (cached !== undefined && sameEntries(cached.sources, collapsed.sources)) {
    return cached.entry;
  }

  const entry = toActivityFeedEntry(collapsed.entry);
  activityFeedEntryCache.set(key, { sources: collapsed.sources, entry });

  return entry;
}

function sameEntries<T>(left: ReadonlyArray<T>, right: ReadonlyArray<T>): boolean {
  if (left.length !== right.length) return false;

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }

  return true;
}

function toActivityFeedEntry(entry: DerivedWorkLogEntry): ActivityFeedEntry {
  const summary = workEntryHeading(entry);
  const detail = workEntryPreview(entry);
  const getFullDetail = memoizeValue(() => buildWorkEntryExpandedBody(entry));

  const getCopyText = memoizeValue(() =>
    [summary, detail, getFullDetail()]
      .filter((value, index, values): value is string => {
        return Boolean(value) && values.indexOf(value) === index;
      })
      .join("\n"),
  );

  return {
    type: "activity",
    id: entry.id,
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    activity: {
      id: entry.id,
      createdAt: entry.createdAt,
      turnId: entry.turnId,
      summary,
      detail,
      canExpand: workEntryHasExpandedBody(entry),
      getFullDetail,
      getCopyText,
      icon: workEntryIcon(entry),
      toolLike: workLogEntryIsToolLike(entry),
      status: workEntryStatus(entry),
    },
  };
}

/**
 * Length of the leading run of `previous` that `next` still holds by identity.
 * Appends keep the whole previous length; a removal or replacement stops at the
 * first changed item so the caller rescans from there.
 */
export function unchangedPrefixLength(
  previous: ReadonlyArray<unknown>,
  next: ReadonlyArray<unknown>,
): number {
  const length = Math.min(previous.length, next.length);
  let index = 0;

  while (index < length && previous[index] === next[index]) {
    index += 1;
  }

  return index;
}

/**
 * Row equality for the thread feed list. Presentation rebuilds wrapper rows on
 * every feed change, so the list compares their rendered fields instead of
 * identity and keeps unchanged rows mounted without re-rendering them.
 */
export function threadFeedEntriesEqual(previous: ThreadFeedEntry, next: ThreadFeedEntry): boolean {
  if (previous === next) return true;

  if (previous.id !== next.id || previous.createdAt !== next.createdAt) return false;

  switch (previous.type) {
    case "delegation":
      return (
        next.type === "delegation" &&
        previous.delegation === next.delegation &&
        previous.actions.length === next.actions.length &&
        previous.actions.every((action, index) => action === next.actions[index])
      );
    case "message":
      return (
        next.type === "message" &&
        previous.message === next.message &&
        previous.channelProvider === next.channelProvider &&
        botStepMetersEqual(previous.botStepMeter, next.botStepMeter)
      );
    case "working":
      return next.type === "working";
    case "activity-group":
      return (
        next.type === "activity-group" &&
        previous.turnId === next.turnId &&
        previous.activities.length === next.activities.length &&
        previous.activities.every((activity, index) => activity === next.activities[index])
      );
    case "work-toggle":
      return (
        next.type === "work-toggle" &&
        previous.turnId === next.turnId &&
        previous.groupId === next.groupId &&
        previous.hiddenCount === next.hiddenCount &&
        previous.expanded === next.expanded &&
        previous.onlyToolActivities === next.onlyToolActivities
      );
    case "turn-fold":
      return (
        next.type === "turn-fold" &&
        previous.turnId === next.turnId &&
        previous.label === next.label &&
        previous.expanded === next.expanded
      );
  }
}

function mergeDelegationCards(
  grouped: ThreadFeedEntry[],
  messages: ReadonlyArray<OrchestrationThread["messages"][number]>,
  delegations: ReadonlyArray<AkeruDelegationRecord>,
): ThreadFeedEntry[] {
  // Delegation cards keep the same anchor placement as web. The shared
  // timeline runs over the thread's messages; each card lands just after the
  // feed row for the message the timeline placed it under.
  // .sort() on a copy, not .toSorted(): Hermes lacks ES2023 change-by-copy.
  const rawMessages = [...messages].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  );

  // Positions are indexes into `grouped`, the array the merge below walks.
  // Activity groups count as one row here even when they hold several
  // activities; counting them by length desyncs the two index spaces and the
  // card lands late or drops entirely.
  const rawPositionByMessageId = new Map<string, number>();
  grouped.forEach((entry, position) => {
    if (entry.type === "message") {
      rawPositionByMessageId.set(entry.id, position);
    }
  });

  const delegationsByPosition = new Map<number, (ThreadFeedEntry & { type: "delegation" })[]>();
  const feedDelegations = delegations;

  const timelineEntries = botChatTimeline({
    messages: rawMessages.map((message) => ({
      id: message.id,
      turnId: message.turnId,
      createdAt: message.createdAt,
    })),
    delegations: feedDelegations,
  });

  let previousTimelineMessage:
    | Extract<(typeof timelineEntries)[number], { _tag: "Message" }>
    | undefined;

  for (const timelineEntry of timelineEntries) {
    if (Predicate.isTagged(timelineEntry, "Message")) {
      previousTimelineMessage = timelineEntry;
      continue;
    }

    if (!Predicate.isTagged(timelineEntry, "Delegation")) continue;

    const card: ThreadFeedEntry & { type: "delegation" } = {
      type: "delegation",
      id: `delegation:${timelineEntry.delegation.delegationId}`,
      createdAt: timelineEntry.delegation.createdAt,
      delegation: timelineEntry.delegation,
      actions: delegationActions(timelineEntry.delegation, feedDelegations),
    };

    if (previousTimelineMessage === undefined) {
      // Cards before the first message (empty chat or end-fallback) lead the feed.
      delegationsByPosition.set(0, [...(delegationsByPosition.get(0) ?? []), card]);
      continue;
    }

    // The preceding message can be an empty row the grouping pass dropped;
    // anchor to the nearest earlier message that is still rendered, then to
    // the front of the feed.
    let position: number | undefined;

    for (
      let rawIndex = previousTimelineMessage.index;
      rawIndex >= 0 && position === undefined;
      rawIndex--
    ) {
      const rawMessage = rawMessages[rawIndex];

      if (rawMessage !== undefined) {
        position = rawPositionByMessageId.get(rawMessage.id);
      }
    }

    const insertAt = position === undefined ? 0 : position + 1;
    delegationsByPosition.set(insertAt, [...(delegationsByPosition.get(insertAt) ?? []), card]);
  }

  if (delegationsByPosition.size === 0) return grouped;
  const merged: ThreadFeedEntry[] = [];
  grouped.forEach((entry, position) => {
    const cards = delegationsByPosition.get(position);

    if (cards) merged.push(...cards);
    merged.push(entry);
  });
  merged.push(...(delegationsByPosition.get(grouped.length) ?? []));

  return merged;
}
