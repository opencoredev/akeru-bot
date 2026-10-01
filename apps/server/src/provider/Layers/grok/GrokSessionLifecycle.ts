import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import type * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type { ProviderDriverKind } from "@akeru/contracts";
import type { AcpSessionRuntimeOptions } from "../../acp/AcpSessionRuntime.ts";
// @effect-diagnostics globalDate:off globalConsole:off globalRandom:off nodeBuiltinImport:off globalTimers:off globalFetch:off
import {
  ApprovalRequestId,
  type GrokSettings,
  EventId,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ProviderInstanceId,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Crypto from "effect/Crypto";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as EffectAcpErrors from "effect-acp/errors";

import { ServerConfig } from "../../../config.ts";
import { subscriptionRuntimeEnvironment } from "../../../subscription-auth/runtime.ts";
import * as McpProviderSession from "../../../mcp/McpProviderSession.ts";
import { toAcpMcpServers } from "../../McpServerConfig.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterValidationError,
} from "../../Errors.ts";
import { mapAcpToAdapterError } from "../../acp/AcpAdapterSupport.ts";
import {
  acpAssistantItemEvent,
  acpContentDeltaEvent,
  acpRequestOpenedEvent,
  acpRequestResolvedEvent,
  acpToolCallEvent,
} from "../../acp/AcpCoreRuntimeEvents.ts";
import { parsePermissionRequest } from "../../acp/AcpRuntimeModel.ts";

import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- Provider composition root creates the configured, scoped ACP subprocess runtime.
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "../../acp/GrokAcpSupport.ts";
import {
  extractXAiAskUserQuestions,
  xAiAskUserQuestionCancelledResponse,
  xAiAskUserQuestionResponse,
  XAiAskUserQuestionRequest,
} from "../../acp/XAiAcpExtension.ts";
import { type GrokAdapterShape } from "../../Services/GrokAdapter.ts";
import { type EventNdjsonLogger } from "../logging/EventLogTypes.ts";
import {
  PROVIDER,
  GROK_RESUME_VERSION,
  type PendingApproval,
  type PendingUserInputResolution,
  type PendingUserInput,
  type GrokSessionContext,
} from "./GrokAdapterState.ts";
import {
  encodeJsonStringForDiagnostics,
  resolveNotificationTurnId,
  resolveSessionCallbackTurnId,
  parseGrokResume,
  selectGrokPermissionOptionId,
  selectAutoApprovedPermissionOption,
} from "./GrokProtocol.ts";

export function createGrokSessionLifecycle(deps: {
  readonly nativeEventLogger: EventNdjsonLogger | undefined;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly withThreadLock: <A, E, R>(
    threadId: string,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  readonly path: Path.Path;
  readonly boundInstanceId: ProviderInstanceId;
  readonly sessions: Map<ThreadId, GrokSessionContext>;
  readonly stopSessionInternal: (
    ctx: GrokSessionContext,
  ) => Effect.Effect<void, ProviderAdapterRequestError, never>;
  readonly makeAcpNativeLoggers: (input: {
    readonly nativeEventLogger: EventNdjsonLogger | undefined;
    readonly provider: ProviderDriverKind;
    readonly threadId: ThreadId;
    readonly verboseProtocolLogging?: boolean;
  }) => Pick<AcpSessionRuntimeOptions, "requestLogger" | "protocolLogging">;
  readonly grokSettings: GrokSettings;
  readonly serverConfig: ServerConfig["Service"];
  readonly options: { readonly environment?: NodeJS.ProcessEnv } | undefined;
  readonly fileSystem: FileSystem.FileSystem;
  readonly crypto: Crypto.Crypto;
  readonly mapAcpCallbackFailure: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, EffectAcpErrors.AcpTransportError, R>;
  readonly logNative: (
    threadId: ThreadId,
    method: string,
    payload: NonNullable<ProviderRuntimeEvent["raw"]>["payload"],
  ) => Effect.Effect<void, never, never>;
  readonly randomUUIDv4: Effect.Effect<string, ProviderAdapterRequestError, never>;
  readonly offerRuntimeEvent: (event: ProviderRuntimeEvent) => Effect.Effect<void, never, never>;
  readonly makeEventStamp: () => Effect.Effect<
    { eventId: EventId; createdAt: string },
    ProviderAdapterRequestError,
    never
  >;
  readonly nowIso: Effect.Effect<string, never, never>;
  readonly emitPlanUpdate: (
    ctx: GrokSessionContext,
    turnId: TurnId | undefined,
    stamp: { readonly eventId: EventId; readonly createdAt: string },
    payload: {
      readonly explanation?: string | null;
      readonly plan: ReadonlyArray<{
        readonly step: string;
        readonly status: "pending" | "inProgress" | "completed";
      }>;
    },
    rawPayload: NonNullable<ProviderRuntimeEvent["raw"]>["payload"],
    method: string,
  ) => Effect.Effect<void, never, never>;
}) {
  const startSession: GrokAdapterShape["startSession"] = (input) =>
    deps.withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
          });
        }

        if (!input.cwd?.trim()) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required and must be non-empty.",
          });
        }

        const cwd = deps.path.resolve(input.cwd.trim());

        const grokModelSelection =
          input.modelSelection?.instanceId === deps.boundInstanceId
            ? input.modelSelection
            : undefined;

        const existing = deps.sessions.get(input.threadId);

        if (existing && !existing.stopped) {
          yield* deps.stopSessionInternal(existing);
        }

        const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
        const pendingUserInputs = new Map<ApprovalRequestId, PendingUserInput>();
        const sessionScope = yield* Scope.make("sequential");
        let sessionScopeTransferred = false;
        yield* Effect.addFinalizer(() =>
          sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
        );

        const resumeSessionId = parseGrokResume(input.resumeCursor)?.sessionId;

        const acpNativeLoggers = deps.makeAcpNativeLoggers({
          nativeEventLogger: deps.nativeEventLogger,
          provider: PROVIDER,
          threadId: input.threadId,
          verboseProtocolLogging: deps.grokSettings.verboseProtocolLogging,
        });

        const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);

        const mcpServers = [
          ...toAcpMcpServers(input.mcpServers ?? []),
          ...(mcpSession
            ? [
                {
                  type: "http" as const,
                  name: "akeru",
                  url: mcpSession.endpoint,
                  headers: [
                    {
                      name: "Authorization",
                      value: mcpSession.authorizationHeader,
                    },
                  ],
                },
              ]
            : []),
        ];

        const acp = yield* makeGrokAcpRuntime({
          grokSettings: deps.grokSettings,
          environment: yield* subscriptionRuntimeEnvironment(
            deps.serverConfig.secretsDir,
            "xai",
            deps.options?.environment,
            deps.boundInstanceId,
          ).pipe(
            Effect.provideService(FileSystem.FileSystem, deps.fileSystem),
            Effect.provideService(Path.Path, deps.path),
          ),
          childProcessSpawner: deps.childProcessSpawner,
          cwd,
          ...(resumeSessionId ? { resumeSessionId } : {}),
          clientInfo: { name: "akeru-bot", version: "0.0.0" },
          ...(mcpServers.length > 0 ? { mcpServers } : {}),
          ...acpNativeLoggers,
        }).pipe(
          Effect.provideService(Crypto.Crypto, deps.crypto),
          Effect.provideService(Scope.Scope, sessionScope),
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: cause.message,
                cause,
              }),
          ),
        );

        const started = yield* Effect.gen(function* () {
          yield* Effect.forEach(
            ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
            (method) =>
              acp.handleExtRequest(method, XAiAskUserQuestionRequest, (params) =>
                deps.mapAcpCallbackFailure(
                  Effect.gen(function* () {
                    yield* deps.logNative(input.threadId, method, params);
                    const requestId = ApprovalRequestId.make(yield* deps.randomUUIDv4);
                    const runtimeRequestId = RuntimeRequestId.make(requestId);
                    const resolution = yield* Deferred.make<PendingUserInputResolution>();
                    const turnId = resolveSessionCallbackTurnId(deps.sessions, input.threadId);
                    pendingUserInputs.set(requestId, { resolution });
                    yield* deps.offerRuntimeEvent({
                      type: "user-input.requested",
                      ...(yield* deps.makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      payload: { questions: extractXAiAskUserQuestions(params) },
                      raw: {
                        source: "acp.grok.extension",
                        method,
                        payload: params,
                      },
                    });
                    const resolved = yield* Deferred.await(resolution);
                    pendingUserInputs.delete(requestId);

                    const resolvedAnswers = Predicate.isTagged(resolved, "answered")
                      ? resolved.answers
                      : {};

                    yield* deps.offerRuntimeEvent({
                      type: "user-input.resolved",
                      ...(yield* deps.makeEventStamp()),
                      provider: PROVIDER,
                      threadId: input.threadId,
                      turnId,
                      requestId: runtimeRequestId,
                      payload: { answers: resolvedAnswers },
                      raw: {
                        source: "acp.grok.extension",
                        method,
                        payload: params,
                      },
                    });

                    return Match.value(resolved).pipe(
                      Match.tag("answered", ({ answers }) =>
                        xAiAskUserQuestionResponse(params, answers),
                      ),
                      Match.tag("cancelled", () => xAiAskUserQuestionCancelledResponse()),
                      Match.exhaustive,
                    );
                  }),
                ),
              ),
            { discard: true },
          );
          yield* acp.handleRequestPermission((params) =>
            deps.mapAcpCallbackFailure(
              Effect.gen(function* () {
                yield* deps.logNative(input.threadId, "session/request_permission", params);

                if (input.runtimeMode === "full-access") {
                  const autoApprovedOptionId = selectAutoApprovedPermissionOption(params);

                  if (autoApprovedOptionId !== undefined) {
                    return {
                      outcome: {
                        outcome: "selected" as const,
                        optionId: autoApprovedOptionId,
                      },
                    };
                  }
                }

                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(yield* deps.randomUUIDv4);
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                const turnId = resolveSessionCallbackTurnId(deps.sessions, input.threadId);
                pendingApprovals.set(requestId, { decision });
                yield* deps.offerRuntimeEvent(
                  acpRequestOpenedEvent({
                    stamp: yield* deps.makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* deps.offerRuntimeEvent(
                  acpRequestResolvedEvent({
                    stamp: yield* deps.makeEventStamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );

                const selectedOptionId =
                  resolved === "cancel"
                    ? undefined
                    : selectGrokPermissionOptionId(params, resolved);

                return {
                  outcome: selectedOptionId
                    ? {
                        outcome: "selected" as const,
                        optionId: selectedOptionId,
                      }
                    : ({ outcome: "cancelled" } as const),
                };
              }),
            ),
          );

          return yield* acp.start();
        }).pipe(
          Effect.mapError((error) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
          ),
        );

        const requestedStartModelId = grokModelSelection?.model
          ? resolveGrokAcpBaseModelId(grokModelSelection.model)
          : undefined;

        const boundModelId = yield* applyGrokAcpModelSelection({
          runtime: acp,
          currentModelId: currentGrokModelIdFromSessionSetup(started.sessionSetupResult),
          requestedModelId: requestedStartModelId,
          mapError: (cause) =>
            mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_model", cause),
        });

        const now = yield* deps.nowIso;

        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: deps.boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd,
          ...(boundModelId ? { model: resolveGrokAcpBaseModelId(boundModelId) } : {}),
          threadId: input.threadId,
          resumeCursor: {
            schemaVersion: GROK_RESUME_VERSION,
            sessionId: started.sessionId,
          },
          createdAt: now,
          updatedAt: now,
        };

        const ctx: GrokSessionContext = {
          threadId: input.threadId,
          acpSessionId: started.sessionId,
          session,
          scope: sessionScope,
          acp,
          notificationFiber: undefined,
          pendingApprovals,
          pendingUserInputs,
          turns: [],
          lastPlanFingerprint: undefined,
          activeTurnId: undefined,
          interruptedTurnIds: new Set(),
          promptsInFlight: 0,
          promptEpoch: 0,
          discardBeforeEpoch: 0,
          pendingTurnCompletion: undefined,
          promptLifecycle: yield* Semaphore.make(1),
          currentModelId: boundModelId,
          stopped: false,
        };

        const nf = yield* Stream.runDrain(
          Stream.mapEffect(acp.getEvents(), (event) =>
            Effect.gen(function* () {
              if (Predicate.isTagged(event, "EventStreamBarrier")) {
                yield* Deferred.succeed(event.acknowledge, undefined);

                return;
              }

              if (
                Predicate.isTagged(event, "PlanUpdated") ||
                Predicate.isTagged(event, "ToolCallUpdated") ||
                Predicate.isTagged(event, "ContentDelta")
              ) {
                yield* deps.logNative(ctx.threadId, "session/update", event.rawPayload);
              }

              if (Predicate.isTagged(event, "ModeChanged")) {
                return;
              }

              const notificationTurnId = resolveNotificationTurnId(ctx);

              if (
                notificationTurnId === undefined ||
                ctx.interruptedTurnIds.has(notificationTurnId)
              ) {
                return;
              }

              const stamp = yield* deps.makeEventStamp();

              return yield* Match.value(event).pipe(
                Match.tag("AssistantItemStarted", (event) =>
                  deps.offerRuntimeEvent(
                    acpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.started",
                    }),
                  ),
                ),
                Match.tag("AssistantItemCompleted", (event) =>
                  deps.offerRuntimeEvent(
                    acpAssistantItemEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      itemId: event.itemId,
                      lifecycle: "item.completed",
                    }),
                  ),
                ),
                Match.tag("PlanUpdated", (event) =>
                  deps.emitPlanUpdate(
                    ctx,
                    notificationTurnId,
                    stamp,
                    event.payload,
                    event.rawPayload,
                    "session/update",
                  ),
                ),
                Match.tag("ToolCallUpdated", (event) =>
                  deps.offerRuntimeEvent(
                    acpToolCallEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      toolCall: event.toolCall,
                      rawPayload: event.rawPayload,
                    }),
                  ),
                ),
                Match.tag("ContentDelta", (event) =>
                  deps.offerRuntimeEvent(
                    acpContentDeltaEvent({
                      stamp,
                      provider: PROVIDER,
                      threadId: ctx.threadId,
                      turnId: notificationTurnId,
                      ...(event.itemId ? { itemId: event.itemId } : {}),
                      text: event.text,
                      rawPayload: event.rawPayload,
                    }),
                  ),
                ),
                Match.exhaustive,
              );
            }),
          ),
        ).pipe(
          Effect.catch((cause) =>
            Effect.logError("Failed to process Grok runtime notification.", { cause }),
          ),
          // Fork into the session scope, not the calling fiber. `forkChild`
          // makes this a child of `startSession`, and Effect interrupts a
          // fiber's children when it completes, so the consumer died as soon
          // as `startSession` returned and every later notification was
          // dropped. The scope is created, stored on the context and closed
          // on teardown already; only the fork target was wrong.
          Effect.forkIn(ctx.scope),
        );

        ctx.notificationFiber = nf;
        deps.sessions.set(input.threadId, ctx);
        sessionScopeTransferred = true;

        yield* deps.offerRuntimeEvent({
          type: "session.started",
          ...(yield* deps.makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { resume: started.initializeResult },
        });
        yield* deps.offerRuntimeEvent({
          type: "session.state.changed",
          ...(yield* deps.makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { state: "ready", reason: "Grok ACP session ready" },
        });
        yield* deps.offerRuntimeEvent({
          type: "thread.started",
          ...(yield* deps.makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: { providerThreadId: started.sessionId },
        });

        return session;
      }).pipe(Effect.scoped),
    );

  return { startSession };
}
