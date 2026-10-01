import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { increment, orchestrationEventsProcessedTotal } from "../../../observability/Metrics.ts";
import { type ProviderIntentEvent, PROVIDER_COMMAND_CONCURRENCY } from "./Fields.ts";
import { makeKeyedDrainableWorker } from "./KeyedDrainableWorker.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createFailures } from "./Failures.ts";
import type { createTitles } from "./Titles.ts";
import type { createContext } from "./Context.ts";
import type { createSession } from "./Session.ts";
import type { createTurns } from "./Turns.ts";
import type { createRequests } from "./Requests.ts";

export const createRouting = Effect.fn("makeprovider-command-Routing")(function* ({
  agentController,
  appendProviderFailureActivity,
  threadTitleRegenerationWorker,
  resolveThreadShell,
  threadModelSelections,
  ensureSessionForThread,
  formatFailureDetail,
  threadsAwaitingRestrictiveSessionCleanup,
  setThreadSessionErrorOnTurnStartFailure,
  reconcileRestrictiveSessionCleanup,
  processTurnStartRequested,
  processTurnResumeRequested,
  processTurnInterruptRequested,
  processApprovalResponseRequested,
  processUserInputResponseRequested,
  processSessionStopRequested,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>> &
    ReturnType<typeof createFailures> &
    Effect.Success<ReturnType<typeof createTitles>> &
    ReturnType<typeof createContext> &
    ReturnType<typeof createSession> &
    ReturnType<typeof createTurns> &
    ReturnType<typeof createRequests>,
  | "agentController"
  | "appendProviderFailureActivity"
  | "threadTitleRegenerationWorker"
  | "resolveThreadShell"
  | "threadModelSelections"
  | "ensureSessionForThread"
  | "formatFailureDetail"
  | "threadsAwaitingRestrictiveSessionCleanup"
  | "setThreadSessionErrorOnTurnStartFailure"
  | "reconcileRestrictiveSessionCleanup"
  | "processTurnStartRequested"
  | "processTurnResumeRequested"
  | "processTurnInterruptRequested"
  | "processApprovalResponseRequested"
  | "processUserInputResponseRequested"
  | "processSessionStopRequested"
>) {
  const processDomainEvent = Effect.fn("processDomainEvent")(function* (
    event: ProviderIntentEvent,
    restrictiveSessionCleanupConfirmed: boolean,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration.event_type": event.type,
      ...(event.type === "delegation.updated"
        ? {
            "orchestration.thread_id":
              (event.payload.delegation.phase._tag === "Queued"
                ? null
                : event.payload.delegation.phase.childThreadId) ?? "unassigned",
          }
        : event.type === "delegation.retry-requested"
          ? { "orchestration.thread_id": event.payload.parentThreadId }
          : { "orchestration.thread_id": event.payload.threadId }),
      ...(event.commandId ? { "orchestration.command_id": event.commandId } : {}),
    });
    yield* increment(orchestrationEventsProcessedTotal, {
      eventType: event.type,
    });

    switch (event.type) {
      case "delegation.updated": {
        const delegation = event.payload.delegation;

        if (delegation.phase._tag === "Canceled" && delegation.phase.childThreadId !== null) {
          yield* agentController.interruptTurn({
            threadId: delegation.phase.childThreadId,
            ...(delegation.phase.childTurnId ? { turnId: delegation.phase.childTurnId } : {}),
          });
        }

        return;
      }

      case "delegation.retry-requested": {
        // The decider already checked phase and cap; the runtime starts a fresh
        // record that points back at the original, which stays untouched.
        const { delegationId, parentThreadId } = event.payload;
        const dispatchDelegation = agentController.dispatchDelegation;

        if (!dispatchDelegation) {
          yield* Effect.logWarning("delegation retry requested without a delegation runtime", {
            delegationId,
          });

          return;
        }

        yield* dispatchDelegation({ _tag: "Retry", delegationId }).pipe(
          Effect.catchTag("AgentControllerRuntimeError", (error) =>
            appendProviderFailureActivity({
              threadId: parentThreadId,
              kind: "delegation.retry.failed",
              summary: "Bot work could not be retried",
              detail: error.detail,
              turnId: null,
              createdAt: event.occurredAt,
            }),
          ),
        );

        return;
      }

      case "thread.meta-updated":
        yield* threadTitleRegenerationWorker.enqueue(event);

        return;
      case "thread.runtime-mode-set": {
        const thread = yield* resolveThreadShell(event.payload.threadId);

        if (!thread?.session || thread.session.status === "stopped") {
          return;
        }

        const session = thread.session;
        const cachedModelSelection = threadModelSelections.get(event.payload.threadId);
        yield* ensureSessionForThread(
          event.payload.threadId,
          event.occurredAt,
          cachedModelSelection !== undefined ? { modelSelection: cachedModelSelection } : {},
        ).pipe(
          Effect.catchCause((cause) => {
            if (Cause.hasInterruptsOnly(cause)) {
              return Effect.interrupt;
            }

            const detail = formatFailureDetail(cause);

            const restrictsActiveSession =
              session.runtimeMode === "full-access" && thread.runtimeMode === "approval-required";

            if (restrictsActiveSession) {
              threadsAwaitingRestrictiveSessionCleanup.add(thread.id);
            }

            const reportFailure = setThreadSessionErrorOnTurnStartFailure({
              threadId: thread.id,
              detail,
              createdAt: event.occurredAt,
            }).pipe(
              Effect.andThen(
                appendProviderFailureActivity({
                  threadId: thread.id,
                  kind: "provider.session.update.failed",
                  summary: "Provider session update failed",
                  detail,
                  turnId: session.activeTurnId,
                  createdAt: event.occurredAt,
                }),
              ),
            );

            return Effect.exit(
              restrictsActiveSession ? reconcileRestrictiveSessionCleanup(thread.id) : Effect.void,
            ).pipe(
              Effect.flatMap((cleanupExit) =>
                reportFailure.pipe(
                  Effect.andThen(
                    Exit.isFailure(cleanupExit) ? Effect.failCause(cleanupExit.cause) : Effect.void,
                  ),
                ),
              ),
            );
          }),
        );

        return;
      }

      case "thread.turn-start-requested":
        yield* processTurnStartRequested(event);

        return;
      case "thread.turn-resume-requested":
        yield* processTurnResumeRequested(event);

        return;
      case "thread.turn-interrupt-requested":
        yield* processTurnInterruptRequested(event);

        return;
      case "thread.approval-response-requested":
        yield* processApprovalResponseRequested(event);

        return;
      case "thread.user-input-response-requested":
        yield* processUserInputResponseRequested(event);

        return;
      case "thread.session-stop-requested":
        yield* processSessionStopRequested(event, restrictiveSessionCleanupConfirmed);

        return;
    }
  });

  const processDomainEventSafely = (event: ProviderIntentEvent) =>
    (event.type === "delegation.updated"
      ? event.payload.delegation.phase._tag === "Queued" ||
        event.payload.delegation.phase.childThreadId === null
        ? Effect.succeed(false)
        : reconcileRestrictiveSessionCleanup(event.payload.delegation.phase.childThreadId)
      : event.type === "delegation.retry-requested"
        ? Effect.succeed(false)
        : reconcileRestrictiveSessionCleanup(event.payload.threadId)
    ).pipe(
      Effect.flatMap((cleanupConfirmed) => processDomainEvent(event, cleanupConfirmed)),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }

        return Effect.logWarning("provider command reactor failed to process event", {
          eventType: event.type,
          cause: Cause.pretty(cause),
        });
      }),
    );

  const providerCommandLaneKey = (event: ProviderIntentEvent): string =>
    event.type === "delegation.updated"
      ? event.payload.delegation.phase._tag === "Queued"
        ? event.payload.delegation.parentThreadId
        : (event.payload.delegation.phase.childThreadId ?? event.payload.delegation.parentThreadId)
      : event.type === "delegation.retry-requested"
        ? event.payload.parentThreadId
        : event.payload.threadId;

  const worker = yield* makeKeyedDrainableWorker({
    concurrency: PROVIDER_COMMAND_CONCURRENCY,
    process: processDomainEventSafely,
  });

  const enqueueProviderCommand = (event: ProviderIntentEvent) =>
    worker.enqueue(providerCommandLaneKey(event), event);

  return {
    processDomainEvent,
    processDomainEventSafely,
    providerCommandLaneKey,
    worker,
    enqueueProviderCommand,
  };
});
