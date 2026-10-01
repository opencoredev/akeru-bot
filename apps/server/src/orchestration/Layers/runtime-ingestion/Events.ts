import {
  type AssistantDeliveryMode,
  MessageId,
  CheckpointRef,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  toTurnId,
  runtimeChatAttachment,
  proposedPlanIdFromEvent,
  proposedPlanIdForTurn,
  STRICT_PROVIDER_LIFECYCLE_GUARD,
  sameId,
  hasCheckpointForTurn,
  maxCheckpointTurnCount,
  findTaskTitleInActivities,
  providerTurnKey,
} from "./EventFields.ts";
import { runtimeEventToActivities } from "./ActivityMapping.ts";
import type { createAdmission } from "./Admission.ts";
import type { createMessages } from "./Messages.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createContext } from "./Context.ts";
import type { createPlans } from "./Plans.ts";
import type { createCleanup } from "./Cleanup.ts";
import type { createTasks } from "./Tasks.ts";
import type { createChannels } from "./Channels.ts";

export function createEvents({
  prepareRuntimeEvent,
  getOrCreateAssistantMessageId,
  rememberAssistantMessageId,
  serverSettingsService,
  appendBufferedAssistantText,
  orchestrationEngine,
  providerCommandId,
  flushBufferedAssistantMessagesForTurn,
  finalizeActiveAssistantSegmentForTurn,
  projectionThreadMessages,
  appendBufferedProposedPlan,
  getActiveAssistantMessageIdForTurn,
  getThreadMessageById,
  finalizeAssistantMessage,
  forgetAssistantMessageId,
  clearAssistantSegmentStateForTurn,
  finalizeBufferedProposedPlan,
  resolveNativeUserInputForTerminalTurn,
  getAssistantMessageIdsForTurn,
  clearAssistantMessageIdsForTurn,
  clearTurnStateForSession,
  projectionSnapshotQuery,
  checkpointStore,
  rememberTaskDescription,
  threadPlanProgress,
  threadBackgroundLiveness,
  lookupTaskDescription,
  projectionThreadActivities,
  channelWaitingRequests,
  channelStatusWorker,
  channelRuntime,
  automaticChannelReplyWorker,
}: Pick<
  ReturnType<typeof createAdmission> &
    Effect.Success<ReturnType<typeof createMessages>> &
    Effect.Success<ReturnType<typeof createDependencies>> &
    ReturnType<typeof createContext> &
    Effect.Success<ReturnType<typeof createPlans>> &
    ReturnType<typeof createCleanup> &
    Effect.Success<ReturnType<typeof createTasks>> &
    Effect.Success<ReturnType<typeof createChannels>>,
  | "prepareRuntimeEvent"
  | "getOrCreateAssistantMessageId"
  | "rememberAssistantMessageId"
  | "serverSettingsService"
  | "appendBufferedAssistantText"
  | "orchestrationEngine"
  | "providerCommandId"
  | "flushBufferedAssistantMessagesForTurn"
  | "finalizeActiveAssistantSegmentForTurn"
  | "projectionThreadMessages"
  | "appendBufferedProposedPlan"
  | "getActiveAssistantMessageIdForTurn"
  | "getThreadMessageById"
  | "finalizeAssistantMessage"
  | "forgetAssistantMessageId"
  | "clearAssistantSegmentStateForTurn"
  | "finalizeBufferedProposedPlan"
  | "resolveNativeUserInputForTerminalTurn"
  | "getAssistantMessageIdsForTurn"
  | "clearAssistantMessageIdsForTurn"
  | "clearTurnStateForSession"
  | "projectionSnapshotQuery"
  | "checkpointStore"
  | "rememberTaskDescription"
  | "threadPlanProgress"
  | "threadBackgroundLiveness"
  | "lookupTaskDescription"
  | "projectionThreadActivities"
  | "channelWaitingRequests"
  | "channelStatusWorker"
  | "channelRuntime"
  | "automaticChannelReplyWorker"
>) {
  const processRuntimeEvent = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      const context = yield* prepareRuntimeEvent(event);

      if (!context) return;

      const {
        thread,
        eventTurnId,
        now,
        activeTurnId,
        conflictsWithActiveTurn,
        pendingTurnStart,
        shouldApplyThreadLifecycle,
      } = context;

      const assistantDelta =
        event.type === "content.delta" && event.payload.streamKind === "assistant_text"
          ? event.payload.delta
          : undefined;

      const proposedPlanDelta =
        event.type === "turn.proposed.delta" ? event.payload.delta : undefined;

      if (assistantDelta && assistantDelta.length > 0) {
        const turnId = toTurnId(event.turnId);

        const assistantMessageId = yield* getOrCreateAssistantMessageId({
          threadId: thread.id,
          event,
          ...(turnId ? { turnId } : {}),
        });

        if (turnId) {
          yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
        }

        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );

        if (assistantDeliveryMode === "buffered") {
          const spillChunk = yield* appendBufferedAssistantText(assistantMessageId, assistantDelta);

          if (spillChunk.length > 0) {
            yield* orchestrationEngine.dispatch({
              type: "thread.message.assistant.delta",
              commandId: yield* providerCommandId(event, "assistant-delta-buffer-spill"),
              threadId: thread.id,
              messageId: assistantMessageId,
              delta: spillChunk,
              ...(turnId ? { turnId } : {}),
              createdAt: now,
            });
          }
        } else {
          yield* orchestrationEngine.dispatch({
            type: "thread.message.assistant.delta",
            commandId: yield* providerCommandId(event, "assistant-delta"),
            threadId: thread.id,
            messageId: assistantMessageId,
            delta: assistantDelta,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
          });
        }
      }

      const chatAttachment = runtimeChatAttachment(event);

      if (chatAttachment) {
        const turnId = toTurnId(event.turnId);
        const messageId = MessageId.make(`provider-attachment-${event.eventId}`);
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.delta",
          commandId: yield* providerCommandId(event, "assistant-attachment"),
          threadId: thread.id,
          messageId,
          delta: "",
          attachments: [chatAttachment],
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
        yield* orchestrationEngine.dispatch({
          type: "thread.message.assistant.complete",
          commandId: yield* providerCommandId(event, "assistant-attachment-complete"),
          threadId: thread.id,
          messageId,
          ...(turnId ? { turnId } : {}),
          createdAt: now,
        });
      }

      const pauseForUserTurnId =
        event.type === "request.opened" || event.type === "user-input.requested"
          ? toTurnId(event.turnId)
          : undefined;

      if (pauseForUserTurnId) {
        const assistantDeliveryMode: AssistantDeliveryMode = yield* Effect.map(
          serverSettingsService.getSettings,
          (settings) => (settings.enableLegacyTokenStreaming ? "streaming" : "buffered"),
        );

        const flushedMessageIds =
          assistantDeliveryMode === "buffered"
            ? yield* flushBufferedAssistantMessagesForTurn({
                event,
                threadId: thread.id,
                turnId: pauseForUserTurnId,
                createdAt: now,
                commandTag:
                  event.type === "request.opened"
                    ? "assistant-delta-flush-on-request-opened"
                    : "assistant-delta-flush-on-user-input-requested",
              })
            : new Set<MessageId>();

        yield* finalizeActiveAssistantSegmentForTurn({
          event,
          threadId: thread.id,
          turnId: pauseForUserTurnId,
          createdAt: now,
          commandTag:
            event.type === "request.opened"
              ? "assistant-complete-on-request-opened"
              : "assistant-complete-on-user-input-requested",
          finalDeltaCommandTag:
            event.type === "request.opened"
              ? "assistant-delta-finalize-on-request-opened"
              : "assistant-delta-finalize-on-user-input-requested",
          hasProjectedMessage: yield* projectionThreadMessages.hasAssistantMessageForTurn({
            threadId: thread.id,
            turnId: pauseForUserTurnId,
            streamingOnly: true,
          }),
          flushedMessageIds,
        });
      }

      if (proposedPlanDelta && proposedPlanDelta.length > 0) {
        const planId = proposedPlanIdFromEvent(event, thread.id);
        yield* appendBufferedProposedPlan(planId, proposedPlanDelta, now);
      }

      const assistantCompletion =
        event.type === "item.completed" && event.payload.itemType === "assistant_message"
          ? {
              messageId: MessageId.make(
                `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
              ),
              fallbackText: event.payload.detail,
            }
          : undefined;

      const proposedPlanCompletion =
        event.type === "turn.proposed.completed"
          ? {
              planId: proposedPlanIdFromEvent(event, thread.id),
              turnId: toTurnId(event.turnId),
              planMarkdown: event.payload.planMarkdown,
            }
          : undefined;

      if (assistantCompletion) {
        const turnId = toTurnId(event.turnId);

        const activeAssistantMessageId = turnId
          ? yield* getActiveAssistantMessageIdForTurn(thread.id, turnId)
          : Option.none<MessageId>();

        const hasAssistantMessagesForTurn =
          turnId !== undefined
            ? yield* projectionThreadMessages.hasAssistantMessageForTurn({
                threadId: thread.id,
                turnId,
                streamingOnly: false,
              })
            : false;

        const assistantMessageId = Option.getOrElse(
          activeAssistantMessageId,
          () => assistantCompletion.messageId,
        );

        const existingAssistantMessage = yield* getThreadMessageById(thread.id, assistantMessageId);

        const shouldApplyFallbackCompletionText =
          !existingAssistantMessage || existingAssistantMessage.text.length === 0;

        const shouldSkipRedundantCompletion =
          Option.isNone(activeAssistantMessageId) &&
          turnId !== undefined &&
          hasAssistantMessagesForTurn &&
          (assistantCompletion.fallbackText?.trim().length ?? 0) === 0;

        if (!shouldSkipRedundantCompletion) {
          if (turnId && Option.isNone(activeAssistantMessageId)) {
            yield* rememberAssistantMessageId(thread.id, turnId, assistantMessageId);
          }

          yield* finalizeAssistantMessage({
            event,
            threadId: thread.id,
            messageId: assistantMessageId,
            ...(turnId ? { turnId } : {}),
            createdAt: now,
            commandTag: "assistant-complete",
            finalDeltaCommandTag: "assistant-delta-finalize",
            hasProjectedMessage: existingAssistantMessage !== undefined,
            ...(assistantCompletion.fallbackText !== undefined && shouldApplyFallbackCompletionText
              ? { fallbackText: assistantCompletion.fallbackText }
              : {}),
          });

          if (turnId) {
            yield* forgetAssistantMessageId(thread.id, turnId, assistantMessageId);
          }
        }

        if (turnId) {
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);
        }
      }

      if (proposedPlanCompletion) {
        yield* finalizeBufferedProposedPlan({
          event,
          threadId: thread.id,
          planId: proposedPlanCompletion.planId,
          ...(proposedPlanCompletion.turnId ? { turnId: proposedPlanCompletion.turnId } : {}),
          fallbackMarkdown: proposedPlanCompletion.planMarkdown,
          updatedAt: now,
        });
      }

      if (event.type === "turn.completed" || event.type === "turn.aborted") {
        const turnId = toTurnId(event.turnId);

        if (turnId) {
          yield* resolveNativeUserInputForTerminalTurn({
            event,
            threadId: thread.id,
            turnId,
            now,
          });
        }
      }

      if (event.type === "turn.completed") {
        const turnId = toTurnId(event.turnId);

        if (turnId) {
          const assistantMessageIds = yield* getAssistantMessageIdsForTurn(thread.id, turnId);

          const finalizedReplyVisibility = yield* Effect.forEach(
            assistantMessageIds,
            (assistantMessageId) =>
              Effect.gen(function* () {
                const existing = yield* getThreadMessageById(thread.id, assistantMessageId);

                return yield* finalizeAssistantMessage({
                  event,
                  threadId: thread.id,
                  messageId: assistantMessageId,
                  turnId,
                  createdAt: now,
                  commandTag: "assistant-complete-finalize",
                  finalDeltaCommandTag: "assistant-delta-finalize-fallback",
                  hasProjectedMessage: existing !== undefined,
                });
              }),
            { concurrency: 1 },
          );

          yield* clearAssistantMessageIdsForTurn(thread.id, turnId);
          yield* clearAssistantSegmentStateForTurn(thread.id, turnId);

          yield* finalizeBufferedProposedPlan({
            event,
            threadId: thread.id,
            planId: proposedPlanIdForTurn(thread.id, turnId),
            turnId,
            updatedAt: now,
          });

          const hasVisibleAssistantReply =
            yield* projectionThreadMessages.hasAssistantMessageForTurn({
              threadId: thread.id,
              turnId,
              streamingOnly: false,
            });

          if (!hasVisibleAssistantReply && !finalizedReplyVisibility.some(Boolean)) {
            const fallbackText =
              event.payload.state === "failed"
                ? "I cannot complete the request. Check the error details."
                : "I finished without a text response. Please try again.";

            yield* finalizeAssistantMessage({
              event,
              threadId: thread.id,
              messageId: MessageId.make(`assistant:${event.eventId}:fallback`),
              turnId,
              createdAt: now,
              commandTag: "assistant-empty-turn-complete",
              finalDeltaCommandTag: "assistant-empty-turn-delta",
              hasProjectedMessage: false,
              fallbackText,
            });
          }
        }
      }

      if (event.type === "session.exited") {
        yield* clearTurnStateForSession(thread.id);
      }

      if (event.type === "runtime.error") {
        const runtimeErrorMessage = event.payload.message;

        const shouldApplyRuntimeError = !STRICT_PROVIDER_LIFECYCLE_GUARD
          ? true
          : activeTurnId === null || eventTurnId === undefined || sameId(activeTurnId, eventTurnId);

        if (shouldApplyRuntimeError) {
          yield* orchestrationEngine.dispatch({
            type: "thread.session.set",
            commandId: yield* providerCommandId(event, "runtime-error-session-set"),
            threadId: thread.id,
            session: {
              threadId: thread.id,
              status: "error",
              providerName: event.provider,
              ...(event.providerInstanceId !== undefined
                ? { providerInstanceId: event.providerInstanceId }
                : {}),
              runtimeMode: thread.session?.runtimeMode ?? "full-access",
              mcpServerIds: thread.session?.mcpServerIds ?? [],
              activeTurnId: eventTurnId ?? null,
              lastError: runtimeErrorMessage,
              updatedAt: now,
            },
            createdAt: now,
          });
        }
      }

      if (event.type === "turn.diff.updated") {
        const turnId = toTurnId(event.turnId);

        const checkpointContext = turnId
          ? yield* projectionSnapshotQuery
              .getThreadCheckpointContext(thread.id)
              .pipe(Effect.map(Option.getOrUndefined))
          : undefined;

        const workspaceCwd =
          checkpointContext?.worktreePath ?? checkpointContext?.workspaceRoot ?? undefined;

        if (
          turnId &&
          checkpointContext &&
          workspaceCwd &&
          (yield* checkpointStore
            .isGitRepository(workspaceCwd)
            .pipe(Effect.orElseSucceed(() => false)))
        ) {
          // Skip if a checkpoint already exists for this turn. A real
          // (non-placeholder) capture from CheckpointReactor should not
          // be clobbered, and dispatching a duplicate placeholder for the
          // same turnId would produce an unstable checkpointTurnCount.
          if (hasCheckpointForTurn(checkpointContext.checkpoints, turnId)) {
            // Already tracked; no-op.
          } else {
            const assistantMessageId = MessageId.make(
              `assistant:${event.itemId ?? event.turnId ?? event.eventId}`,
            );

            yield* orchestrationEngine.dispatch({
              type: "thread.turn.diff.complete",
              commandId: yield* providerCommandId(event, "thread-turn-diff-complete"),
              threadId: thread.id,
              turnId,
              completedAt: now,
              checkpointRef: CheckpointRef.make(`provider-diff:${event.eventId}`),
              status: "missing",
              files: [],
              assistantMessageId,
              checkpointTurnCount: maxCheckpointTurnCount(checkpointContext.checkpoints) + 1,
              createdAt: now,
            });
          }
        }
      }

      if (event.type === "task.started" || event.type === "task.progress") {
        const description = event.payload.description?.trim();

        if (description) {
          yield* rememberTaskDescription(thread.id, event.payload.taskId, description);
        }
      }

      // Working-indicator plan progress: current step while the turn runs,
      // cleared on settle so a finished plan never lingers as stale UI.
      // Events carrying a turn id that conflicts with the active turn are
      // stale (superseded turn) and must neither overwrite nor clear the
      // active turn's progress; session.exited always clears.
      if (event.type === "session.exited") {
        threadPlanProgress.clearThreadPlanProgress(thread.id);
      } else if (!conflictsWithActiveTurn) {
        if (event.type === "turn.plan.updated") {
          threadPlanProgress.recordPlanProgress(thread.id, event.payload.plan);
        } else if (event.type === "turn.completed" || event.type === "turn.aborted") {
          threadPlanProgress.clearThreadPlanProgress(thread.id);
        }
      }

      // Sidebar background liveness: fed from the same lifecycle stream,
      // read by the shell query at mapping time (no persistence).
      switch (event.type) {
        case "task.started":
        case "task.progress":
        case "task.updated":
        case "task.completed": {
          const payload = event.payload as {
            taskId: string;
            taskType?: string;
            status?: string;
            agentId?: string;
          };

          threadBackgroundLiveness.recordTaskLiveness({
            threadId: thread.id,
            taskId: payload.taskId,
            taskType: payload.taskType,
            status: payload.status,
            agentId: payload.agentId,
            kind:
              event.type === "task.started"
                ? "started"
                : event.type === "task.progress"
                  ? "progress"
                  : event.type === "task.updated"
                    ? "updated"
                    : "completed",
          });
          break;
        }

        case "session.exited":
          threadBackgroundLiveness.clearThreadLiveness(thread.id);
          break;
        default:
          break;
      }

      let taskTitle: string | undefined;

      if (event.type === "task.completed") {
        taskTitle = yield* lookupTaskDescription(thread.id, event.payload.taskId);

        if (!taskTitle) {
          const latestTask = yield* projectionThreadActivities.getLatestTaskActivity({
            threadId: thread.id,
            taskId: event.payload.taskId,
          });

          taskTitle = findTaskTitleInActivities(
            Option.match(latestTask, { onNone: () => [], onSome: (activity) => [activity] }),
            event.payload.taskId,
          );
        }
      }

      const activities = runtimeEventToActivities(event, taskTitle);
      yield* Effect.forEach(activities, (activity) =>
        providerCommandId(event, "thread-activity-append").pipe(
          Effect.flatMap((commandId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId,
              threadId: thread.id,
              activity,
              createdAt: activity.createdAt,
            }),
          ),
        ),
      ).pipe(Effect.asVoid);

      if (
        shouldApplyThreadLifecycle &&
        !conflictsWithActiveTurn &&
        (event.type === "turn.completed" ||
          event.type === "turn.aborted" ||
          event.type === "session.exited" ||
          (event.type === "session.state.changed" &&
            (event.payload.state === "error" || event.payload.state === "stopped")))
      ) {
        const terminalTurnId = eventTurnId ?? activeTurnId ?? undefined;

        if (terminalTurnId) {
          channelWaitingRequests.delete(providerTurnKey(thread.id, terminalTurnId));
        }

        yield* channelStatusWorker.enqueue({
          threadId: thread.id,
          turnId: terminalTurnId,
          ...(activeTurnId === null && Option.isSome(pendingTurnStart)
            ? { requestMessageId: pendingTurnStart.value.messageId }
            : {}),
          state:
            event.type === "turn.completed"
              ? event.payload.state === "completed"
                ? "completed"
                : event.payload.state === "failed"
                  ? "failed"
                  : "cancelled"
              : event.type === "session.state.changed" && event.payload.state === "error"
                ? "failed"
                : "cancelled",
        });
      }

      if (
        event.type === "turn.completed" &&
        event.payload.state === "completed" &&
        shouldApplyThreadLifecycle &&
        eventTurnId &&
        channelRuntime
      ) {
        const target = yield* channelRuntime
          .resolveCompletedChannelReply(thread.id, eventTurnId)
          .pipe(Effect.orDie);

        if (target) yield* automaticChannelReplyWorker.enqueue(target);
      }
    });

  return { processRuntimeEvent };
}
