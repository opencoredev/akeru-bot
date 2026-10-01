import * as Arr from "effect/Array";
import type {
  OrchestrationEvent,
  OrchestrationMessage,
  OrchestrationThread,
} from "@akeru/contracts";
import type { ThreadDetailReducerResult } from "./types.ts";
import {
  copyLatestTurnIdentities,
  rebindCheckpointAssistantMessage,
  reuseLatestTurn,
} from "./turns.ts";

export function applyChannelDeliverySetEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.channel-delivery-set" }>,
): ThreadDetailReducerResult {
  const messages = thread.messages.map((entry) =>
    entry.id === event.payload.messageId
      ? {
          ...entry,
          channelDelivery: event.payload.delivery,
          updatedAt: event.payload.updatedAt,
        }
      : entry,
  );

  return {
    kind: "updated",
    thread: { ...thread, messages, updatedAt: event.payload.updatedAt },
  };
}

export function applyMessageSentEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.message-sent" }>,
): ThreadDetailReducerResult {
  const message: OrchestrationMessage = {
    id: event.payload.messageId,
    role: event.payload.role,
    text: event.payload.text,
    ...(event.payload.attachments !== undefined ? { attachments: event.payload.attachments } : {}),
    turnId: event.payload.turnId,
    authorPersonId: event.payload.authorPersonId ?? null,
    authorDisplayName: event.payload.authorDisplayName ?? null,
    channelOrigin: event.payload.channelOrigin ?? null,
    streaming: event.payload.streaming,
    createdAt: event.payload.createdAt,
    updatedAt: event.payload.updatedAt,
  };

  const existingMessage = thread.messages.find((entry) => entry.id === message.id);

  const messages = existingMessage
    ? Arr.map(thread.messages, (entry) =>
        entry.id !== message.id
          ? entry
          : {
              ...entry,
              text: message.streaming
                ? `${entry.text}${message.text}`
                : message.text.length > 0
                  ? message.text
                  : entry.text,
              streaming: message.streaming,
              ...(message.turnId !== undefined ? { turnId: message.turnId } : {}),
              ...(message.streaming ? {} : { updatedAt: message.updatedAt }),
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            },
      )
    : Arr.append(thread.messages, message);

  // Update latestTurn for assistant messages bound to a turn. A completed
  // assistant message only settles the turn once the session is no longer
  // running it — providers may emit several assistant messages per turn
  // (commentary between tool calls), and the turn must stay unsettled
  // until the provider reports turn end. Streaming deltas recompute the
  // same record, so the previous reference is kept when nothing changed.
  const turnStillRunning =
    event.payload.turnId !== null &&
    thread.session?.status === "running" &&
    thread.session.activeTurnId === event.payload.turnId;

  const settlesTurn = !event.payload.streaming && !turnStillRunning;

  const latestTurn = reuseLatestTurn(
    thread.latestTurn,
    event.payload.role === "assistant" &&
      event.payload.turnId !== null &&
      (thread.latestTurn === null || thread.latestTurn.turnId === event.payload.turnId)
      ? {
          turnId: event.payload.turnId,
          state: settlesTurn
            ? thread.latestTurn?.state === "interrupted"
              ? "interrupted"
              : thread.latestTurn?.state === "error"
                ? "error"
                : "completed"
            : "running",
          requestedAt:
            thread.latestTurn?.turnId === event.payload.turnId
              ? thread.latestTurn.requestedAt
              : event.payload.createdAt,
          startedAt:
            thread.latestTurn?.turnId === event.payload.turnId
              ? (thread.latestTurn.startedAt ?? event.payload.createdAt)
              : event.payload.createdAt,
          completedAt: settlesTurn
            ? event.payload.updatedAt
            : thread.latestTurn?.turnId === event.payload.turnId
              ? (thread.latestTurn.completedAt ?? null)
              : null,
          assistantMessageId: event.payload.messageId,
          ...copyLatestTurnIdentities(thread.latestTurn, event.payload.turnId),
        }
      : thread.latestTurn,
  );

  // Rebind checkpoint assistant message IDs for assistant messages.
  const checkpoints =
    event.payload.role === "assistant" && event.payload.turnId !== null
      ? rebindCheckpointAssistantMessage(
          thread.checkpoints,
          event.payload.turnId,
          event.payload.messageId,
        )
      : thread.checkpoints;

  return {
    kind: "updated",
    thread: {
      ...thread,
      messages,
      checkpoints,
      latestTurn,
      updatedAt: event.occurredAt,
    },
  };
}

export function applyMessageReactionSetEvent(
  thread: OrchestrationThread,
  event: Extract<OrchestrationEvent, { readonly type: "thread.message-reaction-set" }>,
): ThreadDetailReducerResult {
  const message = thread.messages.find((entry) => entry.id === event.payload.messageId);

  if (!message) return { kind: "unchanged" };

  const withoutReaction = (message.reactions ?? []).filter(
    (reaction) =>
      reaction.botId !== event.payload.botId ||
      reaction.personId !== event.payload.personId ||
      reaction.emoji !== event.payload.emoji,
  );

  return {
    kind: "updated",
    thread: {
      ...thread,
      messages: thread.messages.map((entry) =>
        entry.id === event.payload.messageId
          ? {
              ...entry,
              reactions: event.payload.present
                ? [
                    ...withoutReaction,
                    {
                      ...(event.payload.botId !== undefined
                        ? { botId: event.payload.botId }
                        : { personId: event.payload.personId }),
                      emoji: event.payload.emoji,
                    },
                  ]
                : withoutReaction,
              updatedAt: event.payload.updatedAt,
            }
          : entry,
      ),
      updatedAt: event.payload.updatedAt,
    },
  };
}
