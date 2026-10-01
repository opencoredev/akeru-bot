import {
  type AkeruDelegationRecord,
  CommandId,
  MessageId,
  ThreadId,
  type TurnId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { forkParked, ServerActivation } from "../../../serverActivation.ts";
import { type ProviderIntentEvent, STARTUP_RECOVERY_INPUT } from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createDelegations } from "./Delegations.ts";
import type { createRouting } from "./Routing.ts";
import type { createTurns } from "./Turns.ts";
import type { createFailures } from "./Failures.ts";
export function createRecovery({
  orchestrationEngine,
  serverEventId,
  projectionSnapshotQuery,
  dispatchDelegationRelease,
  enqueueProviderCommand,
  worker,
  agentController,
  resumeInterruptedTurn,
  setThreadSessionErrorOnTurnStartFailure,
  formatFailureDetail,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>> &
    ReturnType<typeof createDelegations> &
    Effect.Success<ReturnType<typeof createRouting>> &
    ReturnType<typeof createTurns> &
    ReturnType<typeof createFailures>,
  | "orchestrationEngine"
  | "serverEventId"
  | "projectionSnapshotQuery"
  | "dispatchDelegationRelease"
  | "enqueueProviderCommand"
  | "worker"
  | "agentController"
  | "resumeInterruptedTurn"
  | "setThreadSessionErrorOnTurnStartFailure"
  | "formatFailureDetail"
>) {
  const findPersistedTurnStart = Effect.fn("findPersistedTurnStart")(function* (input: {
    readonly threadId: ThreadId;
    readonly messageId: MessageId;
    readonly throughSequence: number;
  }) {
    let cursor = 0;
    let match: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }> | undefined;
    while (cursor < input.throughSequence) {
      const page = Array.from(
        yield* Stream.runCollect(
          orchestrationEngine.readThreadEvents({
            threadId: input.threadId,
            fromSequenceExclusive: cursor,
            toSequenceInclusive: input.throughSequence,
            limit: 500,
          }),
        ),
      );
      if (page.length === 0) break;
      for (const event of page) {
        if (
          event.type === "thread.turn-start-requested" &&
          event.payload.messageId === input.messageId
        ) {
          match = event;
        }
      }
      const nextCursor = page.at(-1)?.sequence ?? cursor;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return match;
  });

  const findPersistedTurnResume = Effect.fn("findPersistedTurnResume")(function* (input: {
    readonly threadId: ThreadId;
    readonly throughSequence: number;
  }) {
    let cursor = 0;
    let match: Extract<ProviderIntentEvent, { type: "thread.turn-resume-requested" }> | undefined;
    while (cursor < input.throughSequence) {
      const page = Array.from(
        yield* Stream.runCollect(
          orchestrationEngine.readThreadEvents({
            threadId: input.threadId,
            fromSequenceExclusive: cursor,
            toSequenceInclusive: input.throughSequence,
            limit: 500,
          }),
        ),
      );
      if (page.length === 0) break;
      for (const event of page) {
        if (event.type === "thread.turn-resume-requested") match = event;
      }
      const nextCursor = page.at(-1)?.sequence ?? cursor;
      if (nextCursor <= cursor) break;
      cursor = nextCursor;
    }
    return match;
  });

  const settleStalePendingRequests = Effect.fn("settleStalePendingRequests")(function* (input: {
    readonly threadId: ThreadId;
    readonly activities: ReadonlyArray<{
      readonly kind: string;
      readonly payload: unknown;
      readonly turnId: TurnId | null;
    }>;
    readonly createdAt: string;
  }) {
    const pending = new Map<
      string,
      { readonly kind: "approval" | "user-input"; readonly turnId: TurnId | null }
    >();
    for (const activity of input.activities) {
      const payload =
        typeof activity.payload === "object" && activity.payload !== null
          ? (activity.payload as Record<string, unknown>)
          : null;
      const requestId = typeof payload?.requestId === "string" ? payload.requestId : null;
      if (!requestId) continue;
      if (activity.kind === "approval.requested") {
        pending.set(requestId, { kind: "approval", turnId: activity.turnId });
      } else if (activity.kind === "user-input.requested") {
        pending.set(requestId, { kind: "user-input", turnId: activity.turnId });
      } else if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
        pending.delete(requestId);
      } else if (
        activity.kind === "provider.approval.respond.failed" ||
        activity.kind === "provider.user-input.respond.failed"
      ) {
        const detail = typeof payload?.detail === "string" ? payload.detail.toLowerCase() : "";
        if (detail.includes("stale pending") || detail.includes("unknown pending")) {
          pending.delete(requestId);
        }
      }
    }

    yield* Effect.forEach(
      pending,
      ([requestId, request]) =>
        serverEventId().pipe(
          Effect.flatMap((eventId) =>
            orchestrationEngine.dispatch({
              type: "thread.activity.append",
              commandId: CommandId.make(`server:restart-request-expired:${eventId}`),
              threadId: input.threadId,
              activity: {
                id: eventId,
                tone: request.kind === "approval" ? "approval" : "info",
                kind: request.kind === "approval" ? "approval.resolved" : "user-input.resolved",
                summary:
                  request.kind === "approval"
                    ? "Approval expired after restart"
                    : "Question expired after restart",
                payload: {
                  requestId,
                  outcome: "interrupted",
                  ...(request.kind === "user-input" ? { answers: {} } : {}),
                },
                turnId: request.turnId,
                createdAt: input.createdAt,
              },
              createdAt: input.createdAt,
            }),
          ),
        ),
      { discard: true },
    );
  });

  // Hands back delegated results still acknowledged by a turn start that
  // recorded a failure, whose background release a restart cancelled. Turn
  // starts that are still pending are replayed instead and read the results.
  const releaseStrandedDelegationResults = Effect.fn("releaseStrandedDelegationResults")(function* (
    delegations: ReadonlyArray<AkeruDelegationRecord>,
    pendingTurnStarts: ReadonlyArray<{ readonly threadId: ThreadId; readonly requestedAt: string }>,
  ) {
    const hasTurnStartFailure = projectionSnapshotQuery.hasTurnStartFailure;
    if (!hasTurnStartFailure) return;
    const turnStartKey = (threadId: ThreadId, requestedAt: string) =>
      JSON.stringify([threadId, requestedAt]);
    const pending = new Set(
      pendingTurnStarts.map((turnStart) => turnStartKey(turnStart.threadId, turnStart.requestedAt)),
    );
    const byTurnStart = new Map<
      string,
      { threadId: ThreadId; requestedAt: string; delegations: Array<AkeruDelegationRecord> }
    >();
    for (const delegation of delegations) {
      if (
        (delegation.phase._tag !== "Completed" && delegation.phase._tag !== "Failed") ||
        delegation.phase.acknowledgedAt === null
      ) {
        continue;
      }
      const threadId = delegation.parentThreadId;
      const requestedAt = delegation.phase.acknowledgedAt;
      const key = turnStartKey(threadId, requestedAt);
      if (pending.has(key)) continue;
      const group = byTurnStart.get(key) ?? { threadId, requestedAt, delegations: [] };
      group.delegations.push(delegation);
      byTurnStart.set(key, group);
    }
    for (const { threadId, requestedAt, delegations: acknowledged } of byTurnStart.values()) {
      yield* hasTurnStartFailure({ threadId, requestedAt }).pipe(
        Effect.flatMap((failed) =>
          failed
            ? Effect.forEach(acknowledged, dispatchDelegationRelease, { discard: true })
            : Effect.void,
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("failed to release delegated work results at startup", {
                threadId,
                cause: Cause.pretty(cause),
              }),
        ),
      );
    }
  });

  const recoverStartupProviderWork = Effect.fn("recoverStartupProviderWork")(function* () {
    const throughSequence = yield* orchestrationEngine.latestSequence;
    const initialReadModel = yield* projectionSnapshotQuery.getCommandReadModel();
    // A delegated child's turn reports only to the in-memory watch that started it, and no watch
    // survives a restart. Startup fails the owning delegation, so replaying or resuming the child
    // would run work that nothing observes and the card cannot show.
    const delegatedChildThreadIds = new Set(
      initialReadModel.threads
        .filter((thread) => (thread.parentDelegationId ?? null) !== null)
        .map((thread) => String(thread.id)),
    );
    const pendingTurnStarts = (
      projectionSnapshotQuery.listPendingTurnStarts
        ? yield* projectionSnapshotQuery.listPendingTurnStarts()
        : []
    ).filter((pending) => !delegatedChildThreadIds.has(String(pending.threadId)));
    const pendingThreadIds = new Set(pendingTurnStarts.map((pending) => String(pending.threadId)));
    yield* releaseStrandedDelegationResults(initialReadModel.delegations, pendingTurnStarts);

    for (const pending of pendingTurnStarts) {
      const event = yield* findPersistedTurnStart({
        threadId: pending.threadId,
        messageId: pending.messageId,
        throughSequence,
      });
      if (event) {
        yield* enqueueProviderCommand(event);
      } else {
        yield* Effect.logWarning("provider command reactor could not recover pending turn event", {
          threadId: pending.threadId,
          messageId: pending.messageId,
        });
      }
    }

    const pendingResumes = initialReadModel.threads.filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        !delegatedChildThreadIds.has(String(thread.id)) &&
        thread.session?.status === "starting" &&
        (thread.latestTurn === null ||
          thread.latestTurn.state === "error" ||
          thread.latestTurn.state === "interrupted"),
    );
    for (const thread of pendingResumes) {
      const event = yield* findPersistedTurnResume({
        threadId: thread.id,
        throughSequence,
      });
      if (event) {
        pendingThreadIds.add(String(thread.id));
        yield* enqueueProviderCommand(event);
      } else {
        yield* Effect.logWarning(
          "provider command reactor could not recover pending resume event",
          {
            threadId: thread.id,
          },
        );
      }
    }
    yield* worker.drain;

    const liveThreadIds = new Set(
      (yield* agentController.listSessions()).map((session) => String(session.threadId)),
    );
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const interrupted = readModel.threads.filter(
      (thread) =>
        thread.deletedAt === null &&
        thread.archivedAt === null &&
        !pendingThreadIds.has(String(thread.id)) &&
        !delegatedChildThreadIds.has(String(thread.id)) &&
        !liveThreadIds.has(String(thread.id)) &&
        thread.latestTurn?.state === "running" &&
        thread.session !== null &&
        (thread.session.status === "starting" ||
          thread.session.status === "running" ||
          thread.session.activeTurnId !== null),
    );
    const resumeInterrupted = Effect.forEach(
      interrupted,
      (thread) =>
        Effect.gen(function* () {
          const recoveredAt = DateTime.formatIso(yield* DateTime.now);
          const threadDetail = yield* projectionSnapshotQuery
            .getThreadDetailById(thread.id)
            .pipe(Effect.map(Option.getOrUndefined));
          yield* settleStalePendingRequests({
            threadId: thread.id,
            activities: threadDetail?.activities ?? [],
            createdAt: recoveredAt,
          });
          yield* resumeInterruptedTurn({
            threadId: thread.id,
            messageText: STARTUP_RECOVERY_INPUT,
            createdAt: recoveredAt,
          }).pipe(
            Effect.tap(() =>
              Effect.logInfo("provider command reactor resumed interrupted turn", {
                threadId: thread.id,
                previousTurnId: thread.latestTurn?.turnId,
              }),
            ),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : setThreadSessionErrorOnTurnStartFailure({
                    threadId: thread.id,
                    detail: `Automatic recovery failed. Use Resume to continue. ${formatFailureDetail(cause)}`,
                    createdAt: recoveredAt,
                  }).pipe(
                    Effect.andThen(
                      Effect.logWarning(
                        "provider command reactor could not resume interrupted turn",
                        {
                          threadId: thread.id,
                          cause: Cause.pretty(cause),
                        },
                      ),
                    ),
                  ),
            ),
          );
        }),
      { discard: true },
    );

    // A provider may wait indefinitely for a tool approval. Keep startup
    // responsive while interrupted turns recover after activation.
    const activation = yield* ServerActivation;
    if (activation === undefined) {
      yield* resumeInterrupted;
    } else {
      yield* forkParked(resumeInterrupted);
    }
  });
  return {
    findPersistedTurnStart,
    findPersistedTurnResume,
    settleStalePendingRequests,
    releaseStrandedDelegationResults,
    recoverStartupProviderWork,
  };
}
