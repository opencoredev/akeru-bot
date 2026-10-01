import { UserInputResolution } from "./grok/GrokAdapterState.ts";
import * as Predicate from "effect/Predicate";
import { createGrokEvents } from "./grok/GrokEvents.ts";
import { createGrokTurnLifecycle } from "./grok/GrokTurnLifecycle.ts";
import { createGrokSessionLifecycle } from "./grok/GrokSessionLifecycle.ts";
import {
  type GrokSettings,
  EventId,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";

// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Adapter composition root configures its ACP native log factory.
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { applyGrokAcpModelSelection, resolveGrokAcpBaseModelId } from "../acp/GrokAcpSupport.ts";

import { type GrokAdapterShape } from "../Services/GrokAdapter.ts";
import { type EventNdjsonLogger } from "./logging/EventLogTypes.ts";
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Adapter composition root creates the scoped logger with this adapter configuration.
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

import { PROVIDER, type GrokSessionContext } from "./grok/GrokAdapterState.ts";
import {
  settlePendingApprovalsAsCancelled,
  settlePendingUserInputsAsCancelled,
  appendPromptResultToTurn,
  completedStopReasonFromPromptResponse,
} from "./grok/GrokProtocol.ts";

export interface GrokAdapterLiveOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  readonly instanceId?: ProviderInstanceId;
}

export function makeGrokAdapter(grokSettings: GrokSettings, options?: GrokAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("grok");
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;

    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);

    const managedNativeEventLogger =
      options?.nativeEventLogger === undefined ? nativeEventLogger : undefined;

    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, GrokSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate Grok runtime identifier.",
            cause,
          }),
      ),
    );

    const nextEventId = Effect.map(randomUUIDv4, (id) => EventId.make(id));
    const makeEventStamp = () => Effect.all({ eventId: nextEventId, createdAt: nowIso });

    const mapAcpCallbackFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpTransportError({
              detail: "Failed to process Grok ACP callback.",
              cause,
            }),
        ),
      );

    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) => {
        const existing: Option.Option<Semaphore.Semaphore> = Option.fromNullishOr(
          current.get(threadId),
        );

        return Option.match(existing, {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);

                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        });
      });

    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const { settlePromptInFlight } = createGrokTurnLifecycle({
      sessions,
      offerRuntimeEvent,
      makeEventStamp,
      nowIso,
    });

    const { logNative, emitPlanUpdate } = createGrokEvents({
      nativeEventLogger,
      nowIso,
      randomUUIDv4,
      offerRuntimeEvent,
    });

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);

      if (!ctx || ctx.stopped) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }),
        );
      }

      return Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: GrokSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
        yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);

        if (ctx.notificationFiber) {
          yield* Fiber.interrupt(ctx.notificationFiber);
        }

        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const { startSession } = createGrokSessionLifecycle({
      nativeEventLogger,
      childProcessSpawner,
      withThreadLock,
      path,
      boundInstanceId,
      sessions,
      stopSessionInternal,
      makeAcpNativeLoggers,
      grokSettings,
      serverConfig,
      options,
      fileSystem,
      crypto,
      mapAcpCallbackFailure,
      logNative,
      randomUUIDv4,
      offerRuntimeEvent,
      makeEventStamp,
      nowIso,
      emitPlanUpdate,
    });

    const sendTurn: GrokAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const prepared = yield* withThreadLock(
          input.threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(input.threadId);
            // A sendTurn while a prompt is in flight is a steer: reuse the
            // active turn and cancel the in-flight ACP prompt so Grok takes
            // the new instruction immediately, matching Claude/Codex, instead
            // of waiting behind serialized session/prompt.
            const steeringTurnId = ctx.promptsInFlight > 0 ? ctx.activeTurnId : undefined;
            const turnId = steeringTurnId ?? TurnId.make(yield* randomUUIDv4);
            // Count this prompt immediately so a superseded in-flight prompt
            // resolving from here on does not settle the turn; decremented on
            // preparation failure here, and after the prompt below otherwise.
            ctx.promptsInFlight += 1;
            ctx.promptEpoch += 1;
            const promptEpoch = ctx.promptEpoch;
            // Bind the turn id before cooperative yields so interruptTurn can
            // settle this prompt even if stop arrives during preparation.
            ctx.activeTurnId = turnId;
            ctx.session = {
              ...ctx.session,
              status: steeringTurnId === undefined ? "connecting" : "running",
              activeTurnId: turnId,
              updatedAt: yield* nowIso,
            };

            return yield* Effect.gen(function* () {
              const turnModelSelection =
                input.modelSelection?.instanceId === boundInstanceId
                  ? input.modelSelection
                  : undefined;

              const requestedTurnModelId = turnModelSelection?.model
                ? resolveGrokAcpBaseModelId(turnModelSelection.model)
                : undefined;

              const currentModelId = yield* applyGrokAcpModelSelection({
                runtime: ctx.acp,
                currentModelId: ctx.currentModelId,
                requestedModelId: requestedTurnModelId,
                mapError: (cause) =>
                  mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
              });

              const text = input.input?.trim();

              const imagePromptParts = yield* Effect.forEach(
                (input.attachments ?? []).filter((attachment) => attachment.type === "image"),
                (attachment) =>
                  Effect.gen(function* () {
                    const attachmentPath = resolveAttachmentPath({
                      attachmentsDir: serverConfig.attachmentsDir,
                      attachment,
                    });

                    if (!attachmentPath) {
                      return yield* new ProviderAdapterRequestError({
                        provider: PROVIDER,
                        method: "session/prompt",
                        detail: `Invalid attachment id '${attachment.id}'.`,
                      });
                    }

                    const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderAdapterRequestError({
                            provider: PROVIDER,
                            method: "session/prompt",
                            detail: cause.message,
                            cause,
                          }),
                      ),
                    );

                    return {
                      type: "image",
                      data: Buffer.from(bytes).toString("base64"),
                      mimeType: attachment.mimeType,
                    } satisfies EffectAcpSchema.ContentBlock;
                  }),
              );

              const promptParts: Array<EffectAcpSchema.ContentBlock> = [
                ...(text ? [{ type: "text" as const, text }] : []),
                ...imagePromptParts,
              ];

              if (promptParts.length === 0) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "sendTurn",
                  issue: "Turn requires non-empty text or attachments.",
                });
              }

              ctx.currentModelId = currentModelId;

              const displayModel = currentModelId
                ? resolveGrokAcpBaseModelId(currentModelId)
                : undefined;

              if (ctx.interruptedTurnIds.has(turnId)) {
                yield* settlePromptInFlight(input.threadId, turnId, ctx.acpSessionId, {
                  completedStopReason: "cancelled",
                  emitTurnCompletion: false,
                  settleAllPrompts: true,
                  promptEpoch,
                });

                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok prompt was interrupted during preparation.",
                });
              }

              if (steeringTurnId === undefined) {
                ctx.lastPlanFingerprint = undefined;
              }

              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: turnId,
                updatedAt: yield* nowIso,
                ...(displayModel ? { model: displayModel } : {}),
              };

              if (steeringTurnId === undefined) {
                yield* offerRuntimeEvent({
                  type: "turn.started",
                  ...(yield* makeEventStamp()),
                  provider: PROVIDER,
                  threadId: input.threadId,
                  turnId,
                  payload: displayModel ? { model: displayModel } : {},
                });
              } else {
                // Discard the previous epoch only after this replacement is
                // ready. A failed steer must not skip the live prompt, which
                // settles without a terminal event when emitTurnCompletion is
                // false.
                yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
                yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
                ctx.discardBeforeEpoch = promptEpoch;
              }

              return {
                acp: ctx.acp,
                acpSessionId: ctx.acpSessionId,
                displayModel,
                promptParts,
                turnId,
                promptEpoch,
                promptLifecycle: ctx.promptLifecycle,
                steeringTurnId,
              };
            }).pipe(
              Effect.tapCause(() =>
                Effect.gen(function* () {
                  const liveCtx = sessions.get(input.threadId);

                  if (!liveCtx) {
                    return;
                  }

                  yield* settlePromptInFlight(input.threadId, turnId, liveCtx.acpSessionId, {
                    errorMessage: "Grok prompt preparation failed.",
                    emitTurnCompletion: false,
                    promptEpoch,
                  });
                }),
              ),
            );
          }),
        );

        const promptSettled = yield* Ref.make(false);
        const promptRpcSucceeded = yield* Ref.make(false);

        const promptResultRef = yield* Ref.make<EffectAcpSchema.PromptResponse | undefined>(
          undefined,
        );

        const promptFailureMessageRef = yield* Ref.make<string | undefined>(undefined);

        return yield* Effect.gen(function* () {
          const promptStart = yield* prepared.promptLifecycle.withPermit(
            Effect.gen(function* () {
              const liveCtx = sessions.get(input.threadId);
              const interrupted = liveCtx?.interruptedTurnIds.has(prepared.turnId) === true;

              if (
                !liveCtx ||
                liveCtx.acpSessionId !== prepared.acpSessionId ||
                prepared.promptEpoch < liveCtx.discardBeforeEpoch ||
                interrupted
              ) {
                return { _tag: "Skipped" as const, interrupted };
              }

              if (prepared.steeringTurnId !== undefined) {
                yield* Effect.ignore(
                  liveCtx.acp.cancel.pipe(
                    Effect.mapError((error) =>
                      mapAcpToAdapterError(PROVIDER, input.threadId, "session/cancel", error),
                    ),
                  ),
                );
              }

              if (liveCtx.interruptedTurnIds.has(prepared.turnId)) {
                return { _tag: "Skipped" as const, interrupted: true };
              }

              const dispatched = yield* Deferred.make<void>();

              const fiber = yield* liveCtx.acp
                .prompt({ prompt: prepared.promptParts }, { dispatched })
                .pipe(Effect.forkChild);

              // Hold the lifecycle permit until the runtime has registered this
              // prompt's RPC fiber, so a later steer's session/cancel targets
              // this prompt. Fall through if the prompt fails before that point.
              yield* Effect.raceFirst(
                Deferred.await(dispatched),
                Fiber.await(fiber).pipe(Effect.asVoid),
              );

              return { _tag: "Started" as const, fiber };
            }),
          );

          if (Predicate.isTagged(promptStart, "Skipped")) {
            // Settle after releasing promptLifecycle. Holding both locks
            // deadlocks the next sendTurn, which takes the thread lock first.
            yield* withThreadLock(
              input.threadId,
              settlePromptInFlight(
                input.threadId,
                prepared.turnId,
                prepared.acpSessionId,
                promptStart.interrupted
                  ? {
                      completedStopReason: "cancelled",
                      settleAllPrompts: true,
                      promptEpoch: prepared.promptEpoch,
                    }
                  : {
                      emitTurnCompletion: false,
                      promptEpoch: prepared.promptEpoch,
                    },
              ),
            );
            yield* Ref.set(promptSettled, true);
            const liveCtx = sessions.get(input.threadId);

            return {
              threadId: input.threadId,
              turnId: prepared.turnId,
              resumeCursor: liveCtx?.session.resumeCursor,
            };
          }

          const result = yield* Fiber.join(promptStart.fiber).pipe(
            Effect.tap((promptResult) =>
              Effect.all([
                Ref.set(promptRpcSucceeded, true),
                Ref.set(promptResultRef, promptResult),
              ]),
            ),
            Effect.tapError((error) =>
              Ref.set(
                promptFailureMessageRef,
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error).message,
              ).pipe(Effect.andThen(prepared.acp.drainEvents)),
            ),
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
            ),
          );

          return yield* withThreadLock(
            input.threadId,
            Effect.gen(function* () {
              const ctx = yield* requireSession(input.threadId);

              if (ctx.acpSessionId !== prepared.acpSessionId) {
                yield* settlePromptInFlight(
                  input.threadId,
                  prepared.turnId,
                  prepared.acpSessionId,
                  {
                    errorMessage: "Grok session changed before the turn completed.",
                    settleAllPrompts: true,
                    promptEpoch: prepared.promptEpoch,
                  },
                );
                yield* Ref.set(promptSettled, true);

                return yield* new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "session/prompt",
                  detail: "Grok session changed before the turn completed.",
                });
              }

              // Keep prompt settlement atomic with respect to Stop and steering.
              // interruptTurn marks its target before waiting for this lock, so
              // cancellation can still win while queued ACP events are drained.
              for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
                yield* Effect.yieldNow;
              }

              yield* prepared.acp.drainEvents;

              if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                yield* Ref.set(promptSettled, true);

                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              if (
                ctx.promptsInFlight <= 0 ||
                ctx.activeTurnId !== prepared.turnId ||
                ctx.session.activeTurnId !== prepared.turnId
              ) {
                yield* Ref.set(promptSettled, true);

                return {
                  threadId: input.threadId,
                  turnId: prepared.turnId,
                  resumeCursor: ctx.session.resumeCursor,
                };
              }

              appendPromptResultToTurn(ctx, prepared.turnId, prepared.promptParts, result);
              ctx.session = {
                ...ctx.session,
                status: "running",
                activeTurnId: prepared.turnId,
                updatedAt: yield* nowIso,
                ...(prepared.displayModel ? { model: prepared.displayModel } : {}),
              };
              yield* settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                completedStopReason: completedStopReasonFromPromptResponse(result),
                promptEpoch: prepared.promptEpoch,
              });
              ctx.interruptedTurnIds.delete(prepared.turnId);
              yield* Ref.set(promptSettled, true);

              return {
                threadId: input.threadId,
                turnId: prepared.turnId,
                resumeCursor: ctx.session.resumeCursor,
              };
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (yield* Ref.get(promptSettled)) {
                return;
              }

              if (yield* Ref.get(promptRpcSucceeded)) {
                const promptResult = yield* Ref.get(promptResultRef);

                if (promptResult === undefined) {
                  return;
                }

                yield* withThreadLock(
                  input.threadId,
                  Effect.gen(function* () {
                    const ctx = yield* requireSession(input.threadId);

                    if (ctx.acpSessionId !== prepared.acpSessionId) {
                      yield* settlePromptInFlight(
                        input.threadId,
                        prepared.turnId,
                        prepared.acpSessionId,
                        {
                          errorMessage: "Grok session changed before the turn completed.",
                          settleAllPrompts: true,
                          promptEpoch: prepared.promptEpoch,
                        },
                      );

                      return;
                    }

                    if (ctx.interruptedTurnIds.has(prepared.turnId)) {
                      return;
                    }

                    if (
                      ctx.promptsInFlight <= 0 ||
                      ctx.activeTurnId !== prepared.turnId ||
                      ctx.session.activeTurnId !== prepared.turnId
                    ) {
                      return;
                    }

                    appendPromptResultToTurn(
                      ctx,
                      prepared.turnId,
                      prepared.promptParts,
                      promptResult,
                    );
                    yield* settlePromptInFlight(
                      input.threadId,
                      prepared.turnId,
                      prepared.acpSessionId,
                      {
                        completedStopReason: completedStopReasonFromPromptResponse(promptResult),
                        promptEpoch: prepared.promptEpoch,
                      },
                    );
                  }),
                );

                return;
              }

              const errorMessage = yield* Ref.get(promptFailureMessageRef);
              yield* withThreadLock(
                input.threadId,
                settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                  errorMessage: errorMessage ?? "Grok prompt request failed.",
                  promptEpoch: prepared.promptEpoch,
                }),
              );
            }).pipe(Effect.catch(() => Effect.void)),
          ),
        );
      });

    const interruptTurn: GrokAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const observed = yield* Effect.sync(() => {
          const ctx = sessions.get(threadId);

          if (!ctx || ctx.stopped) {
            return {
              _tag: "Proceed" as const,
              acpSessionId: undefined,
              interruptedTurnId: turnId,
            };
          }

          const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;

          if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
            return { _tag: "Ignore" as const };
          }

          const interruptedTurnId = turnId ?? activeTurnId;

          if (interruptedTurnId !== undefined) {
            ctx.interruptedTurnIds.add(interruptedTurnId);
          }

          return {
            _tag: "Proceed" as const,
            acpSessionId: ctx.acpSessionId,
            interruptedTurnId,
          };
        });

        if (Predicate.isTagged(observed, "Ignore")) {
          return;
        }

        yield* withThreadLock(
          threadId,
          Effect.gen(function* () {
            const ctx = yield* requireSession(threadId);

            if (observed.acpSessionId !== undefined && ctx.acpSessionId !== observed.acpSessionId) {
              return;
            }

            const activeTurnId = ctx.activeTurnId ?? ctx.session.activeTurnId;

            if (turnId !== undefined && activeTurnId !== undefined && activeTurnId !== turnId) {
              return;
            }

            if (
              observed.interruptedTurnId !== undefined &&
              activeTurnId !== undefined &&
              activeTurnId !== observed.interruptedTurnId
            ) {
              return;
            }

            const interruptedTurnId =
              observed.interruptedTurnId ?? turnId ?? activeTurnId ?? ctx.session.activeTurnId;

            yield* settlePendingApprovalsAsCancelled(ctx.pendingApprovals);
            yield* settlePendingUserInputsAsCancelled(ctx.pendingUserInputs);
            yield* Effect.ignore(
              ctx.acp.cancel.pipe(
                Effect.mapError((error) =>
                  mapAcpToAdapterError(PROVIDER, threadId, "session/cancel", error),
                ),
              ),
            );

            if (interruptedTurnId) {
              ctx.interruptedTurnIds.add(interruptedTurnId);
              yield* settlePromptInFlight(threadId, interruptedTurnId, ctx.acpSessionId, {
                completedStopReason: "cancelled",
                settleAllPrompts: true,
              });
            } else if (
              ctx.promptsInFlight > 0 ||
              ctx.session.status === "running" ||
              ctx.session.status === "connecting"
            ) {
              const updatedAt = yield* nowIso;
              ctx.promptsInFlight = 0;
              ctx.activeTurnId = undefined;
              const { activeTurnId: _activeTurnId, ...readySession } = ctx.session;
              ctx.session = {
                ...readySession,
                status: "ready",
                updatedAt,
              };
            }
          }),
        );
      });

    const respondToRequest: GrokAdapterShape["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);

        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }

        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: GrokAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingUserInputs.get(requestId);

        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "_x.ai/ask_user_question",
            detail: `Unknown pending user-input request: ${requestId}`,
          });
        }

        yield* Deferred.succeed(pending.resolution, UserInputResolution.answered({ answers }));
      });

    const readThread: GrokAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);

        return { threadId, turns: ctx.turns };
      });

    const rollbackThread: GrokAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* requireSession(threadId);

        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "rollbackThread",
            issue: "numTurns must be an integer >= 1.",
          });
        }

        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "thread/rollback",
          detail: "Grok ACP sessions do not support provider-side rollback yet.",
        });
      });

    const stopSession: GrokAdapterShape["stopSession"] = (threadId) =>
      withThreadLock(
        threadId,
        Effect.gen(function* () {
          const ctx = yield* requireSession(threadId);
          yield* stopSessionInternal(ctx);
        }),
      );

    const listSessions: GrokAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session })));

    const hasSession: GrokAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => {
        const c = sessions.get(threadId);

        return c !== undefined && !c.stopped;
      });

    const stopAll: GrokAdapterShape["stopAll"] = () =>
      Effect.forEach(Array.from(sessions.values()), stopSessionInternal, { discard: true });

    yield* Effect.addFinalizer(() =>
      Effect.ignore(stopAll()).pipe(
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
        Effect.tap(() => managedNativeEventLogger?.close() ?? Effect.void),
      ),
    );

    const streamEvents = Stream.fromPubSub(runtimeEventPubSub);

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      stopAll,
      streamEvents,
    } satisfies GrokAdapterShape;
  });
}

export {
  selectGrokPermissionOptionId,
  grokPromptSettlementBelongsToContext,
  grokTurnCompletionForPromptEpoch,
} from "./grok/GrokProtocol.ts";

export { type GrokTurnTerminal } from "./grok/GrokAdapterState.ts";
