import * as Predicate from "effect/Predicate";
import {
  type EventId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as FileSystem from "effect/FileSystem";
import * as Ref from "effect/Ref";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveAttachmentPath } from "../../../attachmentStore.ts";
import { type ServerConfig } from "../../../config.ts";
import {
  ProviderAdapterRequestError,
  type ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import { mapAcpToAdapterError } from "../../acp/AcpAdapterSupport.ts";
import { applyGrokAcpModelSelection, resolveGrokAcpBaseModelId } from "../../acp/GrokAcpSupport.ts";
import { type GrokAdapterShape } from "../../Services/GrokAdapter.ts";
import { PROVIDER, type GrokSessionContext } from "./GrokAdapterState.ts";
import {
  appendPromptResultToTurn,
  completedStopReasonFromPromptResponse,
  settlePendingApprovalsAsCancelled,
  settlePendingUserInputsAsCancelled,
} from "./GrokProtocol.ts";
import type { createGrokTurnLifecycle } from "./GrokTurnLifecycle.ts";

/**
 * Sends a Grok turn. A send while a prompt is in flight steers the active
 * turn; every path settles its prompt slot exactly once, including on
 * interruption and failure.
 */
export function createGrokSendTurn(deps: {
  readonly boundInstanceId: ProviderInstanceId;
  readonly serverConfig: ServerConfig["Service"];
  readonly fileSystem: FileSystem.FileSystem;
  readonly sessions: Map<ThreadId, GrokSessionContext>;
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly requireSession: (
    threadId: ThreadId,
  ) => Effect.Effect<GrokSessionContext, ProviderAdapterSessionNotFoundError>;
  readonly settlePromptInFlight: ReturnType<typeof createGrokTurnLifecycle>["settlePromptInFlight"];
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly nowIso: Effect.Effect<string, never, never>;
}) {
  const {
    boundInstanceId,
    serverConfig,
    fileSystem,
    sessions,
    withThreadLock,
    requireSession,
    settlePromptInFlight,
    randomUUIDv4,
    offerRuntimeEvent,
    makeEventStamp,
    nowIso,
  } = deps;

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
            Effect.all([Ref.set(promptRpcSucceeded, true), Ref.set(promptResultRef, promptResult)]),
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
              yield* settlePromptInFlight(input.threadId, prepared.turnId, prepared.acpSessionId, {
                errorMessage: "Grok session changed before the turn completed.",
                settleAllPrompts: true,
                promptEpoch: prepared.promptEpoch,
              });
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

  return sendTurn;
}
