import type { BotId, TurnId } from "@akeru/contracts";
import type { ThreadFeedEntry, ThreadFeedLatestTurn } from "./threadActivityTypes";
import { MAX_VISIBLE_WORK_LOG_ENTRIES } from "./threadWorkLog";

function computeElapsedMs(startIso: string, endIso: string): number | null {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);

  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return null;
  }

  return Math.max(0, end - start);
}

function maxIsoTimestamp(a: string | null, b: string | null): string | null {
  if (a === null) return b;

  if (b === null) return a;
  const aMs = Date.parse(a);
  const bMs = Date.parse(b);

  if (!Number.isFinite(aMs)) return b;

  if (!Number.isFinite(bMs)) return a;

  return bMs > aMs ? b : a;
}

function deriveUnsettledTurnId(latestTurn: ThreadFeedLatestTurn | null): TurnId | null {
  if (!latestTurn) {
    return null;
  }

  const settled = latestTurn.completedAt !== null && latestTurn.state !== "running";

  return settled ? null : latestTurn.turnId;
}

interface ThreadFeedTurnFold {
  readonly turnId: TurnId;
  readonly createdAt: string;
  readonly hiddenEntryIds: ReadonlySet<string>;
  readonly elapsedMs: number | null;
  readonly interrupted: boolean;
}

function deriveThreadFeedTurnFolds(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
): ReadonlyMap<string, ThreadFeedTurnFold> {
  const firstAssistantMessageIdByTurn = new Map<TurnId, string>();
  const terminalAssistantMessageIdByTurn = new Map<TurnId, string>();

  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "assistant" && entry.message.turnId) {
      if (!firstAssistantMessageIdByTurn.has(entry.message.turnId)) {
        firstAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);
      }

      terminalAssistantMessageIdByTurn.set(entry.message.turnId, entry.id);
    }
  }

  interface TurnGroup {
    readonly entries: ThreadFeedEntry[];
    readonly startBoundary: string | null;
  }

  const groupsByTurnId = new Map<TurnId, TurnGroup>();
  let pendingUserBoundary: string | null = null;

  for (const entry of feed) {
    if (entry.type === "message" && entry.message.role === "user") {
      pendingUserBoundary = entry.message.createdAt;
      continue;
    }

    // Delegation cards never join a fold: bot work stays visible in the chat
    // without opening the turn's work log, as it does on web.
    const turnId =
      entry.type === "message" && entry.message.role === "assistant"
        ? entry.message.turnId
        : entry.type === "activity-group"
          ? entry.turnId
          : null;

    if (!turnId) {
      continue;
    }

    let group = groupsByTurnId.get(turnId);

    if (!group) {
      group = {
        entries: [],
        startBoundary: pendingUserBoundary,
      };
      pendingUserBoundary = null;
      groupsByTurnId.set(turnId, group);
    }

    group.entries.push(entry);
  }

  const unsettledTurnId = deriveUnsettledTurnId(latestTurn);
  const foldsByAnchorId = new Map<string, ThreadFeedTurnFold>();

  for (const [turnId, group] of groupsByTurnId) {
    const { entries } = group;

    if (turnId === unsettledTurnId) {
      continue;
    }

    if (entries.some((entry) => entry.type === "message" && entry.message.streaming)) {
      continue;
    }

    const firstAssistantMessageId = firstAssistantMessageIdByTurn.get(turnId);
    const terminalAssistantMessageId = terminalAssistantMessageIdByTurn.get(turnId);

    const hiddenEntryIds = new Set(
      entries
        .filter(
          (entry) =>
            entry.id !== firstAssistantMessageId && entry.id !== terminalAssistantMessageId,
        )
        .map((entry) => entry.id),
    );

    if (hiddenEntryIds.size === 0) {
      continue;
    }

    const firstEntry = entries[0];
    const firstHiddenEntry = entries.find((entry) => hiddenEntryIds.has(entry.id));
    const lastEntry = entries.at(-1);

    if (!firstEntry || !firstHiddenEntry || !lastEntry) {
      continue;
    }

    const terminalEntry = terminalAssistantMessageId
      ? entries.find((entry) => entry.id === terminalAssistantMessageId)
      : null;

    const latestTurnMatches = latestTurn?.turnId === turnId;

    const lastEntryEnd =
      lastEntry.type === "message" ? lastEntry.message.updatedAt : lastEntry.createdAt;

    const elapsedMs =
      latestTurnMatches && latestTurn.startedAt && latestTurn.completedAt
        ? computeElapsedMs(latestTurn.startedAt, latestTurn.completedAt)
        : computeElapsedMs(
            group.startBoundary ?? firstEntry.createdAt,
            maxIsoTimestamp(
              terminalEntry?.type === "message" ? terminalEntry.message.updatedAt : null,
              lastEntryEnd,
            ) ?? lastEntryEnd,
          );

    const interrupted = latestTurnMatches && latestTurn.state === "interrupted";

    foldsByAnchorId.set(firstHiddenEntry.id, {
      turnId,
      createdAt: firstHiddenEntry.createdAt,
      hiddenEntryIds,
      elapsedMs,
      interrupted,
    });
  }

  return foldsByAnchorId;
}

export function deriveThreadFeedPresentation(
  feed: ReadonlyArray<ThreadFeedEntry>,
  latestTurn: ThreadFeedLatestTurn | null,
  expandedTurnIds: ReadonlySet<TurnId>,
  expandedWorkGroupIds: ReadonlySet<string> = new Set(),
  activeWorkStartedAt: string | null = null,
): ThreadFeedEntry[] {
  const sourceFeed = feed.filter(
    (entry) =>
      entry.type !== "turn-fold" && entry.type !== "work-toggle" && entry.type !== "working",
  );

  const foldsByAnchorId = deriveThreadFeedTurnFolds(sourceFeed, latestTurn);
  const collapsedEntryIds = new Set<string>();

  for (const fold of foldsByAnchorId.values()) {
    if (!expandedTurnIds.has(fold.turnId)) {
      for (const entryId of fold.hiddenEntryIds) {
        collapsedEntryIds.add(entryId);
      }
    }
  }

  const result: ThreadFeedEntry[] = [];

  for (const entry of sourceFeed) {
    const fold = foldsByAnchorId.get(entry.id);

    if (fold) {
      result.push({
        type: "turn-fold",
        id: `turn-fold:${fold.turnId}`,
        createdAt: fold.createdAt,
        turnId: fold.turnId,
        elapsedMs: fold.elapsedMs,
        interrupted: fold.interrupted,
        expanded: expandedTurnIds.has(fold.turnId),
      });
    }

    if (!collapsedEntryIds.has(entry.id)) {
      appendPresentedFeedEntry(result, entry, expandedWorkGroupIds);
    }
  }

  if (activeWorkStartedAt !== null) {
    result.push({
      type: "working",
      id: "working-indicator-row",
      createdAt: activeWorkStartedAt,
    });
  }

  return result;
}

function appendPresentedFeedEntry(
  result: ThreadFeedEntry[],
  entry: Exclude<ThreadFeedEntry, { readonly type: "turn-fold" | "work-toggle" | "working" }>,
  expandedWorkGroupIds: ReadonlySet<string>,
): void {
  if (entry.type !== "activity-group") {
    result.push(entry);

    return;
  }

  const activities = entry.activities.filter(
    (activity) => !(activity.toolLike && activity.status === "neutral"),
  );

  if (activities.length === 0) {
    return;
  }

  if (activities.length <= MAX_VISIBLE_WORK_LOG_ENTRIES) {
    result.push({
      ...entry,
      activities,
    });

    return;
  }

  const groupId = entry.id;
  const expanded = expandedWorkGroupIds.has(groupId);
  const hiddenCount = activities.length - MAX_VISIBLE_WORK_LOG_ENTRIES;
  const visibleActivities = expanded ? activities : activities.slice(-MAX_VISIBLE_WORK_LOG_ENTRIES);

  for (const activity of visibleActivities) {
    result.push({
      type: "activity-group",
      id: activity.id,
      createdAt: activity.createdAt,
      turnId: activity.turnId,
      activities: [activity],
    });
  }

  result.push({
    type: "work-toggle",
    id: `work-toggle:${groupId}`,
    createdAt: entry.createdAt,
    turnId: entry.turnId,
    groupId,
    hiddenCount,
    expanded,
    onlyToolActivities: activities.every((activity) => activity.toolLike),
  });
}

/**
 * In a group chat, the assistant messages that start a new speaker run, keyed
 * by message id to the bot that spoke. A message without `respondingBotId` is
 * the boss's, as on web. Pass the presented feed so labels follow what is
 * visible; direct chats (no `group`) get no labels. A group without a boss
 * labels only replies that name their bot.
 */
export function deriveGroupSpeakerLabels(
  feed: ReadonlyArray<ThreadFeedEntry>,
  group: { readonly bossBotId: BotId | null } | null,
): ReadonlyMap<string, BotId> {
  const labels = new Map<string, BotId>();

  if (group === null) return labels;
  let previousSpeaker: BotId | null = null;

  for (const entry of feed) {
    if (entry.type !== "message" || entry.message.role !== "assistant") continue;
    const { message } = entry;

    if (message.text.trim().length === 0 && (message.attachments ?? []).length === 0) continue;
    const speaker = message.respondingBotId ?? group.bossBotId;

    if (speaker !== null && speaker !== previousSpeaker) labels.set(message.id, speaker);
    previousSpeaker = speaker;
  }

  return labels;
}
