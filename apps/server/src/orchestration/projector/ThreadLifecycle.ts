import { OrchestrationThread, ThreadChannelDeliverySetPayload } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import {
  ThreadArchivedPayload,
  ThreadCreatedPayload,
  ThreadOwnershipUpdatedPayload,
  ThreadDeletedPayload,
  ThreadInteractionModeSetPayload,
  ThreadMetaUpdatedPayload,
  ThreadRuntimeModeSetPayload,
  ThreadSettledPayload,
  ThreadPinnedPayload,
  ThreadPinReorderedPayload,
  ThreadSnoozedPayload,
  ThreadUnpinnedPayload,
  ThreadUnarchivedPayload,
  ThreadUnsettledPayload,
  ThreadUnsnoozedPayload,
} from "../Schemas.ts";
import type { OrchestrationReadModel, OrchestrationEvent } from "@akeru/contracts";
import type { OrchestrationProjectorDecodeError } from "../Errors.ts";
import { decodeForEvent, updateThread, findProjectedThread } from "./Updates.ts";

export function projectThreadLifecycle(
  nextBase: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "thread.created":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadCreatedPayload,
          event.payload,
          event.type,
          "payload",
        );

        const thread: OrchestrationThread = yield* decodeForEvent(
          OrchestrationThread,
          {
            id: payload.threadId,
            projectId: payload.projectId,
            botId: payload.botId ?? null,
            groupId: payload.groupId ?? null,
            parentThreadId: payload.parentThreadId ?? null,
            parentDelegationId: payload.parentDelegationId ?? null,
            respondingBotId: null,
            title: payload.title,
            modelSelection: payload.modelSelection,
            runtimeMode: payload.runtimeMode,
            interactionMode: payload.interactionMode,
            branch: payload.branch,
            worktreePath: payload.worktreePath,
            latestTurn: null,
            createdAt: payload.createdAt,
            updatedAt: payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            deletedAt: null,
            messages: [],
            activities: [],
            checkpoints: [],
            session: null,
          },
          event.type,
          "thread",
        );

        const existing = nextBase.threads.find((entry) => entry.id === thread.id);

        return {
          ...nextBase,
          threads: existing
            ? nextBase.threads.map((entry) => (entry.id === thread.id ? thread : entry))
            : [...nextBase.threads, thread],
        };
      });
    case "thread.ownership-updated":
      return decodeForEvent(
        ThreadOwnershipUpdatedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            botId: payload.botId,
            groupId: payload.groupId,
            // A new owner makes the last responder stale, so a detached chat cannot route to it.
            respondingBotId: payload.botId,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.deleted":
      return decodeForEvent(ThreadDeletedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            deletedAt: payload.deletedAt,
            updatedAt: payload.deletedAt,
          }),
        })),
      );
    case "thread.archived":
      return decodeForEvent(ThreadArchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: payload.archivedAt,
            titleRegeneration: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.unarchived":
      return decodeForEvent(ThreadUnarchivedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            archivedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.settled":
      return decodeForEvent(ThreadSettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            settledOverride: "settled",
            settledAt: payload.settledAt,
            unsettledAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.unsettled":
      return decodeForEvent(ThreadUnsettledPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const existing = findProjectedThread(nextBase.threads, payload.threadId);

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              settledOverride: payload.reason === "user" ? "active" : null,
              settledAt: null,
              // Re-entry stamp for active-list ordering. A thread already
              // pinned active keeps its stamp: the activity reset that clears
              // the pin is not a re-entry and must not reorder the list.
              unsettledAt:
                existing?.settledOverride === "active"
                  ? (existing.unsettledAt ?? null)
                  : payload.updatedAt,
              updatedAt: payload.updatedAt,
            }),
          };
        }),
      );
    case "thread.snoozed":
      return decodeForEvent(ThreadSnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: payload.snoozedUntil,
            snoozedAt: payload.snoozedAt,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.unsnoozed":
      return decodeForEvent(ThreadUnsnoozedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.pinned":
      return decodeForEvent(ThreadPinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: payload.pinnedAt,
            ...(payload.pinOrderKey !== undefined ? { pinOrderKey: payload.pinOrderKey } : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.unpinned":
      return decodeForEvent(ThreadUnpinnedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinnedAt: null,
            // Unpin clears the slot: re-pinning is "pin again", not "restore
            // an ancient position".
            pinOrderKey: null,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.pin-reordered":
      return decodeForEvent(ThreadPinReorderedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            pinOrderKey: payload.orderKey,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.meta-updated":
      return decodeForEvent(ThreadMetaUpdatedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            ...(payload.title !== undefined ? { title: payload.title } : {}),
            ...(payload.titleRegeneration !== undefined
              ? { titleRegeneration: payload.titleRegeneration }
              : {}),
            ...(payload.modelSelection !== undefined
              ? { modelSelection: payload.modelSelection }
              : {}),
            ...(payload.branch !== undefined ? { branch: payload.branch } : {}),
            ...(payload.worktreePath !== undefined ? { worktreePath: payload.worktreePath } : {}),
            ...(payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: payload.linkedPullRequest }
              : {}),
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.runtime-mode-set":
      return decodeForEvent(ThreadRuntimeModeSetPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            runtimeMode: payload.runtimeMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.interaction-mode-set":
      return decodeForEvent(
        ThreadInteractionModeSetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            interactionMode: payload.interactionMode,
            updatedAt: payload.updatedAt,
          }),
        })),
      );
    case "thread.channel-delivery-set":
      return decodeForEvent(
        ThreadChannelDeliverySetPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = findProjectedThread(nextBase.threads, payload.threadId);

          if (!thread) return nextBase;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              messages: thread.messages.map((entry) =>
                entry.id === payload.messageId
                  ? { ...entry, channelDelivery: payload.delivery }
                  : entry,
              ),
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );
    default:
      throw new Error("Unexpected projector event: " + event.type);
  }
}
