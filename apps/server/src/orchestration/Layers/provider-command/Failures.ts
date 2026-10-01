import {
  MessageId,
  type OrchestrationSession,
  type OrchestrationLatestTurn,
  type OrchestrationThreadShell,
  ThreadId,
  type TurnId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { readableErrorDetail } from "../../../provider/Errors.ts";
import { providerUnavailabilityFromDetail } from "../../../provider/providerSnapshot.ts";
import {
  resolveControllerBotId,
  isBotUsageCapExceeded,
  isComposioOperationError,
  isProviderAdapterRequestError,
  withoutUnavailability,
} from "./Fields.ts";
import type { createDependencies } from "./Dependencies.ts";
import type { createContext } from "./Context.ts";

export function createFailures({
  agentController,
  projectionBotRepository,
  serverCommandId,
  serverEventId,
  orchestrationEngine,
  resolveThreadDetail,
  resolveThreadShell,
}: Pick<
  Effect.Success<ReturnType<typeof createDependencies>> & ReturnType<typeof createContext>,
  | "agentController"
  | "projectionBotRepository"
  | "serverCommandId"
  | "serverEventId"
  | "orchestrationEngine"
  | "resolveThreadDetail"
  | "resolveThreadShell"
>) {
  const failDelegation = (threadId: ThreadId, error: string) =>
    agentController.failDelegation?.({ threadId, error }) ?? Effect.void;

  /** Fails the bot work a child chat runs, naming the bot that could not start. */
  const failDelegationStart = (
    thread: Pick<OrchestrationThreadShell, "id" | "botId" | "respondingBotId">,
    detail: string,
  ) => {
    const botId = resolveControllerBotId(thread);

    return (
      botId === null
        ? Effect.succeed(undefined)
        : projectionBotRepository.getById({ botId }).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.orElseSucceed(() => undefined),
          )
    ).pipe(
      Effect.flatMap((bot) =>
        failDelegation(thread.id, bot ? `${bot.name} could not start: ${detail}` : detail),
      ),
    );
  };

  const appendProviderFailureActivity = (input: {
    readonly threadId: ThreadId;
    readonly kind:
      | "provider.turn.start.failed"
      | "provider.turn.interrupt.failed"
      | "provider.approval.respond.failed"
      | "provider.user-input.respond.failed"
      | "provider.session.update.failed"
      | "provider.session.stop.failed"
      | "delegation.retry.failed";
    readonly summary: string;
    readonly detail: string;
    readonly turnId: TurnId | null;
    readonly createdAt: string;
    readonly requestId?: string;
    readonly unavailability?: OrchestrationLatestTurn["unavailability"];
  }) =>
    Effect.all({
      commandId: serverCommandId("provider-failure-activity"),
      eventId: serverEventId(),
    }).pipe(
      Effect.flatMap(({ commandId, eventId }) =>
        orchestrationEngine.dispatch({
          type: "thread.activity.append",
          commandId,
          threadId: input.threadId,
          activity: {
            id: eventId,
            tone: "error",
            kind: input.kind,
            summary: input.summary,
            payload: {
              detail: input.detail,
              ...(input.unavailability ? { unavailability: input.unavailability } : {}),
              ...(input.requestId ? { requestId: input.requestId } : {}),
            },
            turnId: input.turnId,
            createdAt: input.createdAt,
          },
          createdAt: input.createdAt,
        }),
      ),
    );

  const appendUserInputFailureReply = Effect.fn("appendUserInputFailureReply")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly createdAt: string;
    readonly providerFailed?: boolean;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);

    if (!thread) return;

    const messageId = MessageId.make(
      `assistant:user-input-response-failed:${input.threadId}:${input.requestId}`,
    );

    if (thread.messages.some((message) => message.id === messageId)) return;
    const turnId = thread.session?.activeTurnId ?? undefined;

    const text = input.providerFailed
      ? "I could not continue that request because the provider failed. Check the provider, then send it again."
      : "I could not continue that request because the bot session restarted. Send it again.";

    const deltaCommandId = yield* serverCommandId("user-input-failure-reply-delta");
    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: deltaCommandId,
      threadId: input.threadId,
      messageId,
      delta: text,
      ...(turnId ? { turnId } : {}),
      createdAt: input.createdAt,
    });
    const completeCommandId = yield* serverCommandId("user-input-failure-reply-complete");
    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: completeCommandId,
      threadId: input.threadId,
      messageId,
      ...(turnId ? { turnId } : {}),
      createdAt: input.createdAt,
    });
  });

  const appendApprovalFailureReply = Effect.fn("appendApprovalFailureReply")(function* (input: {
    readonly threadId: ThreadId;
    readonly requestId: string;
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadDetail(input.threadId);

    if (!thread) return;

    const messageId = MessageId.make(
      `assistant:approval-response-failed:${input.threadId}:${input.requestId}`,
    );

    if (thread.messages.some((message) => message.id === messageId)) return;
    const turnId = thread.session?.activeTurnId ?? undefined;

    const text =
      "I could not continue that approval because the bot session restarted. Send it again.";

    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.delta",
      commandId: yield* serverCommandId("approval-failure-reply-delta"),
      threadId: input.threadId,
      messageId,
      delta: text,
      ...(turnId ? { turnId } : {}),
      createdAt: input.createdAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.message.assistant.complete",
      commandId: yield* serverCommandId("approval-failure-reply-complete"),
      threadId: input.threadId,
      messageId,
      ...(turnId ? { turnId } : {}),
      createdAt: input.createdAt,
    });
  });

  const formatFailureDetail = (cause: Cause.Cause<unknown>): string => {
    const failReason = cause.reasons.find(Cause.isFailReason);
    const capError = isBotUsageCapExceeded(failReason?.error) ? failReason.error : undefined;

    if (capError) return capError.message;

    const composioError = isComposioOperationError(failReason?.error)
      ? failReason.error
      : undefined;

    if (composioError) return composioError.message;

    return readableErrorDetail(failReason ? failReason.error : Cause.squash(cause));
  };

  const formatFailure = (cause: Cause.Cause<unknown>) => {
    const detail = formatFailureDetail(cause);
    const failReason = cause.reasons.find(Cause.isFailReason);

    if (isBotUsageCapExceeded(failReason?.error)) {
      return { detail, unavailability: "usage-cap" as const };
    }

    const provider = isProviderAdapterRequestError(failReason?.error)
      ? failReason.error.provider
      : "unknown";

    return { detail, unavailability: providerUnavailabilityFromDetail(provider, detail) } as const;
  };

  const setThreadSession = (input: {
    readonly threadId: ThreadId;
    readonly session: OrchestrationSession;
    readonly createdAt: string;
  }) =>
    serverCommandId("provider-session-set").pipe(
      Effect.flatMap((commandId) =>
        orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId,
          threadId: input.threadId,
          session: input.session,
          createdAt: input.createdAt,
        }),
      ),
    );

  const setThreadSessionErrorOnTurnStartFailure = Effect.fnUntraced(function* (input: {
    readonly threadId: ThreadId;
    readonly detail: string;
    readonly unavailability?: OrchestrationLatestTurn["unavailability"];
    readonly createdAt: string;
  }) {
    const thread = yield* resolveThreadShell(input.threadId);

    if (!thread) {
      return;
    }

    const session = thread.session;
    yield* setThreadSession({
      threadId: input.threadId,
      session: {
        ...(session
          ? withoutUnavailability(session)
          : {
              threadId: input.threadId,
              providerName: null,
              providerInstanceId: thread.modelSelection.instanceId,
              runtimeMode: thread.runtimeMode,
            }),
        status: session?.status === "stopped" ? "stopped" : "error",
        activeTurnId: null,
        lastError: input.detail,
        ...(input.unavailability ? { unavailability: input.unavailability } : {}),
        updatedAt: input.createdAt,
      },
      createdAt: input.createdAt,
    });
  });

  return {
    failDelegation,
    failDelegationStart,
    appendProviderFailureActivity,
    appendUserInputFailureReply,
    appendApprovalFailureReply,
    formatFailureDetail,
    formatFailure,
    setThreadSession,
    setThreadSessionErrorOnTurnStartFailure,
  };
}
