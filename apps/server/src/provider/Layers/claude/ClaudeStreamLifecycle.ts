/**
 * ClaudeAdapterLive - Scoped live implementation for the Claude Agent provider adapter.
 *
 * Wraps `@anthropic-ai/claude-agent-sdk` query sessions behind the generic
 * provider adapter contract and emits canonical runtime events.
 *
 * @module ClaudeAdapterLive
 */
import { type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

import { EventId, type ProviderRuntimeEvent, RuntimeTaskId, ThreadId } from "@akeru/contracts";

import * as Cause from "effect/Cause";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as Fiber from "effect/Fiber";

import * as Queue from "effect/Queue";

import * as Stream from "effect/Stream";

import { ProviderAdapterProcessError, ProviderAdapterRequestError } from "../../Errors.ts";

import { PROVIDER, type ClaudeSessionContext } from "./ClaudeAdapterState.ts";
import {
  asCanonicalTurnId,
  asRuntimeRequestId,
  nativeProviderRefs,
} from "./ClaudeProtocolValues.ts";
import { taskLinkageFor } from "./ClaudeTasks.ts";
import { isClaudeInterruptedCause } from "./ClaudeUsage.ts";

export function createClaudeStreamLifecycle(deps: {
  readonly handleSdkMessage: (
    context: ClaudeSessionContext,
    message: SDKMessage,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly completeTurn: (
    context: ClaudeSessionContext,
    status: "completed" | "failed" | "interrupted" | "cancelled",
    errorMessage?: string | undefined,
    result?: SDKResultMessage | undefined,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly emitRuntimeError: (
    context: ClaudeSessionContext,
    message: string,
    cause?: unknown,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
  readonly nowIso: Effect.Effect<string, never, never>;
  readonly sessions: Map<ThreadId, ClaudeSessionContext>;
}) {
  const runSdkStream = (
    context: ClaudeSessionContext,
  ): Effect.Effect<void, ProviderAdapterProcessError> =>
    Stream.fromAsyncIterable(
      context.query,
      (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Claude runtime stream failed.",
          cause,
        }),
    ).pipe(
      Stream.takeWhile(() => !context.stopped),
      Stream.runForEach((message) =>
        deps.handleSdkMessage(context, message).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: context.session.threadId,
                detail: "Failed to process Claude runtime event.",
                cause,
              }),
          ),
        ),
      ),
    );

  const handleStreamExit = Effect.fn("handleStreamExit")(function* (
    context: ClaudeSessionContext,
    exit: Exit.Exit<void, ProviderAdapterProcessError>,
  ) {
    if (context.stopped) {
      return;
    }

    if (Exit.isFailure(exit)) {
      if (isClaudeInterruptedCause(exit.cause)) {
        if (context.turnState) {
          yield* deps.completeTurn(context, "interrupted", "Claude runtime interrupted.");
        }
      } else {
        const failures = exit.cause.reasons.flatMap((reason) =>
          Cause.isFailReason(reason) ? [reason.error] : [],
        );

        const message = failures[0]?.detail ?? "Claude runtime stream failed.";
        yield* deps.emitRuntimeError(context, message, {
          failureCount: failures.length,
          failureTags: failures.map((failure) => failure._tag),
        });
        yield* deps.completeTurn(context, "failed", message);
      }
    } else if (context.turnState) {
      yield* deps.completeTurn(context, "interrupted", "Claude runtime stream ended.");
    }

    yield* stopSessionInternal(context, {
      emitExitEvent: true,
    });
  });

  const stopSessionInternal = Effect.fn("stopSessionInternal")(function* (
    context: ClaudeSessionContext,
    options?: { readonly emitExitEvent?: boolean },
  ) {
    if (context.stopped) return;

    // Schedule process termination before any cleanup that can wait on the
    // provider. The SDK closes stdin, then escalates from SIGTERM to SIGKILL.
    yield* Effect.try({
      try: () => context.query.close(),
      catch: (cause) =>
        new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.session.threadId,
          detail: "Failed to close Claude runtime query.",
          cause,
        }),
    });

    context.stopped = true;

    for (const taskId of Array.from(context.liveTaskIds)) {
      if (!context.liveTaskIds.delete(taskId)) {
        continue;
      }

      const stamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "task.completed",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        payload: {
          taskId: RuntimeTaskId.make(taskId),
          status: "stopped",
          ...taskLinkageFor(context.taskAgents, taskId),
        },
        providerRefs: nativeProviderRefs(context),
      });
    }

    for (const [requestId, pending] of context.pendingApprovals) {
      yield* Deferred.succeed(pending.decision, "cancel");
      const stamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "request.resolved",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        ...(context.turnState ? { turnId: asCanonicalTurnId(context.turnState.turnId) } : {}),
        requestId: asRuntimeRequestId(requestId),
        payload: {
          requestType: pending.requestType,
          decision: "cancel",
        },
        providerRefs: nativeProviderRefs(context),
      });
    }

    context.pendingApprovals.clear();

    // Same reason as the approvals above: a request nobody can answer any more
    // must not stay open, or the thread can never be settled.
    for (const pending of context.pendingUserInputs.values()) {
      yield* pending.cancel;
    }

    if (context.turnState) {
      yield* deps.completeTurn(context, "interrupted", "Session stopped.");
    }

    yield* Queue.shutdown(context.promptQueue);

    const streamFiber = context.streamFiber;
    context.streamFiber = undefined;

    if (streamFiber && streamFiber.pollUnsafe() === undefined) {
      yield* Fiber.interrupt(streamFiber);
    }

    const updatedAt = yield* deps.nowIso;
    context.session = {
      ...context.session,
      status: "closed",
      activeTurnId: undefined,
      updatedAt,
    };

    if (
      options?.emitExitEvent !== false &&
      deps.sessions.get(context.session.threadId) === context
    ) {
      const stamp = yield* deps.makeEventStamp();
      yield* deps.offerRuntimeEvent({
        type: "session.exited",
        eventId: stamp.eventId,
        provider: PROVIDER,
        createdAt: stamp.createdAt,
        threadId: context.session.threadId,
        payload: {
          reason: "Session stopped",
          exitKind: "graceful",
        },
        providerRefs: {},
      });
    }

    if (deps.sessions.get(context.session.threadId) === context) {
      deps.sessions.delete(context.session.threadId);
    }
  });

  return { runSdkStream, handleStreamExit, stopSessionInternal };
}
