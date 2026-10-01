import { type OrchestrationEvent, type ProviderRuntimeEvent } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { makeDrainableWorker } from "@akeru/shared/DrainableWorker";
import { CheckpointReactor, type CheckpointReactorShape } from "../Services/CheckpointReactor.ts";
import { forkParked } from "../../serverActivation.ts";
import type { CheckpointStoreError } from "../../checkpointing/Errors.ts";
import type { OrchestrationDispatchError } from "../Errors.ts";
import { nowIso, toTurnId, sameId, type ReactorInput } from "./checkpoint-reactor/Fields.ts";
import { createDependencies } from "./checkpoint-reactor/Dependencies.ts";
import { createFailures } from "./checkpoint-reactor/Failures.ts";
import { createContext } from "./checkpoint-reactor/Context.ts";
import { createCapture } from "./checkpoint-reactor/Capture.ts";
import { createWorkspace } from "./checkpoint-reactor/Workspace.ts";
import { createRevert } from "./checkpoint-reactor/Revert.ts";

const make = Effect.gen(function* () {
  const {
    randomUUID,
    serverEventId,
    serverCommandId,
    orchestrationEngine,
    projectionSnapshotQuery,
    agentController,
    checkpointStore,
    receiptBus,
    workspaceEntries,
    git,
    startedTurns,
    pending,
  } = yield* createDependencies();
  const { appendRevertFailureActivity, appendCaptureFailureActivity } = createFailures({
    serverCommandId,
    serverEventId,
    orchestrationEngine,
  });
  const { resolveSessionRuntimeForThread, resolveThreadCheckpointState } = createContext({
    agentController,
    projectionSnapshotQuery,
  });
  const {
    captureCheckpointFromTurnCompletion,
    ensurePreTurnBaselineFromTurnStart,
    ensurePreTurnBaselineFromDomainTurnStart,
  } = createCapture({
    projectionSnapshotQuery,
    resolveSessionRuntimeForThread,
    checkpointStore,
    workspaceEntries,
    appendCaptureFailureActivity,
    orchestrationEngine,
    serverCommandId,
    receiptBus,
    randomUUID,
    resolveThreadCheckpointState,
  });
  const { statusRefreshWorker } = yield* createWorkspace({
    resolveSessionRuntimeForThread,
    git,
    projectionSnapshotQuery,
    orchestrationEngine,
    serverCommandId,
  });
  const { handleRevertRequested } = createRevert({
    resolveThreadCheckpointState,
    appendRevertFailureActivity,
    resolveSessionRuntimeForThread,
    checkpointStore,
    workspaceEntries,
    agentController,
    orchestrationEngine,
    serverCommandId,
  });
  const processDomainEvent = Effect.fn("processDomainEvent")(function* (event: OrchestrationEvent) {
    if (event.type === "thread.turn-start-requested" || event.type === "thread.message-sent") {
      if (event.type === "thread.turn-start-requested") pending.add(event.payload.threadId);
      yield* ensurePreTurnBaselineFromDomainTurnStart(event);
      return;
    }

    if (event.type === "thread.checkpoint-revert-requested") {
      yield* handleRevertRequested(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendRevertFailureActivity({
              threadId: event.payload.threadId,
              turnCount: event.payload.turnCount,
              detail: error.message,
              createdAt,
            }),
          ),
        ),
      );
    }
  });

  const processRuntimeEvent = Effect.fn("processRuntimeEvent")(function* (
    event: ProviderRuntimeEvent,
  ) {
    if (event.type === "session.exited") {
      startedTurns.delete(event.threadId);
      pending.delete(event.threadId);
      return;
    }

    if (event.type === "turn.started") {
      const turnId = toTurnId(event.turnId);
      const activeTurnId = (yield* agentController.listSessions()).find((session) =>
        sameId(session.threadId, event.threadId),
      )?.activeTurnId;
      const mayReplace = pending.has(event.threadId) && sameId(activeTurnId, turnId);
      if (turnId !== null && (!startedTurns.has(event.threadId) || mayReplace)) {
        startedTurns.set(event.threadId, turnId);
        pending.delete(event.threadId);
      }
      yield* ensurePreTurnBaselineFromTurnStart(event);
      return;
    }

    if (event.type === "turn.completed" || event.type === "turn.aborted") {
      const turnId = toTurnId(event.turnId);
      const thread = yield* projectionSnapshotQuery
        .getThreadRuntimeContext(event.threadId)
        .pipe(Effect.map(Option.getOrUndefined));
      const startedTurnId = startedTurns.get(event.threadId);
      const isTrackedTurn = sameId(startedTurnId, turnId);
      if (isTrackedTurn) startedTurns.delete(event.threadId);
      if (event.type === "turn.completed") {
        yield* statusRefreshWorker.enqueue(event);
      }
      if (isTrackedTurn || sameId(thread?.session?.activeTurnId, turnId)) {
        pending.delete(event.threadId);
      }
      if (
        event.type === "turn.aborted" &&
        !isTrackedTurn &&
        !sameId(thread?.session?.activeTurnId, turnId)
      ) {
        return;
      }
      yield* captureCheckpointFromTurnCompletion(event).pipe(
        Effect.catch((error) =>
          Effect.flatMap(nowIso, (createdAt) =>
            appendCaptureFailureActivity({
              threadId: event.threadId,
              turnId,
              detail: error.message,
              createdAt,
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        ),
      );
      return;
    }
  });

  const processInput = (
    input: ReactorInput,
  ): Effect.Effect<
    void,
    CheckpointStoreError | OrchestrationDispatchError | PlatformError.PlatformError,
    never
  > =>
    input.source === "domain" ? processDomainEvent(input.event) : processRuntimeEvent(input.event);

  const processInputSafely = (input: ReactorInput) =>
    processInput(input).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.failCause(cause);
        }
        return Effect.logWarning("checkpoint reactor failed to process input", {
          source: input.source,
          eventType: input.event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const worker = yield* makeDrainableWorker(processInputSafely);

  const start: CheckpointReactorShape["start"] = Effect.fn("start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.turn-start-requested" &&
          event.type !== "thread.message-sent" &&
          event.type !== "thread.checkpoint-revert-requested"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "domain", event });
      }),
    );

    yield* forkParked(
      Stream.runForEach(agentController.streamEvents, (event) => {
        if (
          event.type !== "turn.started" &&
          event.type !== "turn.completed" &&
          event.type !== "turn.aborted" &&
          event.type !== "session.exited"
        ) {
          return Effect.void;
        }
        return worker.enqueue({ source: "runtime", event });
      }),
    );
  });

  return {
    start,
    drain: worker.drain.pipe(Effect.andThen(statusRefreshWorker.drain)),
  } satisfies CheckpointReactorShape;
});
export const CheckpointReactorLive = Layer.effect(CheckpointReactor, make);
