import type { ProviderDriverKind } from "@akeru/contracts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import {
  EventId,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";

import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderAdapterRequestError } from "../../Errors.ts";

import {
  OpenCodeRuntimeError,
  openCodeRuntimeErrorDetail,
  runOpenCodeSdk,
} from "../../opencodeRuntime.ts";
import {
  PROVIDER,
  type OpenCodeSubscribedEvent,
  type OpenCodeRoutedRequestEvent,
  type OpenCodeTextPartState,
  type OpenCodeSessionContext,
  type EventBaseInput,
} from "./OpenCodeAdapterState.ts";
import {
  openCodeEventSessionId,
  openCodeEventSessionTitle,
  isOpenCodeChildRequestEvent,
  nowIso,
  toToolLifecycleItemType,
  sessionErrorMessage,
  updateProviderSession,
} from "./OpenCodeProtocol.ts";
import {
  forgetOpenCodeTextPart,
  retainOpenCodeTextPart,
  forgetOpenCodeTextMessage,
  resolveTextStreamKind,
  mergeOpenCodeAssistantText,
  appendOpenCodeAssistantTextDelta,
  isoFromEpochMs,
  messageRoleForPart,
  detailFromToolPart,
  toolStateCreatedAt,
} from "./OpenCodeText.ts";

export function createOpenCodeEvents(deps: {
  readonly emit: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
  readonly buildEventBase: (input: EventBaseInput) => Effect.Effect<
    {
      raw?: { source: "opencode.sdk.event"; payload: {} | null };
      requestId?: RuntimeRequestId;
      itemId?: RuntimeItemId;
      turnId?: TurnId;
      eventId: EventId;
      provider: ProviderDriverKind;
      threadId: ThreadId;
      createdAt: string;
    },
    ProviderAdapterRequestError,
    never
  >;
  readonly addRelatedOpenCodeSession: (context: OpenCodeSessionContext, sessionId: string) => void;
  readonly scheduleRequestRelationRetry: (
    context: OpenCodeSessionContext,
    event: OpenCodeRoutedRequestEvent,
  ) => Effect.Effect<void, never, never>;
  readonly writeNativeEventBestEffort: (
    threadId: ThreadId,
    event: { readonly observedAt: string; readonly event: Record<string, unknown> },
  ) => Effect.Effect<void, never, never>;
  readonly emitOpenCodeRequestEvent: (
    context: OpenCodeSessionContext,
    event: OpenCodeRoutedRequestEvent,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly emitUnexpectedExit: (
    context: OpenCodeSessionContext,
    message: string,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
}) {
  const emitAssistantTextDelta = Effect.fn("emitAssistantTextDelta")(function* (
    context: OpenCodeSessionContext,
    part: OpenCodeTextPartState,
    turnId: TurnId | undefined,
    raw: unknown,
  ) {
    const text = part.text;

    if (text === undefined) {
      return;
    }

    const { latestText, deltaToEmit } = mergeOpenCodeAssistantText(part.emittedText, text);
    part.emittedText = latestText;
    part.text = latestText;

    if (deltaToEmit.length > 0) {
      yield* deps.emit({
        ...(yield* deps.buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt:
            (part.type === "text" || part.type === "reasoning") && part.time !== undefined
              ? isoFromEpochMs(part.time.start)
              : undefined,
          raw,
        })),
        type: "content.delta",
        payload: {
          streamKind: resolveTextStreamKind(part),
          delta: deltaToEmit,
        },
      });
    }

    if (part.type === "text" && part.time?.end !== undefined && !part.completed) {
      part.completed = true;
      yield* deps.emit({
        ...(yield* deps.buildEventBase({
          threadId: context.session.threadId,
          turnId,
          itemId: part.id,
          createdAt: isoFromEpochMs(part.time.end),
          raw,
        })),
        type: "item.completed",
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(latestText.length > 0 ? { detail: latestText } : {}),
        },
      });
    }
  });

  const handleSubscribedEvent = Effect.fn("handleSubscribedEvent")(function* (
    context: OpenCodeSessionContext,
    event: OpenCodeSubscribedEvent,
  ) {
    if (event.type === "session.created" || event.type === "session.updated") {
      const session = event.properties.info;

      if (session.parentID && context.relatedSessionIds.has(session.parentID)) {
        deps.addRelatedOpenCodeSession(context, session.id);
      }
    } else if (event.type === "session.deleted") {
      context.relatedSessionIds.delete(event.properties.info.id);
    }

    const payloadSessionId = openCodeEventSessionId(event);
    const isParentEvent = payloadSessionId === context.openCodeSessionId;
    let isKnownPendingTerminalEvent = false;

    if (
      payloadSessionId !== undefined &&
      !context.relatedSessionIds.has(payloadSessionId) &&
      isOpenCodeChildRequestEvent(event)
    ) {
      if (
        event.type === "permission.asked" ||
        event.type === "question.asked" ||
        event.type === "permission.replied" ||
        event.type === "question.replied" ||
        event.type === "question.rejected"
      ) {
        const requestId =
          event.type === "permission.asked" || event.type === "question.asked"
            ? event.properties.id
            : event.properties.requestID;

        isKnownPendingTerminalEvent =
          event.type !== "permission.asked" &&
          event.type !== "question.asked" &&
          (context.pendingPermissions.has(requestId) || context.pendingQuestions.has(requestId));

        if (!isKnownPendingTerminalEvent) {
          yield* deps.scheduleRequestRelationRetry(context, event);

          return;
        }
      }
    }

    const isChildRequestEvent =
      payloadSessionId !== undefined &&
      isOpenCodeChildRequestEvent(event) &&
      (context.relatedSessionIds.has(payloadSessionId) || isKnownPendingTerminalEvent);

    if (!isParentEvent && !isChildRequestEvent) {
      return;
    }

    const turnId = context.activeTurnId;
    yield* deps.writeNativeEventBestEffort(context.session.threadId, {
      observedAt: yield* nowIso,
      event: {
        provider: PROVIDER,
        threadId: context.session.threadId,
        providerThreadId: context.openCodeSessionId,
        type: event.type,
        ...(turnId ? { turnId } : {}),
        payload: event,
      },
    });

    switch (event.type) {
      case "session.updated": {
        const title = openCodeEventSessionTitle(event);

        if (title) {
          yield* deps.emit({
            ...(yield* deps.buildEventBase({
              threadId: context.session.threadId,
              raw: event,
            })),
            type: "thread.metadata.updated",
            payload: {
              name: title,
              metadata: {
                sessionID: context.openCodeSessionId,
              },
            },
          });
        }

        break;
      }

      case "message.updated": {
        context.messageRoleById.set(event.properties.info.id, event.properties.info.role);

        if (event.properties.info.role === "assistant") {
          const parts = context.textPartsByMessageId.get(event.properties.info.id);

          if (parts) {
            for (const part of parts.values()) {
              yield* emitAssistantTextDelta(context, part, turnId, event);
            }
          }
        }

        break;
      }

      case "message.removed": {
        context.messageRoleById.delete(event.properties.messageID);
        forgetOpenCodeTextMessage(context, event.properties.messageID);
        break;
      }

      case "message.part.removed": {
        forgetOpenCodeTextPart(context, event.properties.partID);
        break;
      }

      case "message.part.delta": {
        const existingPart = context.textPartById.get(event.properties.partID);

        if (!existingPart) {
          break;
        }

        const role = messageRoleForPart(context, existingPart);

        if (role !== "assistant") {
          break;
        }

        const streamKind = resolveTextStreamKind(existingPart);
        const delta = event.properties.delta;

        if (delta.length === 0) {
          break;
        }

        const previousText = existingPart.emittedText ?? existingPart.text ?? "";
        const { nextText, deltaToEmit } = appendOpenCodeAssistantTextDelta(previousText, delta);

        if (deltaToEmit.length === 0) {
          break;
        }

        existingPart.emittedText = nextText;
        existingPart.text = nextText;
        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: event.properties.partID,
            raw: event,
          })),
          type: "content.delta",
          payload: {
            streamKind,
            delta: deltaToEmit,
          },
        });
        break;
      }

      case "message.part.updated": {
        const part = event.properties.part;
        const messageRole = messageRoleForPart(context, part);

        if (part.type === "text" || part.type === "reasoning") {
          const state = retainOpenCodeTextPart(context, part);

          if (messageRole === "assistant") {
            yield* emitAssistantTextDelta(context, state, turnId, event);
          }
        }

        if (part.type === "tool") {
          const itemType = toToolLifecycleItemType(part.tool);

          const title =
            part.state.status === "running" ? (part.state.title ?? part.tool) : part.tool;

          const detail = detailFromToolPart(part);

          const payload = {
            itemType,
            ...(part.state.status === "error"
              ? { status: "failed" as const }
              : part.state.status === "completed"
                ? { status: "completed" as const }
                : { status: "inProgress" as const }),
            ...(title ? { title } : {}),
            ...(detail ? { detail } : {}),
            data: {
              tool: part.tool,
              state: part.state,
            },
          };

          const runtimeEvent: ProviderRuntimeEvent = {
            ...(yield* deps.buildEventBase({
              threadId: context.session.threadId,
              turnId,
              itemId: part.callID,
              createdAt: toolStateCreatedAt(part),
              raw: event,
            })),
            type:
              part.state.status === "pending"
                ? "item.started"
                : part.state.status === "completed" || part.state.status === "error"
                  ? "item.completed"
                  : "item.updated",
            payload,
          };

          yield* deps.emit(runtimeEvent);
        }

        break;
      }

      case "permission.asked":
      case "permission.replied":
      case "question.asked":
      case "question.replied":
      case "question.rejected": {
        yield* deps.emitOpenCodeRequestEvent(context, event);
        break;
      }

      case "session.status": {
        if (event.properties.status.type === "busy") {
          yield* updateProviderSession(context, {
            status: "running",
            activeTurnId: turnId,
          });
        }

        if (event.properties.status.type === "retry") {
          yield* deps.emit({
            ...(yield* deps.buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "runtime.warning",
            payload: {
              message: event.properties.status.message,
              detail: event.properties.status,
            },
          });
          break;
        }

        if (event.properties.status.type === "idle" && turnId) {
          context.activeTurnId = undefined;
          yield* updateProviderSession(context, { status: "ready" }, { clearActiveTurnId: true });
          yield* deps.emit({
            ...(yield* deps.buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: event,
            })),
            type: "turn.completed",
            payload: {
              state: "completed",
            },
          });
        }

        break;
      }

      case "session.error": {
        const message = sessionErrorMessage(event.properties.error);
        const activeTurnId = context.activeTurnId;
        context.activeTurnId = undefined;
        yield* updateProviderSession(
          context,
          {
            status: "error",
            lastError: message,
          },
          { clearActiveTurnId: true },
        );

        if (activeTurnId) {
          yield* deps.emit({
            ...(yield* deps.buildEventBase({
              threadId: context.session.threadId,
              turnId: activeTurnId,
              raw: event,
            })),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: message,
            },
          });
        }

        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            raw: event,
          })),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            detail: event.properties.error,
          },
        });
        break;
      }

      default:
        break;
    }
  });

  const startEventPump = Effect.fn("startEventPump")(function* (context: OpenCodeSessionContext) {
    // One AbortController per session scope. The finalizer fires when
    // the scope closes (explicit stop, unexpected exit, or layer
    // shutdown) and cancels the in-flight `event.subscribe` fetch so
    // the async iterable unwinds cleanly.
    const eventsAbortController = new AbortController();
    yield* Scope.addFinalizer(
      context.sessionScope,
      Effect.sync(() => eventsAbortController.abort()),
    );

    // Fibers forked into `context.sessionScope` are interrupted
    // automatically when the scope closes — no bookkeeping required.
    yield* Effect.flatMap(
      runOpenCodeSdk("event.subscribe", () =>
        context.client.event.subscribe(undefined, {
          signal: eventsAbortController.signal,
        }),
      ),
      (subscription) =>
        Stream.fromAsyncIterable(
          subscription.stream,
          (cause) =>
            new OpenCodeRuntimeError({
              operation: "event.subscribe",
              detail: openCodeRuntimeErrorDetail(cause),
              cause,
            }),
        ).pipe(Stream.runForEach((event) => handleSubscribedEvent(context, event))),
    ).pipe(
      Effect.exit,
      Effect.flatMap((exit) =>
        Effect.gen(function* () {
          // Expected paths: caller aborted the fetch or the session
          // has already been marked stopped. Treat as a clean exit.
          if (eventsAbortController.signal.aborted || (yield* Ref.get(context.stopped))) {
            return;
          }

          if (Exit.isFailure(exit)) {
            yield* deps.emitUnexpectedExit(
              context,
              openCodeRuntimeErrorDetail(Cause.squash(exit.cause)),
            );
          }
        }),
      ),
      Effect.forkIn(context.sessionScope),
    );

    if (!context.server.external && context.server.exitCode !== null) {
      yield* context.server.exitCode.pipe(
        Effect.flatMap((code) =>
          Effect.gen(function* () {
            if (yield* Ref.get(context.stopped)) {
              return;
            }

            yield* deps.emitUnexpectedExit(
              context,
              `OpenCode server exited unexpectedly (${code}).`,
            );
          }),
        ),
        Effect.forkIn(context.sessionScope),
      );
    }
  });

  return { emitAssistantTextDelta, handleSubscribedEvent, startEventPump };
}
