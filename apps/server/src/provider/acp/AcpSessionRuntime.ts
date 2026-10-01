import * as Context from "effect/Context";
import * as Match from "effect/Match";
import * as Data from "effect/Data";
import * as Predicate from "effect/Predicate";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpClient from "effect-acp/client";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";
import { resolveSpawnCommand } from "@akeru/shared/shell";
import {
  collectSessionConfigOptionValues,
  extractModelConfigId,
  findSessionConfigOption,
  parseSessionModeState,
} from "./AcpSessionModel.ts";
import { sessionUpdateIsReplay, waitForSessionLoadReplayIdle } from "./AcpSessionReplay.ts";
import { type SessionLoadGate, type AcpSessionModeState } from "./AcpRuntimeTypes.ts";

import {
  type AcpToolCallTrackedState,
  type AcpAssistantSegmentState,
  handleSessionUpdate,
  closeActiveAssistantSegment,
} from "./AcpSessionUpdates.ts";
import {
  formatConfigOptionValue,
  sessionConfigOptionsFromSetup,
  configOptionCurrentValueMatches,
} from "./AcpSessionConfiguration.ts";
import { type AcpSessionRuntimeEvent } from "./AcpSessionEventTypes.ts";

import {
  type AcpSessionRuntimeShape,
  type AcpSessionRuntimeOptions,
  type AcpSessionRequestLogEvent,
  type AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntimeService.ts";

const defaultSessionLoadTimeout = Duration.seconds(90);

const defaultSessionLoadReplayIdleGap = Duration.seconds(2);

export type {
  AcpSpawnInput,
  AcpSessionRuntimeOptions,
  AcpSessionRequestLogEvent,
  AcpSessionRuntimeStartResult,
} from "./AcpSessionRuntimeService.ts";

export class AcpSessionRuntime extends Context.Service<AcpSessionRuntime, AcpSessionRuntimeShape>()(
  "akeru-bot/provider/acp/AcpSessionRuntime",
) {}

interface AcpStartedState extends AcpSessionRuntimeStartResult {}

type AcpStartState =
  | { readonly _tag: "NotStarted" }
  | {
      readonly _tag: "Starting";
      readonly deferred: Deferred.Deferred<AcpSessionRuntimeStartResult, EffectAcpErrors.AcpError>;
    }
  | { readonly _tag: "Started"; readonly result: AcpStartedState };

export const make = (
  options: AcpSessionRuntimeOptions,
): Effect.Effect<
  AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeScope = yield* Scope.Scope;
    const eventQueue = yield* Queue.unbounded<AcpSessionRuntimeEvent>();
    const modeStateRef = yield* Ref.make<AcpSessionModeState | undefined>(undefined);
    const toolCallsRef = yield* Ref.make(new Map<string, AcpToolCallTrackedState>());

    const assistantItemRuntimeId = yield* crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new EffectAcpErrors.AcpTransportError({
            detail: "Failed to generate an ACP assistant item runtime identifier.",
            cause,
          }),
      ),
    );

    const assistantSegmentRef = yield* Ref.make<AcpAssistantSegmentState>({ nextSegmentIndex: 0 });
    const configOptionsRef = yield* Ref.make(sessionConfigOptionsFromSetup(undefined));
    const startStateRef = yield* Ref.make<AcpStartState>(startStates.NotStarted());
    const promptSerializationSemaphore = yield* Semaphore.make(1);

    const activePromptFiberRef = yield* Ref.make<
      Option.Option<Fiber.Fiber<EffectAcpSchema.PromptResponse, EffectAcpErrors.AcpError>>
    >(Option.none());

    const sessionLoadGateRef = yield* Ref.make<Option.Option<SessionLoadGate>>(Option.none());

    const logRequest = (event: AcpSessionRequestLogEvent) =>
      options.requestLogger ? options.requestLogger(event) : Effect.void;

    const runLoggedRequest = <A, Payload>(
      method: string,
      payload: Payload,
      effect: Effect.Effect<A, EffectAcpErrors.AcpError>,
    ): Effect.Effect<A, EffectAcpErrors.AcpError> =>
      logRequest({ method, payload, status: "started" }).pipe(
        Effect.flatMap(() =>
          effect.pipe(
            Effect.tap((result) =>
              logRequest({
                method,
                payload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method,
                payload,
                status: "failed",
                cause,
              }),
            ),
          ),
        ),
      );

    const spawnCommand = yield* resolveSpawnCommand(
      options.spawn.command,
      options.spawn.args,
      options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {},
    );

    const child = yield* spawner
      .spawn(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          ...(options.spawn.cwd ? { cwd: options.spawn.cwd } : {}),
          ...(options.spawn.env ? { env: options.spawn.env, extendEnv: true } : {}),
          shell: spawnCommand.shell,
        }),
      )
      .pipe(
        Effect.provideService(Scope.Scope, runtimeScope),
        Effect.mapError(
          (cause) =>
            new EffectAcpErrors.AcpSpawnError({
              command: options.spawn.command,
              cause,
            }),
        ),
      );

    const acpContext = yield* Layer.build(
      EffectAcpClient.layerChildProcess(child, {
        ...(options.protocolLogging?.logIncoming !== undefined
          ? { logIncoming: options.protocolLogging.logIncoming }
          : {}),
        ...(options.protocolLogging?.logOutgoing !== undefined
          ? { logOutgoing: options.protocolLogging.logOutgoing }
          : {}),
        ...(options.protocolLogging?.logger ? { logger: options.protocolLogging.logger } : {}),
      }),
    ).pipe(Effect.provideService(Scope.Scope, runtimeScope));

    const acp = yield* Effect.service(EffectAcpClient.AcpClient).pipe(Effect.provide(acpContext));

    yield* acp.handleSessionUpdate((notification) =>
      Effect.gen(function* () {
        const gate = yield* Ref.get(sessionLoadGateRef);

        if (Option.isSome(gate) && gate.value.active) {
          const lastActivityAtMillis = yield* Clock.currentTimeMillis;
          yield* Ref.set(
            sessionLoadGateRef,
            Option.some({
              ...gate.value,
              lastActivityAtMillis,
            }),
          );

          return;
        }

        if (sessionUpdateIsReplay(notification)) {
          return;
        }

        const startState = yield* Ref.get(startStateRef);

        // One runtime projects one root ACP session. Child-session updates need
        // explicit lineage routing and must never be flattened into this stream.
        if (
          !Predicate.isTagged(startState, "Started") ||
          notification.sessionId !== startState.result.sessionId
        ) {
          return;
        }

        yield* handleSessionUpdate({
          queue: eventQueue,
          modeStateRef,
          toolCallsRef,
          assistantSegmentRef,
          assistantItemRuntimeId,
          params: notification,
        });
      }),
    );

    const initializeClientCapabilities = {
      fs: {
        readTextFile: false,
        writeTextFile: false,
        ...options.clientCapabilities?.fs,
      },
      terminal: options.clientCapabilities?.terminal ?? false,
      ...(options.clientCapabilities?.auth ? { auth: options.clientCapabilities.auth } : {}),
      ...(options.clientCapabilities?.elicitation
        ? { elicitation: options.clientCapabilities.elicitation }
        : {}),
      ...(options.clientCapabilities?._meta ? { _meta: options.clientCapabilities._meta } : {}),
    } satisfies NonNullable<EffectAcpSchema.InitializeRequest["clientCapabilities"]>;

    const getStartedState = Effect.gen(function* () {
      const state = yield* Ref.get(startStateRef);

      if (Predicate.isTagged(state, "Started")) {
        return state.result;
      }

      return yield* new EffectAcpErrors.AcpTransportError({
        detail: "ACP session runtime has not been started",
        cause: "ACP session runtime has not been started",
      });
    });

    const validateConfigOptionValue = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<void, EffectAcpErrors.AcpError> =>
      Effect.gen(function* () {
        const configOption = findSessionConfigOption(yield* Ref.get(configOptionsRef), configId);

        if (!configOption) {
          return;
        }

        if (configOption.type === "boolean") {
          if (Predicate.isBoolean(value)) {
            return;
          }

          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected boolean`,
            data: {
              configId: configOption.id,
              expectedType: "boolean",
              receivedValue: value,
            },
          });
        }

        if (!Predicate.isString(value)) {
          return yield* new EffectAcpErrors.AcpRequestError({
            code: -32602,
            errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected string`,
            data: {
              configId: configOption.id,
              expectedType: "string",
              receivedValue: value,
            },
          });
        }

        const allowedValues = collectSessionConfigOptionValues(configOption);

        if (allowedValues.includes(value)) {
          return;
        }

        return yield* new EffectAcpErrors.AcpRequestError({
          code: -32602,
          errorMessage: `Invalid value ${formatConfigOptionValue(value)} for session config option "${configOption.id}": expected one of ${allowedValues.join(", ")}`,
          data: {
            configId: configOption.id,
            allowedValues,
            receivedValue: value,
          },
        });
      });

    const updateConfigOptions = (
      response:
        | EffectAcpSchema.SetSessionConfigOptionResponse
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse,
    ): Effect.Effect<void> => Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(response));

    const updateCurrentModeId = (modeId: string): Effect.Effect<void> =>
      Ref.update(modeStateRef, (current) =>
        current ? { ...current, currentModeId: modeId } : current,
      );

    const setConfigOption = (
      configId: string,
      value: string | boolean,
    ): Effect.Effect<EffectAcpSchema.SetSessionConfigOptionResponse, EffectAcpErrors.AcpError> =>
      validateConfigOptionValue(configId, value).pipe(
        Effect.flatMap(() => getStartedState),
        Effect.flatMap((started) =>
          Ref.get(configOptionsRef).pipe(
            Effect.flatMap((configOptions) => {
              const existing = findSessionConfigOption(configOptions, configId);

              if (existing && configOptionCurrentValueMatches(existing, value)) {
                return Effect.succeed({
                  configOptions,
                } satisfies EffectAcpSchema.SetSessionConfigOptionResponse);
              }

              const requestPayload = Predicate.isBoolean(value)
                ? ({
                    sessionId: started.sessionId,
                    configId,
                    type: "boolean",
                    value,
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest)
                : ({
                    sessionId: started.sessionId,
                    configId,
                    value: String(value),
                  } satisfies EffectAcpSchema.SetSessionConfigOptionRequest);

              return runLoggedRequest(
                "session/set_config_option",
                requestPayload,
                acp.agent.setSessionConfigOption(requestPayload),
              ).pipe(Effect.tap((response) => updateConfigOptions(response)));
            }),
          ),
        ),
      );

    const initializePayload = {
      protocolVersion: 1,
      clientCapabilities: initializeClientCapabilities,
      clientInfo: options.clientInfo,
    } satisfies EffectAcpSchema.InitializeRequest;

    const sendInitialize = runLoggedRequest(
      "initialize",
      initializePayload,
      acp.agent.initialize(initializePayload),
    );

    const startOnce = Effect.gen(function* () {
      const initializeResult = yield* sendInitialize;

      const authenticatePayload = {
        methodId: options.authMethodId,
      } satisfies EffectAcpSchema.AuthenticateRequest;

      yield* runLoggedRequest(
        "authenticate",
        authenticatePayload,
        acp.agent.authenticate(authenticatePayload),
      );

      let sessionId: string;

      let sessionSetupResult:
        | EffectAcpSchema.LoadSessionResponse
        | EffectAcpSchema.NewSessionResponse
        | EffectAcpSchema.ResumeSessionResponse;

      if (options.resumeSessionId) {
        const loadPayload = {
          sessionId: options.resumeSessionId,
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
        } satisfies EffectAcpSchema.LoadSessionRequest;

        const sessionLoadTimeout = Duration.fromInputUnsafe(
          options.sessionLoadTimeout ?? defaultSessionLoadTimeout,
        );

        const sessionLoadReplayIdleGap = Duration.fromInputUnsafe(
          options.sessionLoadReplayIdleGap ?? defaultSessionLoadReplayIdleGap,
        );

        yield* Ref.set(
          sessionLoadGateRef,
          Option.some({
            active: true,
            lastActivityAtMillis: undefined,
            idleGap: sessionLoadReplayIdleGap,
            initializeResult,
          }),
        );

        sessionId = options.resumeSessionId;
        sessionSetupResult = yield* Effect.gen(function* () {
          yield* logRequest({
            method: "session/load",
            payload: loadPayload,
            status: "started",
          });

          const idleFiber = yield* waitForSessionLoadReplayIdle({
            gateRef: sessionLoadGateRef,
          }).pipe(Effect.forkIn(runtimeScope));

          const loaded = yield* Effect.raceFirst(
            acp.agent.loadSession(loadPayload),
            Fiber.join(idleFiber),
          ).pipe(
            Effect.ensuring(Fiber.interrupt(idleFiber).pipe(Effect.ignore)),
            Effect.timeoutOption(sessionLoadTimeout),
            Effect.flatMap((result) =>
              Option.match(result, {
                onNone: () =>
                  Effect.fail(
                    new EffectAcpErrors.AcpTransportError({
                      operation: "call-rpc",
                      method: "session/load",
                      detail: "session/load timed out waiting for RPC response or replay idle gap",
                      cause: undefined,
                    }),
                  ),
                onSome: Effect.succeed,
              }),
            ),
            Effect.tap((result) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "succeeded",
                result,
              }),
            ),
            Effect.onError((cause) =>
              logRequest({
                method: "session/load",
                payload: loadPayload,
                status: "failed",
                cause,
              }),
            ),
          );

          return loaded;
        }).pipe(Effect.ensuring(Ref.set(sessionLoadGateRef, Option.none())));
      } else {
        const createPayload = {
          cwd: options.cwd,
          mcpServers: options.mcpServers ?? [],
        } satisfies EffectAcpSchema.NewSessionRequest;

        const created = yield* runLoggedRequest(
          "session/new",
          createPayload,
          acp.agent.createSession(createPayload),
        );

        sessionId = created.sessionId;
        sessionSetupResult = created;
      }

      yield* Ref.set(modeStateRef, parseSessionModeState(sessionSetupResult));
      yield* Ref.set(configOptionsRef, sessionConfigOptionsFromSetup(sessionSetupResult));

      const nextState = {
        sessionId,
        initializeResult,
        sessionSetupResult,
        modelConfigId: extractModelConfigId(sessionSetupResult),
      } satisfies AcpStartedState;

      return nextState;
    });

    const start = Effect.gen(function* () {
      const deferred = yield* Deferred.make<
        AcpSessionRuntimeStartResult,
        EffectAcpErrors.AcpError
      >();

      const effect = yield* Ref.modify(startStateRef, (state) => {
        return Match.value(state).pipe(
          Match.tags({
            Started: (state) => [Effect.succeed(state.result), state] as const,
            Starting: (state) => [Deferred.await(state.deferred), state] as const,
            NotStarted: () =>
              [
                startOnce.pipe(
                  Effect.tap((result) =>
                    Ref.set(startStateRef, startStates.Started({ result })).pipe(
                      Effect.andThen(Deferred.succeed(deferred, result)),
                    ),
                  ),
                  Effect.onError((cause) =>
                    Deferred.failCause(deferred, cause).pipe(
                      Effect.andThen(Ref.set(startStateRef, startStates.NotStarted())),
                    ),
                  ),
                ),
                startStates.Starting({ deferred }) satisfies AcpStartState,
              ] as const,
          }),
          Match.exhaustive,
        );
      });

      return yield* effect;
    });

    return {
      handleRequestPermission: acp.handleRequestPermission,
      handleElicitation: acp.handleElicitation,
      handleReadTextFile: acp.handleReadTextFile,
      handleWriteTextFile: acp.handleWriteTextFile,
      handleCreateTerminal: acp.handleCreateTerminal,
      handleTerminalOutput: acp.handleTerminalOutput,
      handleTerminalWaitForExit: acp.handleTerminalWaitForExit,
      handleTerminalKill: acp.handleTerminalKill,
      handleTerminalRelease: acp.handleTerminalRelease,
      handleSessionUpdate: acp.handleSessionUpdate,
      handleElicitationComplete: acp.handleElicitationComplete,
      handleUnknownExtRequest: acp.handleUnknownExtRequest,
      handleUnknownExtNotification: acp.handleUnknownExtNotification,
      handleExtRequest: acp.handleExtRequest,
      handleExtNotification: acp.handleExtNotification,
      initialize: () => sendInitialize,
      start: () => start,
      getEvents: () => Stream.fromQueue(eventQueue),
      drainEvents: Effect.gen(function* () {
        const acknowledge = yield* Deferred.make<void>();
        yield* Queue.offer(eventQueue, sessionEvents.EventStreamBarrier({ acknowledge }));
        yield* Deferred.await(acknowledge);
      }),
      getModeState: Ref.get(modeStateRef),
      getConfigOptions: Ref.get(configOptionsRef),
      prompt: (payload, promptOptions?) =>
        promptSerializationSemaphore.withPermit(
          Effect.gen(function* () {
            const started = yield* getStartedState;
            yield* closeActiveAssistantSegment({
              queue: eventQueue,
              assistantSegmentRef,
            });

            const requestPayload = {
              sessionId: started.sessionId,
              ...payload,
            } satisfies EffectAcpSchema.PromptRequest;

            const cancelledResponse = {
              stopReason: "cancelled",
            } satisfies EffectAcpSchema.PromptResponse;

            const promptRpcFiber = yield* runLoggedRequest(
              "session/prompt",
              requestPayload,
              acp.agent.prompt(requestPayload),
            ).pipe(Effect.forkIn(runtimeScope));

            yield* Ref.set(activePromptFiberRef, Option.some(promptRpcFiber));

            if (promptOptions?.dispatched) {
              yield* Deferred.succeed(promptOptions.dispatched, undefined);
            }

            return yield* Fiber.join(promptRpcFiber).pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.succeed(cancelledResponse)
                  : Effect.failCause(cause),
              ),
              Effect.ensuring(
                Effect.gen(function* () {
                  yield* Fiber.interrupt(promptRpcFiber).pipe(Effect.ignore);
                  yield* Ref.set(activePromptFiberRef, Option.none());
                }),
              ),
              Effect.tap(() =>
                closeActiveAssistantSegment({
                  queue: eventQueue,
                  assistantSegmentRef,
                }),
              ),
            );
          }),
        ),
      cancel: getStartedState.pipe(
        Effect.flatMap((started) =>
          Effect.gen(function* () {
            const activePromptFiber = yield* Ref.get(activePromptFiberRef);

            if (Option.isSome(activePromptFiber)) {
              yield* Fiber.interrupt(activePromptFiber.value).pipe(Effect.ignore);
            }

            // Await the notification write so a replacement session/prompt
            // cannot race ahead of session/cancel on the wire.
            yield* acp.agent.cancel({ sessionId: started.sessionId }).pipe(Effect.ignore);
          }),
        ),
      ),
      setMode: (modeId) =>
        Ref.get(modeStateRef).pipe(
          Effect.flatMap((modeState) => {
            if (modeState?.currentModeId === modeId) {
              return Effect.succeed({} satisfies EffectAcpSchema.SetSessionModeResponse);
            }

            return setConfigOption("mode", modeId).pipe(
              Effect.tap(() => updateCurrentModeId(modeId)),
              Effect.as({} satisfies EffectAcpSchema.SetSessionModeResponse),
            );
          }),
        ),
      setConfigOption,
      setModel: (model) =>
        getStartedState.pipe(
          Effect.flatMap((started) => setConfigOption(started.modelConfigId ?? "model", model)),
          Effect.asVoid,
        ),
      setSessionModel: (modelId) =>
        getStartedState.pipe(
          Effect.flatMap((started) => {
            const requestPayload = {
              sessionId: started.sessionId,
              modelId,
            } satisfies EffectAcpSchema.SetSessionModelRequest;

            return runLoggedRequest(
              "session/set_model",
              requestPayload,
              acp.agent.setSessionModel(requestPayload),
            );
          }),
        ),
      request: (method, payload) =>
        runLoggedRequest(method, payload, acp.raw.request(method, payload)),
      notify: acp.raw.notify,
    } satisfies AcpSessionRuntime["Service"];
  });

export const layer = (
  options: AcpSessionRuntimeOptions,
): Layer.Layer<
  AcpSessionRuntime,
  EffectAcpErrors.AcpError,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> => Layer.effect(AcpSessionRuntime, make(options));

export {
  type AcpSessionEventStreamBarrier,
  type AcpSessionRuntimeEvent,
} from "./AcpSessionEventTypes.ts";

const startStates = Data.taggedEnum<AcpStartState>();

const sessionEvents = Data.taggedEnum<AcpSessionRuntimeEvent>();
