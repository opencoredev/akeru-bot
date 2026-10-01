import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { retainProjectionMessagesAfterRevert } from "../../RetainedRevertMessages.ts";
import {
  type ProjectionDependencies,
  type ProjectorDefinition,
  retainProjectionProposedPlansAfterRevert,
} from "./Definitions.ts";

import { collectThreadAttachmentRelativePaths } from "./AttachmentCleanup.ts";
export function createMessages({
  projectionThreadMessageRepository,
  projectionTurnRepository,
  projectionThreadProposedPlanRepository,
}: Pick<
  ProjectionDependencies,
  | "projectionThreadMessageRepository"
  | "projectionTurnRepository"
  | "projectionThreadProposedPlanRepository"
>) {
  const applyThreadMessagesProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyThreadMessagesProjection",
  )(function* (event, attachmentSideEffects) {
    switch (event.type) {
      // A draft retry re-creates a soft-deleted thread id. Every projector
      // drops its own rows for the old incarnation here so replay from any
      // per-projector cursor rebuilds the new thread without stale history.
      case "thread.created":
        yield* projectionThreadMessageRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;

      case "thread.message-sent": {
        if (event.payload.streaming) {
          const attachments = event.payload.attachments;
          yield* projectionThreadMessageRepository.appendStreaming({
            messageId: event.payload.messageId,
            threadId: event.payload.threadId,
            turnId: event.payload.turnId,
            respondingBotId: event.payload.respondingBotId ?? null,
            authorPersonId: event.payload.authorPersonId ?? null,
            authorDisplayName: event.payload.authorDisplayName ?? null,
            channelOrigin: event.payload.channelOrigin ?? null,
            role: event.payload.role,
            text: event.payload.text,
            ...(attachments !== undefined ? { attachments: [...attachments] } : {}),
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
          messageId: event.payload.messageId,
        });
        const previousMessage = Option.getOrUndefined(existingMessage);
        const nextText = Option.match(existingMessage, {
          onNone: () => event.payload.text,
          onSome: (message) =>
            event.payload.text.length === 0 ? message.text : event.payload.text,
        });
        const nextAttachments = event.payload.attachments ?? previousMessage?.attachments;
        yield* projectionThreadMessageRepository.upsert({
          messageId: event.payload.messageId,
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          respondingBotId:
            event.payload.respondingBotId ?? previousMessage?.respondingBotId ?? null,
          authorPersonId: event.payload.authorPersonId ?? previousMessage?.authorPersonId ?? null,
          authorDisplayName:
            event.payload.authorDisplayName ?? previousMessage?.authorDisplayName ?? null,
          channelOrigin: event.payload.channelOrigin ?? previousMessage?.channelOrigin ?? null,
          role: event.payload.role,
          text: nextText,
          ...(nextAttachments !== undefined ? { attachments: [...nextAttachments] } : {}),
          reactions: previousMessage?.reactions ?? [],
          isStreaming: false,
          createdAt: previousMessage?.createdAt ?? event.payload.createdAt,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.channel-delivery-set": {
        const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
          messageId: event.payload.messageId,
        });
        if (Option.isNone(existingMessage)) return;
        yield* projectionThreadMessageRepository.upsert({
          ...existingMessage.value,
          channelDelivery: event.payload.delivery,
          updatedAt: event.payload.updatedAt,
        });
        return;
      }

      case "thread.message-reaction-set": {
        const existingMessage = yield* projectionThreadMessageRepository.getByMessageId({
          messageId: event.payload.messageId,
        });
        if (Option.isNone(existingMessage)) return;
        const withoutReaction = (existingMessage.value.reactions ?? []).filter(
          (reaction) =>
            reaction.botId !== event.payload.botId ||
            reaction.personId !== event.payload.personId ||
            reaction.emoji !== event.payload.emoji,
        );
        yield* projectionThreadMessageRepository.upsert({
          ...existingMessage.value,
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
        });
        return;
      }

      case "thread.reverted": {
        const existingRows = yield* projectionThreadMessageRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }

        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionMessagesAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }

        yield* projectionThreadMessageRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadMessageRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
        attachmentSideEffects.prunedThreadRelativePaths.set(
          event.payload.threadId,
          collectThreadAttachmentRelativePaths(event.payload.threadId, keptRows),
        );
        return;
      }

      default:
        return;
    }
  });

  const applyThreadProposedPlansProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyThreadProposedPlansProjection",
  )(function* (event, _attachmentSideEffects) {
    switch (event.type) {
      case "thread.created":
        yield* projectionThreadProposedPlanRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;

      case "thread.proposed-plan-upserted":
        yield* projectionThreadProposedPlanRepository.upsert({
          planId: event.payload.proposedPlan.id,
          threadId: event.payload.threadId,
          turnId: event.payload.proposedPlan.turnId,
          planMarkdown: event.payload.proposedPlan.planMarkdown,
          implementedAt: event.payload.proposedPlan.implementedAt,
          implementationThreadId: event.payload.proposedPlan.implementationThreadId,
          createdAt: event.payload.proposedPlan.createdAt,
          updatedAt: event.payload.proposedPlan.updatedAt,
        });
        return;

      case "thread.reverted": {
        const existingRows = yield* projectionThreadProposedPlanRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        if (existingRows.length === 0) {
          return;
        }

        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptRows = retainProjectionProposedPlansAfterRevert(
          existingRows,
          existingTurns,
          event.payload.turnCount,
        );
        if (keptRows.length === existingRows.length) {
          return;
        }

        yield* projectionThreadProposedPlanRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(keptRows, projectionThreadProposedPlanRepository.upsert, {
          concurrency: 1,
        }).pipe(Effect.asVoid);
        return;
      }

      default:
        return;
    }
  });
  return { applyThreadMessagesProjection, applyThreadProposedPlansProjection };
}
