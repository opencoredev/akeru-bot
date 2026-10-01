import {
  OrchestrationCheckpointSummary,
  OrchestrationSession,
  ThreadTurnResumeRequestedPayload,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import {
  ThreadActivityAppendedPayload,
  ThreadRevertedPayload,
  ThreadSessionSetPayload,
  ThreadTurnDiffCompletedPayload,
  ThreadTurnStartRequestedPayload,
} from "../Schemas.ts";
import { settledTurnStateForSessionStatus } from "../TurnSessionState.ts";
import type { OrchestrationReadModel, OrchestrationEvent } from "@akeru/contracts";
import type { OrchestrationProjectorDecodeError } from "../Errors.ts";
import {
  decodeForEvent,
  updateThread,
  findProjectedThread,
  MAX_THREAD_CHECKPOINTS,
  checkpointStatusToLatestTurnState,
  retainThreadMessagesAfterRevert,
  MAX_THREAD_MESSAGES,
  retainThreadProposedPlansAfterRevert,
  retainThreadActivitiesAfterRevert,
  compareThreadActivities,
  MAX_THREAD_ACTIVITIES,
} from "./Updates.ts";

export function projectThreadHistory(
  nextBase: OrchestrationReadModel,
  event: OrchestrationEvent,
): Effect.Effect<OrchestrationReadModel, OrchestrationProjectorDecodeError> {
  switch (event.type) {
    case "thread.turn-start-requested":
      return decodeForEvent(
        ThreadTurnStartRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => ({
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            respondingBotId: payload.respondingBotId ?? null,
            updatedAt: event.occurredAt,
          }),
        })),
      );
    case "thread.turn-resume-requested":
      return decodeForEvent(
        ThreadTurnResumeRequestedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = findProjectedThread(nextBase.threads, payload.threadId);

          if (!thread?.session) return nextBase;
          const { unavailability: _staleUnavailability, ...session } = thread.session;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              session: {
                ...session,
                status: "starting",
                lastError: null,
                updatedAt: payload.createdAt,
              },
              updatedAt: payload.createdAt,
            }),
          };
        }),
      );
    case "thread.session-set":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadSessionSetPayload,
          event.payload,
          event.type,
          "payload",
        );

        const thread = findProjectedThread(nextBase.threads, payload.threadId);

        if (!thread) {
          return nextBase;
        }

        const session: OrchestrationSession = yield* decodeForEvent(
          OrchestrationSession,
          payload.session,
          event.type,
          "session",
        );

        // Leaving the "running" session status is the turn-end signal: settle
        // a still-running latest turn so its duration reflects the whole turn.
        const settledTurnState = settledTurnStateForSessionStatus(session.status);

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            session,
            latestTurn:
              session.status === "running" && session.activeTurnId !== null
                ? {
                    turnId: session.activeTurnId,
                    state: "running",
                    requestedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.requestedAt
                        : session.updatedAt,
                    startedAt:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? (thread.latestTurn.startedAt ?? session.updatedAt)
                        : session.updatedAt,
                    completedAt: null,
                    assistantMessageId:
                      thread.latestTurn?.turnId === session.activeTurnId
                        ? thread.latestTurn.assistantMessageId
                        : null,
                    respondingBotId: thread.respondingBotId ?? null,
                    ...(session.lastError ? { errorMessage: session.lastError } : {}),
                    ...(session.unavailability ? { unavailability: session.unavailability } : {}),
                  }
                : thread.latestTurn !== null &&
                    thread.latestTurn.state === "running" &&
                    settledTurnState !== null
                  ? {
                      ...thread.latestTurn,
                      state: settledTurnState,
                      ...(session.lastError ? { errorMessage: session.lastError } : {}),
                      ...(session.unavailability ? { unavailability: session.unavailability } : {}),
                      // A running turn's completedAt can only hold a mid-turn
                      // placeholder checkpoint timestamp — the session leaving
                      // "running" is the authoritative turn end.
                      completedAt: session.updatedAt,
                    }
                  : thread.latestTurn,
            updatedAt: event.occurredAt,
          }),
        };
      });
    case "thread.turn-diff-completed":
      return Effect.gen(function* () {
        const payload = yield* decodeForEvent(
          ThreadTurnDiffCompletedPayload,
          event.payload,
          event.type,
          "payload",
        );

        const thread = findProjectedThread(nextBase.threads, payload.threadId);

        if (!thread) {
          return nextBase;
        }

        const checkpoint = yield* decodeForEvent(
          OrchestrationCheckpointSummary,
          {
            turnId: payload.turnId,
            checkpointTurnCount: payload.checkpointTurnCount,
            checkpointRef: payload.checkpointRef,
            status: payload.status,
            files: payload.files,
            assistantMessageId: payload.assistantMessageId,
            completedAt: payload.completedAt,
          },
          event.type,
          "checkpoint",
        );

        // Do not let a placeholder (status "missing") overwrite a checkpoint
        // that has already been captured with a real git ref (status "ready").
        // ProviderRuntimeIngestion may fire multiple turn.diff.updated events
        // per turn; without this guard later placeholders would clobber the
        // real capture dispatched by CheckpointReactor.
        const existing = thread.checkpoints.find((entry) => entry.turnId === checkpoint.turnId);

        if (existing && existing.status !== "missing" && checkpoint.status === "missing") {
          return nextBase;
        }

        const checkpoints = [
          ...thread.checkpoints.filter((entry) => entry.turnId !== checkpoint.turnId),
          checkpoint,
        ]
          .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
          .slice(-MAX_THREAD_CHECKPOINTS);

        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const turnStillRunning =
          thread.session?.status === "running" && thread.session.activeTurnId === payload.turnId;

        return {
          ...nextBase,
          threads: updateThread(nextBase.threads, payload.threadId, {
            checkpoints,
            latestTurn: turnStillRunning
              ? thread.latestTurn
              : {
                  turnId: payload.turnId,
                  state:
                    thread.latestTurn?.turnId === payload.turnId &&
                    thread.latestTurn.state === "interrupted"
                      ? "interrupted"
                      : checkpointStatusToLatestTurnState(payload.status),
                  requestedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? thread.latestTurn.requestedAt
                      : payload.completedAt,
                  startedAt:
                    thread.latestTurn?.turnId === payload.turnId
                      ? (thread.latestTurn.startedAt ?? payload.completedAt)
                      : payload.completedAt,
                  completedAt: payload.completedAt,
                  assistantMessageId: payload.assistantMessageId,
                  respondingBotId: thread.respondingBotId ?? null,
                },
            updatedAt: event.occurredAt,
          }),
        };
      });
    case "thread.reverted":
      return decodeForEvent(ThreadRevertedPayload, event.payload, event.type, "payload").pipe(
        Effect.map((payload) => {
          const thread = findProjectedThread(nextBase.threads, payload.threadId);

          if (!thread) {
            return nextBase;
          }

          const checkpoints = thread.checkpoints
            .filter((entry) => entry.checkpointTurnCount <= payload.turnCount)
            .toSorted((left, right) => left.checkpointTurnCount - right.checkpointTurnCount)
            .slice(-MAX_THREAD_CHECKPOINTS);

          const retainedTurnIds = new Set(checkpoints.map((checkpoint) => checkpoint.turnId));

          const messages = retainThreadMessagesAfterRevert(
            thread.messages,
            retainedTurnIds,
            payload.turnCount,
          ).slice(-MAX_THREAD_MESSAGES);

          const proposedPlans = retainThreadProposedPlansAfterRevert(
            thread.proposedPlans,
            retainedTurnIds,
          ).slice(-200);

          const activities = retainThreadActivitiesAfterRevert(thread.activities, retainedTurnIds);

          const latestCheckpoint = checkpoints.at(-1) ?? null;

          const latestTurn =
            latestCheckpoint === null
              ? null
              : {
                  turnId: latestCheckpoint.turnId,
                  state: checkpointStatusToLatestTurnState(latestCheckpoint.status),
                  requestedAt: latestCheckpoint.completedAt,
                  startedAt: latestCheckpoint.completedAt,
                  completedAt: latestCheckpoint.completedAt,
                  assistantMessageId: latestCheckpoint.assistantMessageId,
                };

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              checkpoints,
              messages,
              proposedPlans,
              activities,
              latestTurn,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );
    case "thread.activity-appended":
      return decodeForEvent(
        ThreadActivityAppendedPayload,
        event.payload,
        event.type,
        "payload",
      ).pipe(
        Effect.map((payload) => {
          const thread = findProjectedThread(nextBase.threads, payload.threadId);

          if (!thread) {
            return nextBase;
          }

          // Activities stay sorted, so an in-order new activity is a plain append.
          const lastActivity = thread.activities.at(-1);

          const appendsInOrder =
            (lastActivity === undefined ||
              compareThreadActivities(lastActivity, payload.activity) <= 0) &&
            !thread.activities.some((entry) => entry.id === payload.activity.id);

          const sortedActivities = appendsInOrder
            ? [...thread.activities, payload.activity]
            : [
                ...thread.activities.filter((entry) => entry.id !== payload.activity.id),
                payload.activity,
              ].toSorted(compareThreadActivities);

          const activities =
            sortedActivities.length > MAX_THREAD_ACTIVITIES
              ? sortedActivities.slice(-MAX_THREAD_ACTIVITIES)
              : sortedActivities;

          return {
            ...nextBase,
            threads: updateThread(nextBase.threads, payload.threadId, {
              activities,
              updatedAt: event.occurredAt,
            }),
          };
        }),
      );
    default:
      throw new Error("Unexpected projector event: " + event.type);
  }
}
