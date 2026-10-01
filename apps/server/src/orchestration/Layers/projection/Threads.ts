import { ThreadId } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { type ProjectionTurn } from "../../../persistence/Services/ProjectionTurns.ts";
import {
  type ProjectionDependencies,
  derivePendingUserInputCountFromActivities,
  type ProjectorDefinition,
  shouldRefreshThreadShellSummary,
} from "./Definitions.ts";
import type { createDelegations } from "./Delegations.ts";
export function makeThreads({
  projectionThreadRepository,
  projectionThreadMessageRepository,
  projectionThreadProposedPlanRepository,
  projectionThreadActivityRepository,
  projectionPendingApprovalRepository,
  delegationParentLink,
  eventStore,
  projectionTurnRepository,
}: Pick<
  ProjectionDependencies & ReturnType<typeof createDelegations>,
  | "projectionThreadRepository"
  | "projectionThreadMessageRepository"
  | "projectionThreadProposedPlanRepository"
  | "projectionThreadActivityRepository"
  | "projectionPendingApprovalRepository"
  | "delegationParentLink"
  | "eventStore"
  | "projectionTurnRepository"
>) {
  const refreshThreadShellSummary = Effect.fn("refreshThreadShellSummary")(function* (
    threadId: ThreadId,
  ) {
    const existingRow = yield* projectionThreadRepository.getById({
      threadId,
    });
    if (Option.isNone(existingRow)) {
      return;
    }

    const [latestUserMessageAt, hasActionableProposedPlan, activities, pendingApprovalCount] =
      yield* Effect.all([
        projectionThreadMessageRepository.getLatestUserMessageAt({ threadId }),
        projectionThreadProposedPlanRepository.hasActionableByThreadId({
          threadId,
          latestTurnId: existingRow.value.latestTurnId,
        }),
        projectionThreadActivityRepository.listUserInputLifecycleByThreadId({ threadId }),
        projectionPendingApprovalRepository.countPendingByThreadId({ threadId }),
      ]);

    const pendingUserInputCount = derivePendingUserInputCountFromActivities(activities);

    yield* projectionThreadRepository.upsert({
      ...existingRow.value,
      latestUserMessageAt,
      pendingApprovalCount,
      pendingUserInputCount,
      hasActionableProposedPlan: hasActionableProposedPlan ? 1 : 0,
    });
  });

  const applyThreadsProjection: ProjectorDefinition["apply"] = Effect.fn("applyThreadsProjection")(
    function* (event, attachmentSideEffects) {
      switch (event.type) {
        case "thread.created": {
          const parentLink = event.payload.parentThreadId
            ? {
                parentThreadId: event.payload.parentThreadId,
                parentDelegationId: event.payload.parentDelegationId ?? null,
              }
            : yield* delegationParentLink(event.payload.threadId);
          yield* projectionThreadRepository.upsert({
            threadId: event.payload.threadId,
            projectId: event.payload.projectId,
            botId: event.payload.botId ?? null,
            groupId: event.payload.groupId ?? null,
            ...parentLink,
            respondingBotId: null,
            title: event.payload.title,
            modelSelection: event.payload.modelSelection,
            runtimeMode: event.payload.runtimeMode,
            interactionMode: event.payload.interactionMode,
            branch: event.payload.branch,
            worktreePath: event.payload.worktreePath,
            linkedPullRequest: null,
            latestTurnId: null,
            createdAt: event.payload.createdAt,
            updatedAt: event.payload.updatedAt,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            unsettledAt: null,
            snoozedUntil: null,
            snoozedAt: null,
            pinnedAt: null,
            pinOrderKey: null,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            latestUserMessageAt: null,
            pendingApprovalCount: 0,
            pendingUserInputCount: 0,
            hasActionableProposedPlan: 0,
            deletedAt: null,
          });
          return;
        }

        case "thread.ownership-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            botId: event.payload.botId,
            groupId: event.payload.groupId,
            respondingBotId: event.payload.botId,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.archived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: event.payload.archivedAt,
            titleRegenerationRequestId: null,
            titleRegenerationStartedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unarchived": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            archivedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.settled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: "settled",
            settledAt: event.payload.settledAt,
            unsettledAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsettled": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            settledOverride: event.payload.reason === "user" ? "active" : null,
            settledAt: null,
            // Re-entry stamp for active-list ordering. A thread already pinned
            // active keeps its stamp: the activity reset that clears the pin
            // is not a re-entry and must not reorder the list.
            unsettledAt:
              existingRow.value.settledOverride === "active"
                ? existingRow.value.unsettledAt
                : event.payload.updatedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.snoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: event.payload.snoozedUntil,
            snoozedAt: event.payload.snoozedAt,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unsnoozed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            snoozedUntil: null,
            snoozedAt: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: event.payload.pinnedAt,
            ...(event.payload.pinOrderKey !== undefined
              ? { pinOrderKey: event.payload.pinOrderKey }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.unpinned": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinnedAt: null,
            pinOrderKey: null,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.pin-reordered": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            pinOrderKey: event.payload.orderKey,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.meta-updated": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            ...(event.payload.title !== undefined ? { title: event.payload.title } : {}),
            ...(event.payload.titleRegeneration !== undefined
              ? {
                  titleRegenerationRequestId: event.payload.titleRegeneration?.requestId ?? null,
                  titleRegenerationStartedAt: event.payload.titleRegeneration?.startedAt ?? null,
                }
              : {}),
            ...(event.payload.modelSelection !== undefined
              ? { modelSelection: event.payload.modelSelection }
              : {}),
            ...(event.payload.branch !== undefined ? { branch: event.payload.branch } : {}),
            ...(event.payload.worktreePath !== undefined
              ? { worktreePath: event.payload.worktreePath }
              : {}),
            ...(event.payload.linkedPullRequest !== undefined
              ? { linkedPullRequest: event.payload.linkedPullRequest }
              : {}),
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.runtime-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            runtimeMode: event.payload.runtimeMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.interaction-mode-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            interactionMode: event.payload.interactionMode,
            updatedAt: event.payload.updatedAt,
          });
          return;
        }

        case "thread.deleted": {
          // A draft retry can re-create this id later in the log. During
          // replay the attachment files on disk already belong to that later
          // incarnation, so only an unsuperseded deletion removes them.
          const recreatedLater = yield* eventStore.hasEventAfter({
            aggregateKind: "thread",
            aggregateId: event.payload.threadId,
            type: "thread.created",
            sequenceExclusive: event.sequence,
          });
          if (!recreatedLater) {
            attachmentSideEffects.deletedThreadIds.add(event.payload.threadId);
          }
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            deletedAt: event.payload.deletedAt,
            updatedAt: event.payload.deletedAt,
          });
          return;
        }

        case "thread.turn-start-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) return;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            respondingBotId: event.payload.respondingBotId ?? null,
            updatedAt: event.occurredAt,
          });
          return;
        }

        // A message cannot change any summary field except latestUserMessageAt,
        // which is a monotonic maximum that folds in directly. The full refresh
        // would re-read every message body in the thread per user message.
        case "thread.message-sent": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          const previousLatest = existingRow.value.latestUserMessageAt;
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
            latestUserMessageAt:
              event.payload.role === "user" &&
              (previousLatest === null || event.payload.createdAt > previousLatest)
                ? event.payload.createdAt
                : previousLatest,
          });
          return;
        }

        case "thread.message-reaction-set":
        case "thread.proposed-plan-upserted":
        case "thread.activity-appended":
        case "thread.approval-response-requested":
        case "thread.user-input-response-requested": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            updatedAt: event.occurredAt,
          });
          if (shouldRefreshThreadShellSummary(event)) {
            yield* refreshThreadShellSummary(event.payload.threadId);
          }
          return;
        }

        case "thread.session-set": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            // activeTurnId describes current work; a terminal session must not erase history.
            latestTurnId: event.payload.session.activeTurnId ?? existingRow.value.latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.turn-diff-completed": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }
          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId: event.payload.turnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        case "thread.reverted": {
          const existingRow = yield* projectionThreadRepository.getById({
            threadId: event.payload.threadId,
          });
          if (Option.isNone(existingRow)) {
            return;
          }

          const retainedTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          let latestTurnId: ProjectionTurn["turnId"] = null;
          let latestCheckpointTurnCount = -1;
          for (let index = 0; index < retainedTurns.length; index += 1) {
            const turn = retainedTurns[index];
            if (
              !turn ||
              turn.turnId === null ||
              turn.checkpointTurnCount === null ||
              turn.checkpointTurnCount > event.payload.turnCount
            ) {
              continue;
            }
            if (turn.checkpointTurnCount > latestCheckpointTurnCount) {
              latestCheckpointTurnCount = turn.checkpointTurnCount;
              latestTurnId = turn.turnId;
            }
          }

          yield* projectionThreadRepository.upsert({
            ...existingRow.value,
            latestTurnId,
            updatedAt: event.occurredAt,
          });
          yield* refreshThreadShellSummary(event.payload.threadId);
          return;
        }

        default:
          return;
      }
    },
  );
  return { refreshThreadShellSummary, applyThreadsProjection };
}
