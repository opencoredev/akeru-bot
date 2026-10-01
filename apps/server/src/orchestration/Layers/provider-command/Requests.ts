import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import {
  type ProviderIntentEvent,
  stalePendingRequestDetail,
  isUnknownPendingApprovalRequestError,
  withoutUnavailability,
  isRetryableUserInputResponseError,
  isUnknownPendingUserInputRequestError,
} from "./Fields.ts";
import type { createContext } from "./Context.ts";
import type { createFailures } from "./Failures.ts";
import type { createDependencies } from "./Dependencies.ts";
export function createRequests({
  resolveThreadShell,
  appendProviderFailureActivity,
  appendApprovalFailureReply,
  agentController,
  formatFailureDetail,
  setThreadSession,
  appendUserInputFailureReply,
}: Pick<
  ReturnType<typeof createContext> &
    ReturnType<typeof createFailures> &
    Effect.Success<ReturnType<typeof createDependencies>>,
  | "resolveThreadShell"
  | "appendProviderFailureActivity"
  | "appendApprovalFailureReply"
  | "agentController"
  | "formatFailureDetail"
  | "setThreadSession"
  | "appendUserInputFailureReply"
>) {
  const processApprovalResponseRequested = Effect.fn("processApprovalResponseRequested")(function* (
    event: Extract<ProviderIntentEvent, { type: "thread.approval-response-requested" }>,
  ) {
    const thread = yield* resolveThreadShell(event.payload.threadId);
    if (!thread) {
      return;
    }
    const session = thread.session;
    if (!session || session.status === "stopped") {
      yield* appendProviderFailureActivity({
        threadId: event.payload.threadId,
        kind: "provider.approval.respond.failed",
        summary: "Provider approval response failed",
        detail: stalePendingRequestDetail("approval", event.payload.requestId),
        turnId: null,
        createdAt: event.payload.createdAt,
        requestId: event.payload.requestId,
      });
      return yield* appendApprovalFailureReply({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        createdAt: event.payload.createdAt,
      });
    }

    yield* agentController
      .respondToRequest({
        threadId: event.payload.threadId,
        requestId: event.payload.requestId,
        decision: event.payload.decision,
      })
      .pipe(
        Effect.catchCause((cause) => {
          const detail = isUnknownPendingApprovalRequestError(cause)
            ? stalePendingRequestDetail("approval", event.payload.requestId)
            : formatFailureDetail(cause);
          return Effect.gen(function* () {
            yield* Effect.logWarning("provider approval response failed", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            });
            yield* appendProviderFailureActivity({
              threadId: event.payload.threadId,
              kind: "provider.approval.respond.failed",
              summary: "Provider approval response failed",
              detail,
              turnId: null,
              createdAt: event.payload.createdAt,
              requestId: event.payload.requestId,
            });
            yield* appendApprovalFailureReply({
              threadId: event.payload.threadId,
              requestId: event.payload.requestId,
              createdAt: event.payload.createdAt,
            });
            yield* setThreadSession({
              threadId: event.payload.threadId,
              session: {
                ...withoutUnavailability(session),
                status: "error",
                activeTurnId: null,
                lastError: detail,
                updatedAt: event.payload.createdAt,
              },
              createdAt: event.payload.createdAt,
            });
          });
        }),
      );
  });

  const processUserInputResponseRequested = Effect.fn("processUserInputResponseRequested")(
    function* (
      event: Extract<ProviderIntentEvent, { type: "thread.user-input-response-requested" }>,
    ) {
      const thread = yield* resolveThreadShell(event.payload.threadId);
      if (!thread) {
        return;
      }
      const hasSession = thread.session && thread.session.status !== "stopped";
      if (!hasSession) {
        yield* appendProviderFailureActivity({
          threadId: event.payload.threadId,
          kind: "provider.user-input.respond.failed",
          summary: "Provider user input response failed",
          detail: stalePendingRequestDetail("user-input", event.payload.requestId),
          turnId: null,
          createdAt: event.payload.createdAt,
          requestId: event.payload.requestId,
        });
        return yield* appendUserInputFailureReply({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          createdAt: event.payload.createdAt,
        });
      }

      yield* agentController
        .respondToUserInput({
          threadId: event.payload.threadId,
          requestId: event.payload.requestId,
          answers: event.payload.answers,
        })
        .pipe(
          Effect.catchCause((cause) => {
            const retryable = isRetryableUserInputResponseError(cause);
            const providerFailed = !retryable && !isUnknownPendingUserInputRequestError(cause);
            const failureDetail = formatFailureDetail(cause);
            // The stale marker closes the question; a provider failure keeps its real cause.
            const detail = retryable
              ? failureDetail
              : providerFailed
                ? `Stale pending user-input request: ${event.payload.requestId}. ${failureDetail}`
                : stalePendingRequestDetail("user-input", event.payload.requestId);
            return Effect.gen(function* () {
              yield* Effect.logWarning("provider user input response failed", {
                threadId: event.payload.threadId,
                cause: Cause.pretty(cause),
              });
              yield* appendProviderFailureActivity({
                threadId: event.payload.threadId,
                kind: "provider.user-input.respond.failed",
                summary: "Provider user input response failed",
                detail,
                turnId: null,
                createdAt: event.payload.createdAt,
                requestId: event.payload.requestId,
              });
              // The controller restored the question in its live turn, so it can be answered again.
              if (retryable) return;
              yield* appendUserInputFailureReply({
                threadId: event.payload.threadId,
                requestId: event.payload.requestId,
                createdAt: event.payload.createdAt,
                providerFailed,
              });
              if (thread.session) {
                yield* setThreadSession({
                  threadId: event.payload.threadId,
                  session: {
                    ...withoutUnavailability(thread.session),
                    status: "error",
                    activeTurnId: null,
                    lastError: providerFailed ? failureDetail : detail,
                    updatedAt: event.payload.createdAt,
                  },
                  createdAt: event.payload.createdAt,
                });
              }
            });
          }),
        );
    },
  );
  return { processApprovalResponseRequested, processUserInputResponseRequested };
}
