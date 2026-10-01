import { OrchestrationMessage } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import {
  MessageSentPayloadSchema,
  ThreadMessageReactionSetPayload,
  ThreadProposedPlanUpsertedPayload,
} from "../Schemas.ts";
import type { OrchestrationReadModel, OrchestrationEvent } from "@akeru/contracts";
import type { OrchestrationProjectorDecodeError } from "../Errors.ts";
import {
  decodeForEvent,
  findProjectedThread,
  MAX_THREAD_MESSAGES,
  updateThread,
} from "./Updates.ts";

export function projectThreadMessages(
  nextBase: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "thread.message-sent":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          MessageSentPayloadSchema,
          event.payload,
          event.type,
          "payload",
        );
        const thread = findProjectedThread(nextBase.threads, payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const message: OrchestrationMessage = yield* decodeForEvent(
          OrchestrationMessage,
          {
            id: payload.messageId,
            role: payload.role,
            text: payload.text,
            ...(payload.attachments !== undefined ? { attachments: payload.attachments } : {}),
            turnId: payload.turnId,
            ...(payload.respondingBotId !== undefined
              ? { respondingBotId: payload.respondingBotId }
              : {}),
            ...(payload.authorPersonId !== undefined
              ? { authorPersonId: payload.authorPersonId }
              : {}),
            ...(payload.authorDisplayName !== undefined
              ? { authorDisplayName: payload.authorDisplayName }
              : {}),
            ...(payload.channelOrigin !== undefined
              ? { channelOrigin: payload.channelOrigin }
              : {}),
            streaming: payload.streaming,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
          },
          event.type,
          "message",
        );

        // Streaming updates target the newest messages, so search from the end
        // and replace the one entry instead of mapping the whole history.
        const existingIndex = thread.messages.findLastIndex((entry) => entry.id === message.id);
        const entry = existingIndex >= 0 ? thread.messages[existingIndex] : undefined;
        const messages = entry
          ? thread.messages.with(existingIndex, {
              ...entry,
              text: message.streaming
                ? `${entry.text}${message.text}`
                : message.text.length > 0
                  ? message.text
                  : entry.text,
              streaming: message.streaming,
              updatedAt: message.updatedAt,
              turnId: message.turnId,
              ...(message.respondingBotId !== undefined
                ? { respondingBotId: message.respondingBotId }
                : {}),
              ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
            })
          : [...thread.messages, message];
        const cappedMessages =
          messages.length > MAX_THREAD_MESSAGES ? messages.slice(-MAX_THREAD_MESSAGES) : messages;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            messages: cappedMessages,
            updatedAt: event.occurredAt,
          }),
        };
      });
    case "thread.message-reaction-set":
      return decodeForEvent(
        ThreadMessageReactionSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = findProjectedThread(nextBase.threads, payload.threadId);
          if (!thread) return nextBase;
          const messages = thread.messages.map((message) => {
            if (message.id !== payload.messageId) return message;
            const withoutReaction = (message.reactions ?? []).filter(
              (reaction) =>
                reaction.botId !== payload.botId ||
                reaction.personId !== payload.personId ||
                reaction.emoji !== payload.emoji,
            );
            return {
              ...message,
              reactions: payload.present
                ? [
                    ...withoutReaction,
                    {
                      ...(payload.botId !== undefined
                        ? { botId: payload.botId }
                        : { personId: payload.personId }),
                      emoji: payload.emoji,
                    },
                  ]
                : withoutReaction,
              updatedAt: payload.updatedAt,
            };
          });
          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );
    case "thread.proposed-plan-upserted":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadProposedPlanUpsertedPayload,
          event.payload,
          event.type,
          "payload",
        );
        const thread = findProjectedThread(nextBase.threads, payload.threadId);
        if (!thread) {
          return nextBase;
        }

        const proposedPlans = [
          ...thread.proposedPlans.filter((entry) => entry.id !== payload.proposedPlan.id),
          payload.proposedPlan,
        ]
          .toSorted(
            (left, right) =>
              left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
          )
          .slice(-200);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            proposedPlans,
            updatedAt: event.occurredAt,
          }),
        };
      });
    default:
      throw new Error("Unexpected projector event: " + event.type);
  }
}
