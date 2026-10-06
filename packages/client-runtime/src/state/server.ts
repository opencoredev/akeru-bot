import {
  type EnvironmentId,
  type ServerConfig,
  type ServerLifecycleWelcomePayload,
  type ServerLifecycleStreamReadyEvent,
  type ServerSelfUpdateResult,
  WS_METHODS,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createRuntimeCommand,
  scheduleAtomCommandEffect,
} from "./runtime.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { request, runStream, subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import {
  type ServerUpdateStage,
  type ServerUpdateTarget,
  type McpServerAuthenticationTarget,
} from "./serverTypes.ts";
import {
  IDLE_SERVER_UPDATE_STATE,
  EMPTY_SERVER_UPDATE_STATE_ATOM,
  serverUpdateStateAtom,
  ServerUpdateResumeTimeoutError,
  SERVER_UPDATE_RESUME_TIMEOUT,
  matchesServerUpdateReadyEvent,
  validateServerUpdateReadyEvent,
  nudgeReconnectDuringUpdateRestart,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  serverUpdateFailureMessage,
  isLegacyUpdateHandoffLoss,
  resolveServerUpdateProgressResult,
} from "./serverUpdate.ts";
import { McpServerAuthenticationClientError } from "./mcpAuthentication.ts";
import {
  serverConfigStateChanges,
  projectServerWelcome,
  resolveServerConfigValue,
} from "./serverConfig.ts";

export function voiceCallHangupConcurrencyKey(input: {
  readonly environmentId: EnvironmentId;
  readonly input: EnvironmentRpcInput<typeof WS_METHODS.voiceCallHangup>;
}): string {
  return `${input.environmentId}:${input.input.callId}`;
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  // Updates stay serial end-to-end, but only their handoff phase occupies the config lane.
  const updateScheduler = createAtomCommandScheduler();

  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };

  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverConfigStateChanges(environmentId))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );

  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);

  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );

  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }

    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );

      return resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });

  const updateStateValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      serverUpdateStateForServerVersion(
        get(serverUpdateStateAtom(environmentId)),
        get(configValueAtom(environmentId))?.environment.serverVersion ?? null,
      ),
    ).pipe(Atom.withLabel(`environment-data:server:update-state-value:${environmentId}`)),
  );

  const updateStateAtom = (environmentId: EnvironmentId | null) =>
    environmentId === null ? EMPTY_SERVER_UPDATE_STATE_ATOM : updateStateValueAtom(environmentId);

  const updateServer = createRuntimeCommand<
    EnvironmentRegistry | EnvironmentCacheStore | R,
    E,
    ServerUpdateTarget,
    ServerSelfUpdateResult,
    unknown
  >(runtime, {
    label: "environment-data:server:update-server",
    scheduler: updateScheduler,
    concurrency: configConcurrency,
    execute: (target, atomRegistry) => {
      const stateAtom = serverUpdateStateAtom(target.environmentId);
      const targetVersion = target.input.targetVersion;

      let fromVersion =
        atomRegistry.get(configValueAtom(target.environmentId))?.environment.serverVersion ??
        targetVersion;

      let currentStage: ServerUpdateStage = "downloading";
      atomRegistry.set(stateAtom, {
        status: "running",
        stage: currentStage,
        fromVersion,
        targetVersion,
      });

      return Effect.gen(function* () {
        const environmentRegistry = yield* EnvironmentRegistry;

        const result = yield* scheduleAtomCommandEffect(
          atomRegistry,
          configScheduler,
          configConcurrency,
          target,
          Effect.gen(function* () {
            const currentConfig = atomRegistry.get(configValueAtom(target.environmentId));
            fromVersion = currentConfig?.environment.serverVersion ?? targetVersion;
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });

            const supportsProgress =
              currentConfig?.environment.capabilities.serverSelfUpdateProgress === true;

            const updateResult: ServerSelfUpdateResult = supportsProgress
              ? yield* Effect.gen(function* () {
                  const terminal = yield* Ref.make<Option.Option<ServerSelfUpdateResult>>(
                    Option.none(),
                  );

                  const streamExit = yield* environmentRegistry
                    .runStream(
                      target.environmentId,
                      runStream(WS_METHODS.serverUpdateServerWithProgress, target.input),
                    )
                    .pipe(
                      Stream.runForEach((event) =>
                        Effect.sync(() => {
                          currentStage = event.type === "complete" ? "resuming" : event.stage;
                          atomRegistry.set(
                            stateAtom,
                            serverUpdateStateForProgressEvent(fromVersion, targetVersion, event),
                          );
                        }).pipe(
                          Effect.andThen(
                            event.type === "complete"
                              ? Ref.set(terminal, Option.some(event.result))
                              : Effect.void,
                          ),
                        ),
                      ),
                      Effect.exit,
                    );

                  return yield* resolveServerUpdateProgressResult(
                    targetVersion,
                    yield* Ref.get(terminal),
                    streamExit,
                  );
                })
              : yield* Effect.gen(function* () {
                  const selfUpdateMethod = currentConfig?.environment.capabilities.serverSelfUpdate;

                  const exit = yield* environmentRegistry
                    .run(target.environmentId, request(WS_METHODS.serverUpdateServer, target.input))
                    .pipe(Effect.exit);

                  if (Exit.isSuccess(exit)) {
                    return exit.value;
                  }

                  if (
                    (selfUpdateMethod === "boot-service" || selfUpdateMethod === "respawn") &&
                    isLegacyUpdateHandoffLoss(exit.cause)
                  ) {
                    // Older servers can tear down the transport before their
                    // unary acknowledgement arrives. Treat only that transport
                    // loss as a handoff, then prove it by waiting for target ready.
                    return { targetVersion, method: selfUpdateMethod };
                  }

                  return yield* Effect.failCause(exit.cause);
                });

            currentStage = "resuming";
            atomRegistry.set(stateAtom, {
              status: "running",
              stage: currentStage,
              fromVersion,
              targetVersion,
            });

            return updateResult;
          }),
        );

        // The update restart is intentional and the server stays unreachable
        // for the whole restart, so hold the retry cadence flat instead of
        // letting the supervisor climb its backoff ladder.
        yield* nudgeReconnectDuringUpdateRestart({
          stateChanges: environmentRegistry.stateChanges(target.environmentId),
          retryNow: environmentRegistry.retryNow(target.environmentId, { onlyIfDesired: true }),
        }).pipe(Effect.forkChild);

        const resumed = yield* environmentRegistry
          .followStream(target.environmentId, subscribe(WS_METHODS.subscribeServerLifecycle, {}))
          .pipe(
            Stream.filter(
              (event): event is ServerLifecycleStreamReadyEvent =>
                event.type === "ready" && matchesServerUpdateReadyEvent(result, event),
            ),
            Stream.runHead,
            Effect.timeoutOption(SERVER_UPDATE_RESUME_TIMEOUT),
            Effect.map(Option.flatten),
          );

        if (Option.isNone(resumed)) {
          return yield* new ServerUpdateResumeTimeoutError({
            environmentId: target.environmentId,
            targetVersion,
          });
        }

        yield* validateServerUpdateReadyEvent(result, resumed.value);

        atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);

        return result;
      }).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isSuccess(exit)) {
              return;
            }

            if (Cause.hasInterruptsOnly(exit.cause)) {
              atomRegistry.set(stateAtom, IDLE_SERVER_UPDATE_STATE);

              return;
            }

            atomRegistry.set(stateAtom, {
              status: "failed",
              stage: currentStage,
              fromVersion,
              targetVersion,
              message: serverUpdateFailureMessage(Cause.squash(exit.cause)),
            });
          }),
        ),
      );
    },
  });

  const authenticateMcpServer = createRuntimeCommand(runtime, {
    label: "environment-data:server:authenticate-mcp-server",
    concurrency: {
      mode: "singleFlight",
      key: (target: McpServerAuthenticationTarget) =>
        `${target.environmentId}:${target.mcpServerId}`,
    },
    execute: (target: McpServerAuthenticationTarget) =>
      Effect.gen(function* () {
        const environmentRegistry = yield* EnvironmentRegistry;
        let toolCount: number | undefined;
        let recoveryFailures: readonly string[] = [];
        yield* environmentRegistry
          .runStream(
            target.environmentId,
            runStream(WS_METHODS.mcpServerAuthenticate, {
              mcpServerId: target.mcpServerId,
            }),
          )
          .pipe(
            Stream.runForEach((event) =>
              event.type === "authorization-required"
                ? Effect.tryPromise({
                    try: () => Promise.resolve(target.onAuthorizationUrl(event.authorizationUrl)),
                    catch: (cause) =>
                      new McpServerAuthenticationClientError({
                        message:
                          cause instanceof Error
                            ? cause.message
                            : "Could not open the authorization URL.",
                        cause,
                      }),
                  })
                : Effect.sync(() => {
                    toolCount = event.toolCount;
                    recoveryFailures = event.recoveryFailures;
                  }),
            ),
          );

        if (toolCount === undefined) {
          return yield* new McpServerAuthenticationClientError({
            message: "MCP authentication ended before the server connected.",
          });
        }

        return { toolCount, recoveryFailures };
      }),
  });

  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );

  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );

  return {
    configValueAtom,
    updateStateAtom,
    settingsValueAtom,
    providersValueAtom,
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
    }),
    // A cold transcript scan is measured in seconds, so keep the result around
    // long enough that switching windows or re-rendering does not rescan.
    usageSummary: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:usage-summary",
      tag: WS_METHODS.serverGetUsageSummary,
      staleTimeMs: 60_000,
    }),
    subscriptionAuth: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:subscription-auth",
      tag: WS_METHODS.subscriptionAuthList,
      staleTimeMs: 5_000,
    }),
    routineThreadRuns: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:routine-thread-runs",
      tag: WS_METHODS.routinesListThreadRuns,
      staleTimeMs: 0,
    }),
    imageProviders: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:image-providers",
      tag: WS_METHODS.imageProviderList,
      staleTimeMs: 5_000,
    }),
    composioStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:composio-status",
      tag: WS_METHODS.composioGetStatus,
      staleTimeMs: 2_000,
    }),
    composioToolkits: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:composio-toolkits",
      tag: WS_METHODS.composioSearchToolkits,
      staleTimeMs: 30_000,
    }),
    cloudStatus: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:cloud-status",
      tag: WS_METHODS.subscribeCloudStatus,
    }),
    voiceCall: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:voice-call",
      tag: WS_METHODS.voiceCallGet,
      staleTimeMs: 1_000,
    }),
    voiceProviders: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:voice-providers",
      tag: WS_METHODS.voiceProviders,
      staleTimeMs: 5_000,
    }),
    // The doctor shells out to system tools for several seconds; keep a result until Re-run.
    remoteDoctor: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:remote-doctor",
      tag: WS_METHODS.serverGetRemoteDoctor,
      staleTimeMs: 60_000,
    }),
    repairRemoteDoctor: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:repair-remote-doctor",
      tag: WS_METHODS.serverRepairRemoteDoctor,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    configProjection,
    welcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:welcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(Option.none<ServerLifecycleWelcomePayload>, projectServerWelcome),
        ),
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateServer,
    authenticateMcpServer,
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-settings",
      tag: WS_METHODS.serverUpdateSettings,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    startCloudLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:cloud-link-start",
      tag: WS_METHODS.cloudLinkStart,
      concurrency: { mode: "singleFlight", key: ({ environmentId }) => environmentId },
    }),
    cancelCloudLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:cloud-link-cancel",
      tag: WS_METHODS.cloudLinkCancel,
    }),
    forgetCloud: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:cloud-forget",
      tag: WS_METHODS.cloudForget,
    }),
    unlinkCloud: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:cloud-unlink",
      tag: WS_METHODS.cloudUnlink,
    }),
    configureComposio: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:composio-configure",
      tag: WS_METHODS.composioConfigure,
    }),
    removeComposio: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:composio-remove",
      tag: WS_METHODS.composioRemove,
    }),
    authorizeComposio: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:composio-authorize",
      tag: WS_METHODS.composioAuthorize,
    }),
    disconnectComposio: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:composio-disconnect",
      tag: WS_METHODS.composioDisconnect,
    }),
    startSubscriptionAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:start",
      tag: WS_METHODS.subscriptionAuthStart,
    }),
    pollSubscriptionAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:poll",
      tag: WS_METHODS.subscriptionAuthPoll,
    }),
    completeSubscriptionAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:complete",
      tag: WS_METHODS.subscriptionAuthComplete,
    }),
    cancelSubscriptionAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:cancel",
      tag: WS_METHODS.subscriptionAuthCancel,
    }),
    logoutSubscriptionAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:logout",
      tag: WS_METHODS.subscriptionAuthLogout,
    }),
    testSubscriptionAuth: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:health-test",
      tag: WS_METHODS.subscriptionAuthHealthTest,
    }),
    setSubscriptionAccountOrder: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:subscription-auth:set-account-order",
      tag: WS_METHODS.subscriptionAuthSetAccountOrder,
    }),
    testImageProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:image-provider:health-test",
      tag: WS_METHODS.imageProviderHealthTest,
    }),
    startVoiceCall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice-call:start",
      tag: WS_METHODS.voiceCallStart,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    hangupVoiceCall: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice-call:hangup",
      tag: WS_METHODS.voiceCallHangup,
      concurrency: {
        mode: "singleFlight",
        key: voiceCallHangupConcurrencyKey,
      },
    }),
    connectVoiceProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:connect",
      tag: WS_METHODS.voiceConnect,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    disconnectVoiceProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:disconnect",
      tag: WS_METHODS.voiceDisconnect,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    testVoiceProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:test",
      tag: WS_METHODS.voiceTest,
    }),
    listVoiceVoices: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:list-voices",
      tag: WS_METHODS.voiceListVoices,
    }),
    synthesizeVoice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:synthesize",
      tag: WS_METHODS.voiceSynthesize,
    }),
    transcribeVoice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:transcribe",
      tag: WS_METHODS.voiceTranscribe,
    }),
    cancelVoice: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice:cancel",
      tag: WS_METHODS.voiceCancel,
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}

export {
  type ServerUpdateStage,
  type ServerUpdateState,
  type ServerUpdateTarget,
  type McpServerAuthenticationTarget,
} from "./serverTypes.ts";

export {
  ServerUpdateResumeTimeoutError,
  ServerUpdateProgressIncompleteError,
  ServerUpdateTerminalError,
  matchesServerUpdateReadyEvent,
  validateServerUpdateReadyEvent,
  nudgeReconnectDuringUpdateRestart,
  serverUpdateStateForProgressEvent,
  serverUpdateStateForServerVersion,
  isLegacyUpdateHandoffLoss,
  resolveServerUpdateProgressResult,
} from "./serverUpdate.ts";

export { McpServerAuthenticationClientError } from "./mcpAuthentication.ts";

export {
  type ServerConfigProjection,
  applyServerConfigProjection,
  projectServerConfig,
  makeEnvironmentServerConfigState,
  serverConfigStateChanges,
  projectServerWelcome,
  resolveServerConfigValue,
} from "./serverConfig.ts";
