import { AkeruUsageReservationId, type ChatAttachment, ThreadId } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AKERU_TURN_USAGE_RESERVATION_TOKENS } from "../../../usage/BotUsageLedger.ts";
import {
  type ProviderIntentEvent,
  turnRequestKeyForEvent,
  resolveControllerBotId,
  isProviderDriverKind,
  withoutUnavailability,
  MANUAL_RECOVERY_INPUT,
  DEFAULT_RUNTIME_MODE,
} from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createContext } from "./Context.ts";
import type { createFailures } from "./Failures.ts";
import type { createWorkspace } from "./Workspace.ts";
import type { createDelegations } from "./Delegations.ts";
import type { createSession } from "./Session.ts";

export function createTurns({
  hasHandledTurnRequestRecently,
  resolveThreadShell,
  projectionSnapshotQuery,
  appendProviderFailureActivity,
  failDelegation,
  ensureThreadWorktree,
  maybeGenerateAndRenameWorktreeBranchForFirstTurn,
  formatFailure,
  setThreadSessionErrorOnTurnStartFailure,
  failDelegationStart,
  releaseDelegationResults,
  projectionBotRepository,
  botUsageLedger,
  buildSendTurnRequestForThread,
  readDelegationResults,
  agentController,
  formatFailureDetail,
  setThreadSession,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>> &
    ReturnType<typeof createContext> &
    ReturnType<typeof createFailures> &
    ReturnType<typeof createWorkspace> &
    ReturnType<typeof createDelegations> &
    ReturnType<typeof createSession>,
  | "hasHandledTurnRequestRecently"
  | "resolveThreadShell"
  | "projectionSnapshotQuery"
  | "appendProviderFailureActivity"
  | "failDelegation"
  | "ensureThreadWorktree"
  | "maybeGenerateAndRenameWorktreeBranchForFirstTurn"
  | "formatFailure"
  | "setThreadSessionErrorOnTurnStartFailure"
  | "failDelegationStart"
  | "releaseDelegationResults"
  | "projectionBotRepository"
  | "botUsageLedger"
  | "buildSendTurnRequestForThread"
  | "readDelegationResults"
  | "agentController"
  | "formatFailureDetail"
  | "setThreadSession"
>) {
  const processTurnStartRequested = Effect.fn("processTurnStartRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-start-requested" }>,
  ) {
    const key = turnRequestKeyForEvent(event);

    if (yield* hasHandledTurnRequestRecently(key)) {
      return;
    }

    const thread = yield* resolveThreadShell(event.payload.threadId);

    if (!thread) {
      return;
    }

    const turnStart = yield* projectionSnapshotQuery.getTurnStartMessage({
      threadId: thread.id,
      messageId: event.payload.messageId,
    });

    if (Option.isNone(turnStart) || turnStart.value.message.role !== "user") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.start.failed",
        summary: "Provider turn start failed",
        detail: `User message '${event.payload.messageId}' was not found for turn start request.`,
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.messageId,
      }).pipe(
        Effect.ensuring(
          failDelegation(
            event.payload.threadId,
            `User message '${event.payload.messageId}' was not found for turn start request.`,
          ),
        ),
      );

      return;
    }

    const { message, hasOtherUserMessages } = turnStart.value;

    yield* ensureThreadWorktree(thread);

    const isFirstUserMessageTurn = !hasOtherUserMessages;

    if (isFirstUserMessageTurn) {
      const generationInput = {
        messageText: message.text,
        ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      };

      yield* maybeGenerateAndRenameWorktreeBranchForFirstTurn({
        threadId: event.payload.threadId,
        branch: thread.branch,
        worktreePath: thread.worktreePath,
        ...generationInput,
      }).pipe(Effect.forkScoped);
    }

    const handleTurnStartFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.void;
      }

      const { detail, unavailability, providerInstanceId } = formatFailure(cause);

      // The failure activity lands before the session error clears the pending
      // turn start, so a restart either replays the turn start or finds the
      // failure and releases the results this turn acknowledged.
      return Effect.gen(function* () {
        yield* Effect.logWarning("provider turn start failed", {
          threadId: event.payload.threadId,
          cause: Cause.pretty(cause),
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.start.failed",
          summary: "Provider turn start failed",
          detail,
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.messageId,
          unavailability,
          providerInstanceId,
        });
        yield* setThreadSessionErrorOnTurnStartFailure({
          threadId: event.payload.threadId,
          detail,
          unavailability,
          createdAt: event.payload.createdAt,
        });
      }).pipe(
        Effect.ensuring(failDelegationStart(thread, detail)),
        Effect.ensuring(releaseDelegationResults(event)),
      );
    };

    const recoverTurnStartFailure = (cause: Cause.Cause<unknown>) =>
      handleTurnStartFailure(cause).pipe(
        Effect.catchCause((recoveryCause) =>
          Effect.logWarning("provider command reactor failed to recover turn start failure", {
            eventType: event.type,
            threadId: event.payload.threadId,
            cause: Cause.pretty(recoveryCause),
            originalCause: Cause.pretty(cause),
          }),
        ),
      );

    const respondingBotId = resolveControllerBotId(thread);

    const respondingBot =
      respondingBotId === null
        ? undefined
        : yield* projectionBotRepository
            .getById({ botId: respondingBotId })
            .pipe(Effect.map(Option.getOrUndefined));

    const reservationId = AkeruUsageReservationId.make(`turn:${event.eventId}`);

    const reserved =
      respondingBotId === null
        ? true
        : yield* botUsageLedger
            .reserve({
              reservationId,
              sourceKey: `turn-start:${event.eventId}`,
              botId: respondingBotId,
              threadId: thread.id,
              turnId: null,
              category: "turn",
              maximumTokens: AKERU_TURN_USAGE_RESERVATION_TOKENS,
              capLimit: respondingBot?.usageCap?.limit ?? Number.MAX_SAFE_INTEGER,
              provider:
                [
                  thread.session?.providerName,
                  event.payload.modelSelection?.instanceId,
                  respondingBot?.engine?.provider,
                  thread.modelSelection.instanceId,
                ].find(isProviderDriverKind) ?? null,
              model:
                event.payload.modelSelection?.model ??
                respondingBot?.engine?.model ??
                thread.modelSelection.model ??
                null,
              createdAt: event.payload.createdAt,
            })
            .pipe(
              Effect.as(true),
              Effect.catchCause((cause) => handleTurnStartFailure(cause).pipe(Effect.as(false))),
            );

    if (!reserved) return;

    const sendTurnRequest = yield* buildSendTurnRequestForThread({
      threadId: event.payload.threadId,
      messageText: message.text,
      ...(message.attachments !== undefined ? { attachments: message.attachments } : {}),
      ...(event.payload.modelSelection !== undefined
        ? { modelSelection: event.payload.modelSelection }
        : {}),
      ...(event.payload.hiddenWake !== undefined ? { hiddenWake: event.payload.hiddenWake } : {}),
      ...(event.payload.timezone !== undefined ? { timezone: event.payload.timezone } : {}),
      createdAt: event.payload.createdAt,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        (respondingBotId === null
          ? Effect.void
          : botUsageLedger.settle({
              reservationId,
              state: "released",
              settledAt: event.payload.createdAt,
            })
        ).pipe(Effect.andThen(handleTurnStartFailure(cause)), Effect.as(Option.none())),
      ),
    );

    if (Option.isNone(sendTurnRequest)) {
      return;
    }

    // A channel turn's reply goes to an external sender who sees no work cards.
    const delegationResults = yield* readDelegationResults(event, {
      channel: message.channelOrigin != null,
    }).pipe(
      Effect.map(Option.some),
      Effect.catchCause((cause) =>
        (respondingBotId === null
          ? Effect.void
          : botUsageLedger.settle({
              reservationId,
              state: "released",
              settledAt: event.payload.createdAt,
            })
        ).pipe(Effect.andThen(handleTurnStartFailure(cause)), Effect.as(Option.none<string>())),
      ),
    );

    if (Option.isNone(delegationResults)) {
      return;
    }

    yield* agentController
      .sendTurn({
        ...sendTurnRequest.value,
        ...(delegationResults.value ? { delegationResults: delegationResults.value } : {}),
      })
      .pipe(
        Effect.tap((result) =>
          respondingBotId === null
            ? Effect.void
            : botUsageLedger.bindTurn({ reservationId, turnId: result.turnId }).pipe(
                Effect.catchCause(() =>
                  botUsageLedger
                    .settle({
                      reservationId,
                      state: "unavailable",
                      reason: "Usage reservation could not bind to the provider turn.",
                      settledAt: event.payload.createdAt,
                    })
                    .pipe(
                      Effect.catchCause((settleCause) =>
                        Effect.logWarning("failed to charge an unbound bot usage reservation", {
                          reservationId,
                          cause: Cause.pretty(settleCause),
                        }),
                      ),
                    ),
                ),
              ),
        ),
        Effect.catchCause((cause) =>
          (respondingBotId === null
            ? Effect.void
            : botUsageLedger.settle({
                reservationId,
                state: "released",
                settledAt: event.payload.createdAt,
              })
          ).pipe(Effect.andThen(recoverTurnStartFailure(cause))),
        ),
        Effect.forkScoped,
      );
  });

  const processTurnInterruptRequested = Effect.fn("processTurnInterruptRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-interrupt-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);

    if (!thread) {
      return;
    }

    const session = thread.session;

    if (!session || session.status === "stopped") {
      return yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.turn.interrupt.failed",
        summary: "Provider turn interrupt failed",
        detail: "No active provider session is bound to this chat.",
        turnId: event.payload.turnId ?? null,
        createdAt: event.payload.createdAt,
      });
    }

    const recoverInterruptFailure = (cause: Cause.Cause<unknown>) => {
      if (Cause.hasInterruptsOnly(cause)) {
        return Effect.interrupt;
      }

      const detail = formatFailureDetail(cause);

      return Effect.gen(function* () {
        const latestThread = yield* resolveThreadShell(event.payload.threadId);
        const latestSession = latestThread?.session;

        if (
          !latestSession ||
          latestSession.status === "stopped" ||
          latestSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            latestSession.activeTurnId !== null &&
            latestSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* agentController.stopSession({ threadId: event.payload.threadId }).pipe(
          Effect.catchCause((stopCause) => {
            if (Cause.hasInterruptsOnly(stopCause)) {
              return Effect.interrupt;
            }

            return Effect.logWarning(
              "provider command reactor failed to stop session after interrupt failure",
              {
                threadId: event.payload.threadId,
                cause: Cause.pretty(stopCause),
                originalCause: Cause.pretty(cause),
              },
            );
          }),
        );
        const stoppedThread = yield* resolveThreadShell(event.payload.threadId);
        const stoppedSession = stoppedThread?.session;

        if (
          !stoppedSession ||
          stoppedSession.status === "stopped" ||
          stoppedSession.status === "ready" ||
          (event.payload.turnId !== undefined &&
            stoppedSession.activeTurnId !== null &&
            stoppedSession.activeTurnId !== event.payload.turnId)
        ) {
          return;
        }

        yield* setThreadSession({
          threadId: event.payload.threadId,
          session: {
            ...withoutUnavailability(stoppedSession),
            status: "stopped",
            activeTurnId: null,
            lastError: detail,
            updatedAt: event.payload.createdAt,
          },
          createdAt: event.payload.createdAt,
        });
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.turn.interrupt.failed",
          summary: "Provider turn interrupt failed",
          detail,
          turnId: event.payload.turnId ?? null,
          createdAt: event.payload.createdAt,
        });
      });
    };

    // Orchestration turn ids are not provider turn ids, so interrupt by session.
    yield* agentController
      .interruptTurn({ threadId: event.payload.threadId })
      .pipe(Effect.catchCause(recoverInterruptFailure));
  });

  const resumeInterruptedTurn = Effect.fn("resumeInterruptedTurn")(function* (input: {
    readonly threadId: ThreadId;
    readonly createdAt: string;
    readonly messageText: string;
    readonly attachments?: ReadonlyArray<ChatAttachment>;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);

    if (!thread) return;
    yield* buildSendTurnRequestForThread({
      threadId: thread.id,
      messageText: input.messageText,
      ...(input.attachments ? { attachments: input.attachments } : {}),
      modelSelection: thread.modelSelection,
      createdAt: input.createdAt,
    }).pipe(Effect.flatMap(agentController.sendTurn));
  });

  const processTurnResumeRequested = Effect.fn("processTurnResumeRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.turn-resume-requested" }>,
  ) {
    const key = turnRequestKeyForEvent(event);

    if (yield* hasHandledTurnRequestRecently(key)) {
      return;
    }

    const detail = Option.getOrUndefined(
      yield* projectionSnapshotQuery.getThreadDetailById(event.payload.threadId),
    );

    const failedBeforeProviderAccepted = detail?.latestTurn === null;

    const originalRequest = failedBeforeProviderAccepted
      ? detail.messages.findLast((message) => message.role === "user")
      : undefined;

    yield* resumeInterruptedTurn({
      threadId: event.payload.threadId,
      createdAt: event.payload.createdAt,
      messageText: originalRequest?.text ?? MANUAL_RECOVERY_INPUT,
      ...(originalRequest?.attachments ? { attachments: originalRequest.attachments } : {}),
    }).pipe(
      Effect.tap(() =>
        Effect.logInfo("provider command reactor resumed turn after user request", {
          threadId: event.payload.threadId,
        }),
      ),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : setThreadSessionErrorOnTurnStartFailure({
              threadId: event.payload.threadId,
              detail: formatFailureDetail(cause),
              createdAt: event.payload.createdAt,
            }).pipe(
              Effect.andThen(
                appendProviderFailureActivity({
                  threadId: event.payload.threadId,
                  kind: "provider.turn.start.failed",
                  summary: "Could not resume the request",
                  detail: formatFailureDetail(cause),
                  turnId: null,
                  createdAt: event.payload.createdAt,
                }),
              ),
            ),
      ),
    );
  });

  const processSessionStopRequested = Effect.fn("processSessionStopRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.session-stop-requested" }>,
    restrictiveSessionCleanupConfirmed: boolean,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);

    if (!thread) {
      return;
    }

    const now = event.payload.createdAt;

    if (
      thread.session &&
      thread.session.status !== "stopped" &&
      !restrictiveSessionCleanupConfirmed
    ) {
      yield* agentController.stopSession({ threadId: thread.id });
    }

    yield* setThreadSession({
      threadId: thread.id,
      session: {
        threadId: thread.id,
        status: "stopped",
        providerName: thread.session?.providerName ?? null,
        ...(thread.session?.providerInstanceId !== undefined
          ? { providerInstanceId: thread.session.providerInstanceId }
          : {}),
        runtimeMode: thread.session?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
        mcpServerIds: [],
        activeTurnId: null,
        lastError: thread.session?.lastError ?? null,
        updatedAt: now,
      },
      createdAt: now,
    });
  });

  return {
    processTurnStartRequested,
    processTurnInterruptRequested,
    resumeInterruptedTurn,
    processTurnResumeRequested,
    processSessionStopRequested,
  };
}
