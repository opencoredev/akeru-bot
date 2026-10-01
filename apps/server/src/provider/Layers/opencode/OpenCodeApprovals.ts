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

import * as Effect from "effect/Effect";

import { ProviderAdapterRequestError } from "../../Errors.ts";

import {
  OpenCodeRuntimeError,
  openCodeQuestionId,
  openCodeRuntimeErrorDetail,
  runOpenCodeSdk,
} from "../../opencodeRuntime.ts";
import {
  type OpenCodeRoutedRequestEvent,
  type OpenCodeRequestRelationRetry,
  type OpenCodeSessionContext,
  type EventBaseInput,
} from "./OpenCodeAdapterState.ts";
import {
  mapPermissionToRequestType,
  mapPermissionDecision,
  normalizeQuestionRequest,
} from "./OpenCodeProtocol.ts";

export function createOpenCodeApprovals(deps: {
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
  readonly isRelatedOpenCodeSession: (
    context: OpenCodeSessionContext,
    candidateSessionId: string,
  ) => Effect.Effect<boolean, OpenCodeRuntimeError, never>;
}) {
  const emitOpenCodeRequestEvent = Effect.fn("emitOpenCodeRequestEvent")(function* (
    context: OpenCodeSessionContext,
    event: OpenCodeRoutedRequestEvent,
  ) {
    const turnId = context.activeTurnId;

    switch (event.type) {
      case "permission.asked": {
        if (context.pendingPermissions.has(event.properties.id)) {
          return;
        }

        if (context.session.runtimeMode === "full-access") {
          // Reply "once", not "always": OpenCode stores "always" grants per
          // directory, so an always from a full-access thread would widen a
          // supervised thread on the same directory.
          context.resolvedRequestIds.add(event.properties.id);
          context.autoRepliedRequestIds.add(event.properties.id);
          yield* runOpenCodeSdk("permission.reply", (signal) =>
            context.client.permission.reply(
              {
                requestID: event.properties.id,
                reply: "once",
              },
              { signal },
            ),
          ).pipe(
            Effect.timeout("10 seconds"),
            Effect.matchEffect({
              onSuccess: () => Effect.void,
              onFailure: () =>
                Effect.gen(function* () {
                  context.autoRepliedRequestIds.delete(event.properties.id);
                  context.pendingPermissions.set(event.properties.id, event.properties);
                  yield* deps.emit({
                    ...(yield* deps.buildEventBase({
                      threadId: context.session.threadId,
                      turnId,
                      requestId: event.properties.id,
                      raw: event,
                    })),
                    type: "request.opened",
                    payload: {
                      requestType: mapPermissionToRequestType(event.properties.permission),
                      detail:
                        event.properties.patterns.length > 0
                          ? event.properties.patterns.join("\n")
                          : event.properties.permission,
                    },
                  });
                }),
            }),
            Effect.forkIn(context.sessionScope),
          );

          return;
        }

        context.pendingPermissions.set(event.properties.id, event.properties);
        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: event.properties.id,
            raw: event,
          })),
          type: "request.opened",
          payload: {
            requestType: mapPermissionToRequestType(event.properties.permission),
            detail:
              event.properties.patterns.length > 0
                ? event.properties.patterns.join("\n")
                : event.properties.permission,
          },
        });

        return;
      }

      case "permission.replied": {
        context.pendingPermissions.delete(event.properties.requestID);
        context.resolvedRequestIds.add(event.properties.requestID);

        if (context.autoRepliedRequestIds.delete(event.properties.requestID)) {
          return;
        }

        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: event.properties.requestID,
            raw: event,
          })),
          type: "request.resolved",
          payload: {
            requestType: "unknown",
            decision: mapPermissionDecision(event.properties.reply),
          },
        });

        return;
      }

      case "question.asked": {
        if (context.pendingQuestions.has(event.properties.id)) {
          return;
        }

        context.pendingQuestions.set(event.properties.id, event.properties);
        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: event.properties.id,
            raw: event,
          })),
          type: "user-input.requested",
          payload: {
            questions: normalizeQuestionRequest(event.properties),
          },
        });

        return;
      }

      case "question.replied": {
        const request = context.pendingQuestions.get(event.properties.requestID);
        context.pendingQuestions.delete(event.properties.requestID);
        context.resolvedRequestIds.add(event.properties.requestID);

        const answers = Object.fromEntries(
          (request?.questions ?? []).map((question, index) => [
            openCodeQuestionId(index, question),
            event.properties.answers[index]?.join(", ") ?? "",
          ]),
        );

        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: event.properties.requestID,
            raw: event,
          })),
          type: "user-input.resolved",
          payload: { answers },
        });

        return;
      }

      case "question.rejected": {
        context.pendingQuestions.delete(event.properties.requestID);
        context.resolvedRequestIds.add(event.properties.requestID);
        yield* deps.emit({
          ...(yield* deps.buildEventBase({
            threadId: context.session.threadId,
            turnId,
            requestId: event.properties.requestID,
            raw: event,
          })),
          type: "user-input.resolved",
          payload: { answers: {} },
        });
      }
    }
  });

  const scheduleRequestRelationRetry = Effect.fn("scheduleRequestRelationRetry")(function* (
    context: OpenCodeSessionContext,
    event: OpenCodeRoutedRequestEvent,
  ) {
    const isAskedEvent = event.type === "permission.asked" || event.type === "question.asked";
    const requestId = isAskedEvent ? event.properties.id : event.properties.requestID;
    const existing = context.requestRelationRetries.get(requestId);

    if (existing) {
      if (!isAskedEvent) {
        existing.terminalEvent = event;
      }

      return;
    }

    if (isAskedEvent && context.resolvedRequestIds.has(requestId)) {
      return;
    }

    const retry: OpenCodeRequestRelationRetry = {
      warned: false,
      event,
      ...(!isAskedEvent ? { terminalEvent: event } : {}),
    };

    context.requestRelationRetries.set(requestId, retry);

    const run = Effect.gen(function* () {
      let retryCount = 0;

      while (context.requestRelationRetries.get(requestId) === retry) {
        const relation = yield* deps
          .isRelatedOpenCodeSession(context, event.properties.sessionID)
          .pipe(
            Effect.match({
              onFailure: (cause) => ({ type: "unknown" as const, cause }),
              onSuccess: (related) => ({ type: "known" as const, related }),
            }),
          );

        if (context.requestRelationRetries.get(requestId) !== retry) {
          return;
        }

        if (relation.type === "known") {
          context.requestRelationRetries.delete(requestId);

          if (relation.related) {
            yield* emitOpenCodeRequestEvent(context, retry.event);

            if (retry.terminalEvent && retry.terminalEvent !== retry.event) {
              yield* emitOpenCodeRequestEvent(context, retry.terminalEvent);
            }
          }

          return;
        }

        if (!retry.warned) {
          retry.warned = true;
          yield* deps.emit({
            ...(yield* deps.buildEventBase({
              threadId: context.session.threadId,
              requestId,
            })),
            type: "runtime.warning",
            payload: {
              message: "OpenCode request routing is waiting for session ancestry.",
              detail: openCodeRuntimeErrorDetail(relation.cause),
            },
          });
        }

        const delayMs = Math.min(250 * 2 ** retryCount, 5_000);
        retryCount += 1;

        if (!isAskedEvent && retryCount >= 5) {
          return;
        }

        yield* Effect.sleep(`${delayMs} millis`);
      }
    }).pipe(
      Effect.catchCause(() => Effect.void),
      Effect.ensuring(
        Effect.sync(() => {
          if (context.requestRelationRetries.get(requestId) === retry) {
            context.requestRelationRetries.delete(requestId);
          }
        }),
      ),
    );

    retry.fiber = yield* run.pipe(Effect.forkIn(context.sessionScope));
  });

  return { emitOpenCodeRequestEvent, scheduleRequestRelationRetry };
}
