import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { settledTurnStateForSessionStatus } from "../../TurnSessionState.ts";
import { type ProjectionDependencies, type ProjectorDefinition } from "./Definitions.ts";

export function createTurns({
  projectionThreadSessionRepository,
  projectionTurnRepository,
}: Pick<ProjectionDependencies, "projectionThreadSessionRepository" | "projectionTurnRepository">) {
  const applyThreadSessionsProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyThreadSessionsProjection",
  )(function* (event, _attachmentSideEffects) {
    if (event.type === "thread.created") {
      yield* projectionThreadSessionRepository.deleteByThreadId({
        threadId: event.payload.threadId,
      });
      return;
    }
    if (event.type === "thread.turn-resume-requested") {
      const existing = yield* projectionThreadSessionRepository.getByThreadId({
        threadId: event.payload.threadId,
      });
      if (Option.isNone(existing)) return;
      yield* projectionThreadSessionRepository.upsert({
        ...existing.value,
        status: "starting",
        lastError: null,
        updatedAt: event.payload.createdAt,
      });
      return;
    }
    if (event.type !== "thread.session-set") {
      return;
    }
    yield* projectionThreadSessionRepository.upsert({
      threadId: event.payload.threadId,
      status: event.payload.session.status,
      providerName: event.payload.session.providerName,
      providerInstanceId: event.payload.session.providerInstanceId ?? null,
      runtimeMode: event.payload.session.runtimeMode,
      mcpServerIds: [...(event.payload.session.mcpServerIds ?? [])],
      activeTurnId: event.payload.session.activeTurnId,
      lastError: event.payload.session.lastError,
      updatedAt: event.payload.session.updatedAt,
    });
  });

  const applyThreadTurnsProjection: ProjectorDefinition["apply"] = Effect.fn(
    "applyThreadTurnsProjection",
  )(function* (event, _attachmentSideEffects) {
    switch (event.type) {
      case "thread.created":
        yield* projectionTurnRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        return;

      case "thread.turn-start-requested": {
        yield* projectionTurnRepository.replacePendingTurnStart({
          threadId: event.payload.threadId,
          messageId: event.payload.messageId,
          respondingBotId: event.payload.respondingBotId ?? null,
          sourceProposedPlanThreadId: event.payload.sourceProposedPlan?.threadId ?? null,
          sourceProposedPlanId: event.payload.sourceProposedPlan?.planId ?? null,
          requestedAt: event.payload.createdAt,
        });
        return;
      }

      case "thread.session-set": {
        const turnId = event.payload.session.activeTurnId;
        if (turnId === null || event.payload.session.status !== "running") {
          if (
            event.payload.session.status === "error" ||
            event.payload.session.status === "stopped" ||
            event.payload.session.status === "interrupted"
          ) {
            yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
              threadId: event.payload.threadId,
            });
          }
          // Leaving the "running" session status is the turn-end signal:
          // settle still-running turns so their duration reflects the whole
          // turn rather than the last assistant message.
          const settledTurnState = settledTurnStateForSessionStatus(event.payload.session.status);
          if (settledTurnState === null) {
            return;
          }
          const existingTurns = yield* projectionTurnRepository.listByThreadId({
            threadId: event.payload.threadId,
          });
          yield* Effect.forEach(
            existingTurns.filter((turn) => turn.turnId !== null && turn.state === "running"),
            (turn) =>
              turn.turnId === null
                ? Effect.void
                : projectionTurnRepository.upsertByTurnId({
                    ...turn,
                    turnId: turn.turnId,
                    state: settledTurnState,
                    // A running turn's completedAt can only hold a mid-turn
                    // placeholder checkpoint timestamp — the session leaving
                    // "running" is the authoritative turn end.
                    completedAt: event.payload.session.updatedAt,
                  }),
            { concurrency: 1 },
          );
          return;
        }

        // A new active turn supersedes any still-running turn on the same
        // thread — steering can open a new turn without the provider ever
        // completing the previous one.
        const otherRunningTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(
          otherRunningTurns.filter(
            (turn) => turn.turnId !== null && turn.turnId !== turnId && turn.state === "running",
          ),
          (turn) =>
            turn.turnId === null
              ? Effect.void
              : projectionTurnRepository.upsertByTurnId({
                  ...turn,
                  turnId: turn.turnId,
                  state: "completed",
                  completedAt: event.payload.session.updatedAt,
                }),
          { concurrency: 1 },
        );

        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId,
        });
        const pendingTurnStart = yield* projectionTurnRepository.getPendingTurnStartByThreadId({
          threadId: event.payload.threadId,
        });
        if (Option.isSome(existingTurn)) {
          const nextState =
            existingTurn.value.state === "completed" || existingTurn.value.state === "error"
              ? existingTurn.value.state
              : "running";
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            state: nextState,
            pendingMessageId:
              existingTurn.value.pendingMessageId ??
              (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.messageId : null),
            sourceProposedPlanThreadId:
              existingTurn.value.sourceProposedPlanThreadId ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanThreadId
                : null),
            sourceProposedPlanId:
              existingTurn.value.sourceProposedPlanId ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.sourceProposedPlanId
                : null),
            respondingBotId:
              existingTurn.value.respondingBotId ??
              (Option.isSome(pendingTurnStart) ? pendingTurnStart.value.respondingBotId : null),
            startedAt:
              existingTurn.value.startedAt ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt),
            requestedAt:
              existingTurn.value.requestedAt ??
              (Option.isSome(pendingTurnStart)
                ? pendingTurnStart.value.requestedAt
                : event.occurredAt),
          });
        } else {
          yield* projectionTurnRepository.upsertByTurnId({
            turnId,
            threadId: event.payload.threadId,
            pendingMessageId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.messageId
              : null,
            sourceProposedPlanThreadId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.sourceProposedPlanThreadId
              : null,
            sourceProposedPlanId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.sourceProposedPlanId
              : null,
            assistantMessageId: null,
            respondingBotId: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.respondingBotId
              : null,
            state: "running",
            requestedAt: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.requestedAt
              : event.occurredAt,
            startedAt: Option.isSome(pendingTurnStart)
              ? pendingTurnStart.value.requestedAt
              : event.occurredAt,
            completedAt: null,
            checkpointTurnCount: null,
            checkpointRef: null,
            checkpointStatus: null,
            checkpointFiles: [],
          });
        }

        yield* projectionTurnRepository.deletePendingTurnStartByThreadId({
          threadId: event.payload.threadId,
        });
        return;
      }

      case "thread.message-sent": {
        if (event.payload.turnId === null || event.payload.role !== "assistant") {
          return;
        }
        // A completed assistant message only settles the turn once the
        // session is no longer running it — providers may emit several
        // assistant messages per turn (commentary between tool calls), and
        // the turn must stay unsettled until the provider reports turn end
        // (projected as thread.session-set leaving the "running" status).
        const session = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        const turnStillRunning =
          Option.isSome(session) &&
          session.value.status === "running" &&
          session.value.activeTurnId === event.payload.turnId;
        const settlesTurn = !event.payload.streaming && !turnStillRunning;
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            assistantMessageId: event.payload.messageId,
            respondingBotId:
              existingTurn.value.respondingBotId ?? event.payload.respondingBotId ?? null,
            state: settlesTurn
              ? existingTurn.value.state === "interrupted"
                ? "interrupted"
                : existingTurn.value.state === "error"
                  ? "error"
                  : "completed"
              : existingTurn.value.state,
            completedAt: settlesTurn
              ? (existingTurn.value.completedAt ?? event.payload.updatedAt)
              : existingTurn.value.completedAt,
            startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
          });
          return;
        }
        yield* projectionTurnRepository.upsertByTurnId({
          turnId: event.payload.turnId,
          threadId: event.payload.threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: event.payload.messageId,
          respondingBotId: event.payload.respondingBotId ?? null,
          state: settlesTurn ? "completed" : "running",
          requestedAt: event.payload.createdAt,
          startedAt: event.payload.createdAt,
          completedAt: settlesTurn ? event.payload.updatedAt : null,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        return;
      }

      case "thread.turn-interrupt-requested": {
        if (event.payload.turnId === undefined) {
          return;
        }
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            state: "interrupted",
            completedAt: existingTurn.value.completedAt ?? event.payload.createdAt,
            startedAt: existingTurn.value.startedAt ?? event.payload.createdAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.createdAt,
          });
          return;
        }
        yield* projectionTurnRepository.upsertByTurnId({
          turnId: event.payload.turnId,
          threadId: event.payload.threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: null,
          respondingBotId: null,
          state: "interrupted",
          requestedAt: event.payload.createdAt,
          startedAt: event.payload.createdAt,
          completedAt: event.payload.createdAt,
          checkpointTurnCount: null,
          checkpointRef: null,
          checkpointStatus: null,
          checkpointFiles: [],
        });
        return;
      }

      case "thread.turn-diff-completed": {
        // Mid-turn diff updates produce placeholder checkpoints; record the
        // checkpoint, but don't settle a turn its session is still running.
        const session = yield* projectionThreadSessionRepository.getByThreadId({
          threadId: event.payload.threadId,
        });
        const turnStillRunning =
          Option.isSome(session) &&
          session.value.status === "running" &&
          session.value.activeTurnId === event.payload.turnId;
        const existingTurn = yield* projectionTurnRepository.getByTurnId({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
        });
        const nextState = event.payload.status === "error" ? "error" : "completed";
        yield* projectionTurnRepository.clearCheckpointTurnConflict({
          threadId: event.payload.threadId,
          turnId: event.payload.turnId,
          checkpointTurnCount: event.payload.checkpointTurnCount,
        });

        if (Option.isSome(existingTurn)) {
          yield* projectionTurnRepository.upsertByTurnId({
            ...existingTurn.value,
            assistantMessageId: event.payload.assistantMessageId,
            state:
              turnStillRunning || existingTurn.value.state === "interrupted"
                ? existingTurn.value.state
                : nextState,
            checkpointTurnCount: event.payload.checkpointTurnCount,
            checkpointRef: event.payload.checkpointRef,
            checkpointStatus: event.payload.status,
            checkpointFiles: event.payload.files,
            startedAt: existingTurn.value.startedAt ?? event.payload.completedAt,
            requestedAt: existingTurn.value.requestedAt ?? event.payload.completedAt,
            completedAt: event.payload.completedAt,
          });
          return;
        }
        yield* projectionTurnRepository.upsertByTurnId({
          turnId: event.payload.turnId,
          threadId: event.payload.threadId,
          pendingMessageId: null,
          sourceProposedPlanThreadId: null,
          sourceProposedPlanId: null,
          assistantMessageId: event.payload.assistantMessageId,
          respondingBotId: null,
          state: turnStillRunning ? "running" : nextState,
          requestedAt: event.payload.completedAt,
          startedAt: event.payload.completedAt,
          completedAt: event.payload.completedAt,
          checkpointTurnCount: event.payload.checkpointTurnCount,
          checkpointRef: event.payload.checkpointRef,
          checkpointStatus: event.payload.status,
          checkpointFiles: event.payload.files,
        });
        return;
      }

      case "thread.reverted": {
        const existingTurns = yield* projectionTurnRepository.listByThreadId({
          threadId: event.payload.threadId,
        });
        const keptTurns = existingTurns.filter(
          (turn) =>
            turn.turnId !== null &&
            turn.checkpointTurnCount !== null &&
            turn.checkpointTurnCount <= event.payload.turnCount,
        );
        yield* projectionTurnRepository.deleteByThreadId({
          threadId: event.payload.threadId,
        });
        yield* Effect.forEach(
          keptTurns,
          (turn) =>
            turn.turnId === null
              ? Effect.void
              : projectionTurnRepository.upsertByTurnId({
                  ...turn,
                  turnId: turn.turnId,
                }),
          { concurrency: 1 },
        ).pipe(Effect.asVoid);
        return;
      }

      default:
        return;
    }
  });

  const applyCheckpointsProjection: ProjectorDefinition["apply"] = () => Effect.void;
  return { applyThreadSessionsProjection, applyThreadTurnsProjection, applyCheckpointsProjection };
}
