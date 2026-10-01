import type {
  BotId,
  OrchestrationBot,
  OrchestrationEvent,
  OrchestrationGroup,
  ThreadId,
} from "@akeru/contracts";
import { OrchestrationMessage, OrchestrationThread } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { toProjectorDecodeError, type OrchestrationProjectorDecodeError } from "../Errors.ts";

export type ThreadPatch = Partial<Omit<OrchestrationThread, "id" | "projectId">>;

export const MAX_THREAD_MESSAGES = 2_000;

export const MAX_THREAD_ACTIVITIES = 500;

export const MAX_THREAD_CHECKPOINTS = 500;

export function checkpointStatusToLatestTurnState(status: "ready" | "missing" | "error") {
  if (status === "error") return "error" as const;

  // Match SQL and client projections: a missing git ref is not an interruption.
  return "completed" as const;
}

export function updateBot(
  bots: ReadonlyArray<OrchestrationBot>,
  botId: BotId,
  patch: Partial<Omit<OrchestrationBot, "id" | "createdAt">>,
): OrchestrationBot[] {
  return bots.map((bot) => (bot.id === botId ? { ...bot, ...patch } : bot));
}

export function updateGroup(
  groups: ReadonlyArray<OrchestrationGroup>,
  groupId: OrchestrationGroup["id"],
  patch: Partial<Omit<OrchestrationGroup, "id" | "createdAt">>,
): OrchestrationGroup[] {
  return groups.map((group) => (group.id === groupId ? { ...group, ...patch } : group));
}

export const threadIndexes = new WeakMap<
  ReadonlyArray<OrchestrationThread>,
  ReadonlyMap<ThreadId, number>
>();

export function threadIndex(threads: ReadonlyArray<OrchestrationThread>) {
  let index = threadIndexes.get(threads);

  if (!index) {
    index = new Map(threads.map((thread, offset) => [thread.id, offset]));
    threadIndexes.set(threads, index);
  }

  return index;
}

export function findProjectedThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
): OrchestrationThread | undefined {
  const offset = threadIndex(threads).get(threadId);

  return offset === undefined ? undefined : threads[offset];
}

export function updateThread(
  threads: ReadonlyArray<OrchestrationThread>,
  threadId: ThreadId,
  patch: ThreadPatch,
): ReadonlyArray<OrchestrationThread> {
  const index = threadIndex(threads);
  const offset = index.get(threadId);

  if (offset === undefined) return threads;
  const next = threads.slice();
  next[offset] = { ...threads[offset]!, ...patch };
  // A patch preserves both identity and ordering, including archived/deleted rows.
  threadIndexes.set(next, index);

  return next;
}

export function decodeForEvent<A, Input>(
  schema: Schema.Decoder<A, never>,
  value: Input,
  eventType: OrchestrationEvent["type"],
  field: string,
): Effect.Effect<A, OrchestrationProjectorDecodeError> {
  return Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(toProjectorDecodeError(`${eventType}:${field}`)),
  );
}

export function retainThreadMessagesAfterRevert(
  messages: ReadonlyArray<OrchestrationMessage>,
  retainedTurnIds: ReadonlySet<string>,
  turnCount: number,
): ReadonlyArray<OrchestrationMessage> {
  const retainedMessageIds = new Set<string>();

  for (const message of messages) {
    if (message.role === "system") {
      retainedMessageIds.add(message.id);
      continue;
    }

    if (message.turnId !== null && retainedTurnIds.has(message.turnId)) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedUserCount = messages.filter(
    (message) => message.role === "user" && retainedMessageIds.has(message.id),
  ).length;

  const missingUserCount = Math.max(0, turnCount - retainedUserCount);

  if (missingUserCount > 0) {
    const fallbackUserMessages = messages
      .filter(
        (message) =>
          message.role === "user" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingUserCount);

    for (const message of fallbackUserMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  const retainedAssistantCount = messages.filter(
    (message) => message.role === "assistant" && retainedMessageIds.has(message.id),
  ).length;

  const missingAssistantCount = Math.max(0, turnCount - retainedAssistantCount);

  if (missingAssistantCount > 0) {
    const fallbackAssistantMessages = messages
      .filter(
        (message) =>
          message.role === "assistant" &&
          !retainedMessageIds.has(message.id) &&
          (message.turnId === null || retainedTurnIds.has(message.turnId)),
      )
      .toSorted(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      )
      .slice(0, missingAssistantCount);

    for (const message of fallbackAssistantMessages) {
      retainedMessageIds.add(message.id);
    }
  }

  return messages.filter((message) => retainedMessageIds.has(message.id));
}

export function retainThreadActivitiesAfterRevert(
  activities: ReadonlyArray<OrchestrationThread["activities"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["activities"][number]> {
  return activities.filter(
    (activity) => activity.turnId === null || retainedTurnIds.has(activity.turnId),
  );
}

export function retainThreadProposedPlansAfterRevert(
  proposedPlans: ReadonlyArray<OrchestrationThread["proposedPlans"][number]>,
  retainedTurnIds: ReadonlySet<string>,
): ReadonlyArray<OrchestrationThread["proposedPlans"][number]> {
  return proposedPlans.filter(
    (proposedPlan) => proposedPlan.turnId === null || retainedTurnIds.has(proposedPlan.turnId),
  );
}

export function compareThreadActivities(
  left: OrchestrationThread["activities"][number],
  right: OrchestrationThread["activities"][number],
): number {
  if (left.sequence !== undefined && right.sequence !== undefined) {
    if (left.sequence !== right.sequence) {
      return left.sequence - right.sequence;
    }
  } else if (left.sequence !== undefined) {
    return 1;
  } else if (right.sequence !== undefined) {
    return -1;
  }

  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}
