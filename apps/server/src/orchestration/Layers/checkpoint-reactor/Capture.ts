import {
  EventId,
  MessageId,
  type ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationEvent,
  type ProviderRuntimeEvent,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { parseTurnDiffFilesFromNumstat } from "../../../checkpointing/Diffs.ts";
import {
  checkpointRefForThreadTurn,
  resolveThreadWorkspaceCwd,
} from "../../../checkpointing/Utils.ts";
import type { CheckpointStoreError } from "../../../checkpointing/Errors.ts";
import { toTurnId, sameId, checkpointStatusFromRuntime } from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createContext } from "./Context.ts";
import type { createFailures } from "./Failures.ts";

export function createCapture({
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
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>> &
    ReturnType<typeof createContext> &
    ReturnType<typeof createFailures>,
  | "projectionSnapshotQuery"
  | "resolveSessionRuntimeForThread"
  | "checkpointStore"
  | "workspaceEntries"
  | "appendCaptureFailureActivity"
  | "orchestrationEngine"
  | "serverCommandId"
  | "receiptBus"
  | "randomUUID"
  | "resolveThreadCheckpointState"
>) {
  const resolveTurnAssistantMessageId = Effect.fn("resolveTurnAssistantMessageId")(function* (
    threadId: ThreadId,
    turnId: TurnId,
  ) {
    if (projectionSnapshotQuery.getLatestAssistantMessageIdForTurn) {
      return Option.getOrUndefined(
        yield* projectionSnapshotQuery.getLatestAssistantMessageIdForTurn(threadId, turnId),
      );
    }

    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId, { activityKinds: [] })
      .pipe(Effect.map(Option.getOrUndefined));

    return thread?.messages
      .toReversed()
      .find((entry) => entry.role === "assistant" && entry.turnId === turnId)?.id;
  });

  // Resolves the workspace CWD for checkpoint operations, preferring the
  // active provider session CWD and falling back to the thread/project config.
  // Returns undefined when no CWD can be determined or the workspace is not
  // a git repository.
  const resolveCheckpointCwd = Effect.fn("resolveCheckpointCwd")(function* (input: {
    readonly threadId: ThreadId;
    readonly thread: { readonly projectId: ProjectId; readonly worktreePath: string | null };
    readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly preferSessionRuntime: boolean;
  }): Effect.fn.Return<string | undefined, CheckpointStoreError> {
    const fromSession = yield* resolveSessionRuntimeForThread(input.threadId);

    const fromThread = resolveThreadWorkspaceCwd({
      thread: input.thread,
      projects: input.projects,
    });

    const cwd = input.preferSessionRuntime
      ? (Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }) ?? fromThread)
      : (fromThread ??
        Option.match(fromSession, {
          onNone: () => undefined,
          onSome: (runtime) => runtime.cwd,
        }));

    if (!cwd) {
      return undefined;
    }

    if (!(yield* checkpointStore.isGitRepository(cwd))) {
      return undefined;
    }

    return cwd;
  });

  // Shared tail for both capture paths: creates the git checkpoint ref, diffs
  // it against the previous turn, then dispatches the domain events to update
  // the orchestration read model.
  const captureAndDispatchCheckpoint = Effect.fn("captureAndDispatchCheckpoint")(function* (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId;
    readonly cwd: string;
    readonly turnCount: number;
    readonly status: "ready" | "missing" | "error";
    readonly assistantMessageId: MessageId | undefined;
    readonly createdAt: string;
  }) {
    const fromTurnCount = Math.max(0, input.turnCount - 1);
    const fromCheckpointRef = checkpointRefForThreadTurn(input.threadId, fromTurnCount);
    const targetCheckpointRef = checkpointRefForThreadTurn(input.threadId, input.turnCount);

    const fromCheckpointExists = yield* checkpointStore.hasCheckpointRef({
      cwd: input.cwd,
      checkpointRef: fromCheckpointRef,
    });

    if (!fromCheckpointExists) {
      yield* Effect.logWarning("checkpoint capture missing pre-turn baseline", {
        threadId: input.threadId,
        turnId: input.turnId,
        fromTurnCount,
      });
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: input.cwd,
      checkpointRef: targetCheckpointRef,
    });

    // Refresh the workspace entry index so the @-mention file picker
    // reflects files created or deleted during this turn.
    yield* workspaceEntries.refresh(input.cwd);

    // Git may have been initialized during this turn, leaving no pre-turn
    // snapshot. Keep the completion checkpoint for future turns, but do not
    // invent a baseline or attempt a diff against a ref that does not exist.
    const files = yield* (
      fromCheckpointExists
        ? checkpointStore.diffCheckpoints({
            cwd: input.cwd,
            fromCheckpointRef,
            toCheckpointRef: targetCheckpointRef,
            fallbackFromToHead: false,
            ignoreWhitespace: false,
            format: "numstat",
          })
        : Effect.succeed("")
    ).pipe(
      Effect.map((diff) =>
        parseTurnDiffFilesFromNumstat(diff).map((file) => ({
          path: file.path,
          kind: "modified" as const,
          additions: file.additions,
          deletions: file.deletions,
        })),
      ),
      Effect.tapError((error) =>
        appendCaptureFailureActivity({
          threadId: input.threadId,
          turnId: input.turnId,
          detail: `Checkpoint captured, but turn diff summary is unavailable: ${error.message}`,
          createdAt: input.createdAt,
        }),
      ),
      Effect.catch((error) =>
        Effect.logWarning("failed to derive checkpoint file summary", {
          threadId: input.threadId,
          turnId: input.turnId,
          turnCount: input.turnCount,
          detail: error.message,
        }).pipe(Effect.as([])),
      ),
    );

    const assistantMessageId =
      input.assistantMessageId ??
      (yield* resolveTurnAssistantMessageId(input.threadId, input.turnId)) ??
      MessageId.make(`assistant:${input.turnId}`);

    yield* orchestrationEngine.dispatch({
      type: "thread.turn.diff.complete",
      commandId: yield* serverCommandId("checkpoint-turn-diff-complete"),
      threadId: input.threadId,
      turnId: input.turnId,
      completedAt: input.createdAt,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      files,
      assistantMessageId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "checkpoint.diff.finalized",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      checkpointRef: targetCheckpointRef,
      status: input.status,
      createdAt: input.createdAt,
    });
    yield* receiptBus.publish({
      type: "turn.processing.quiesced",
      threadId: input.threadId,
      turnId: input.turnId,
      checkpointTurnCount: input.turnCount,
      createdAt: input.createdAt,
    });

    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: yield* serverCommandId("checkpoint-captured-activity"),
      threadId: input.threadId,
      activity: {
        id: EventId.make(yield* randomUUID),
        tone: "info",
        kind: "checkpoint.captured",
        summary: "Checkpoint captured",
        payload: {
          turnCount: input.turnCount,
          status: input.status,
        },
        turnId: input.turnId,
        createdAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  // Capture the files left by a completed or interrupted turn.
  const captureCheckpointFromTurnCompletion = Effect.fn("captureCheckpointFromTurnCompletion")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.completed" | "turn.aborted" }>) {
      const turnId = toTurnId(event.turnId);

      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadCheckpointState(event.threadId);

      if (!thread) {
        return;
      }

      // When a primary turn is active, only that turn may produce completion checkpoints.
      if (thread.session?.activeTurnId && !sameId(thread.session.activeTurnId, turnId)) {
        return;
      }

      // Only skip if a real (non-placeholder) checkpoint already exists for this turn.
      // ProviderRuntimeIngestion may insert placeholder entries with status "missing"
      // before this reactor runs; those must not prevent real git capture.
      if (
        thread.checkpoints.some(
          (checkpoint) => checkpoint.turnId === turnId && checkpoint.status !== "missing",
        )
      ) {
        return;
      }

      const projects = thread.projects;

      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: true,
      });

      if (!checkpointCwd) {
        return;
      }

      // If a placeholder checkpoint exists for this turn, reuse its turn count
      // instead of incrementing past it.
      const existingPlaceholder = thread.checkpoints.find(
        (checkpoint) => checkpoint.turnId === turnId && checkpoint.status === "missing",
      );

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );

      const nextTurnCount = existingPlaceholder
        ? existingPlaceholder.checkpointTurnCount
        : currentTurnCount + 1;

      yield* captureAndDispatchCheckpoint({
        threadId: thread.id,
        turnId,
        cwd: checkpointCwd,
        turnCount: nextTurnCount,
        status:
          event.type === "turn.aborted"
            ? "ready"
            : checkpointStatusFromRuntime(event.payload.state),
        assistantMessageId: existingPlaceholder?.assistantMessageId ?? undefined,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromTurnStart = Effect.fn("ensurePreTurnBaselineFromTurnStart")(
    function* (event: Extract<ProviderRuntimeEvent, { type: "turn.started" }>) {
      const turnId = toTurnId(event.turnId);

      if (!turnId) {
        return;
      }

      const thread = yield* resolveThreadCheckpointState(event.threadId);

      if (!thread) {
        return;
      }

      const projects = thread.projects;

      const checkpointCwd = yield* resolveCheckpointCwd({
        threadId: thread.id,
        thread,
        projects,
        preferSessionRuntime: false,
      });

      if (!checkpointCwd) {
        return;
      }

      const currentTurnCount = thread.checkpoints.reduce(
        (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
        0,
      );

      const baselineCheckpointRef = checkpointRefForThreadTurn(thread.id, currentTurnCount);

      const baselineExists = yield* checkpointStore.hasCheckpointRef({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });

      if (baselineExists) {
        return;
      }

      yield* checkpointStore.captureCheckpoint({
        cwd: checkpointCwd,
        checkpointRef: baselineCheckpointRef,
      });
      yield* receiptBus.publish({
        type: "checkpoint.baseline.captured",
        threadId: thread.id,
        checkpointTurnCount: currentTurnCount,
        checkpointRef: baselineCheckpointRef,
        createdAt: event.createdAt,
      });
    },
  );

  const ensurePreTurnBaselineFromDomainTurnStart = Effect.fn(
    "ensurePreTurnBaselineFromDomainTurnStart",
  )(function* (
    event: Extract<
      OrchestrationEvent,
      { type: "thread.turn-start-requested" | "thread.message-sent" }
    >,
  ) {
    if (event.type === "thread.message-sent") {
      if (event.metadata?.importedHistory === true) return;

      if (
        event.payload.role !== "user" ||
        event.payload.streaming ||
        event.payload.turnId !== null
      ) {
        return;
      }
    }

    const threadId = event.payload.threadId;
    const thread = yield* resolveThreadCheckpointState(threadId);

    if (!thread) {
      return;
    }

    const projects = thread.projects;

    const checkpointCwd = yield* resolveCheckpointCwd({
      threadId,
      thread,
      projects,
      preferSessionRuntime: false,
    });

    if (!checkpointCwd) {
      return;
    }

    const currentTurnCount = thread.checkpoints.reduce(
      (maxTurnCount, checkpoint) => Math.max(maxTurnCount, checkpoint.checkpointTurnCount),
      0,
    );

    const baselineCheckpointRef = checkpointRefForThreadTurn(threadId, currentTurnCount);

    const baselineExists = yield* checkpointStore.hasCheckpointRef({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });

    if (baselineExists) {
      return;
    }

    yield* checkpointStore.captureCheckpoint({
      cwd: checkpointCwd,
      checkpointRef: baselineCheckpointRef,
    });
    yield* receiptBus.publish({
      type: "checkpoint.baseline.captured",
      threadId,
      checkpointTurnCount: currentTurnCount,
      checkpointRef: baselineCheckpointRef,
      createdAt: event.occurredAt,
    });
  });

  return {
    resolveTurnAssistantMessageId,
    resolveCheckpointCwd,
    captureAndDispatchCheckpoint,
    captureCheckpointFromTurnCompletion,
    ensurePreTurnBaselineFromTurnStart,
    ensurePreTurnBaselineFromDomainTurnStart,
  };
}
