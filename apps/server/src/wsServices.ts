import { computerRegistry } from "./provider/computerRegistry.ts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import {
  AuthAccessWriteScope,
  AuthAccessStreamError,
  type ChannelBinding,
  type AuthEnvironmentScope,
  CommandId,
  type EditorId,
  type OrchestrationClientOrigin,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  ProviderInstanceId,
  type SubscriptionProviderId,
  RpcClientId,
  ComputerError,
  EnvironmentAuthorizationError,
  ImageGenerationError,
  SubscriptionAuthError,
} from "@akeru/contracts";
import { SubscriptionAuthService } from "./subscription-auth/service.ts";
import { makeApiKeySessionReset } from "./subscription-auth/sessionReset.ts";
import { subscriptionProviderSettingsPatch } from "./subscription-auth/runtime.ts";
import { imageProviderStatuses } from "./image-generation/service.ts";
import { deriveProviderInstanceConfigMap } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import {
  buildProviderAccessCapabilities,
  subscriptionDependentBots,
} from "./subscription-auth/snapshot.ts";
import { BotInboxService } from "./bot-inbox/service.ts";
import { syncAccessIncidents, syncConnectorIncidents } from "./bot-inbox/connectorIncidents.ts";
import * as ChannelRuntime from "./channels/ChannelRuntime.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "./config.ts";
import * as Keybindings from "./keybindings.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";
import { OrchestrationCommandReceiptRepository } from "./persistence/Services/OrchestrationCommandReceipts.ts";
import * as ProjectionBots from "./persistence/Services/ProjectionBots.ts";
import * as ProjectionGroups from "./persistence/Services/ProjectionGroups.ts";
import { BotMemoryStore } from "./memory/BotMemory.ts";
import { EntityMemoryRepository } from "./memory/Services/EntityMemoryRepository.ts";
import { MemoryApprovals } from "./memory/MemoryApprovals.ts";
import {
  observeRpcEffect as instrumentRpcEffect,
  observeRpcStream as instrumentRpcStream,
  observeRpcStreamEffect as instrumentRpcStreamEffect,
} from "./observability/RpcInstrumentation.ts";
import * as AgentController from "./provider/Services/AgentController.ts";
import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { isRemoteInstall } from "./remote/remoteMode.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import { RoutineRepository } from "./routines/Repository.ts";
import { RoutineRuntime } from "./routines/Runtime.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as Composio from "./composio/ComposioService.ts";
import { requiredScopeForRpcMethod } from "./auth/RpcAuthorization.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import { BotUsageLedger } from "./usage/BotUsageLedger.ts";
import * as UsageService from "./usage/UsageService.ts";
import * as VoiceCallManager from "./voiceCall/VoiceCallManager.ts";
import * as PairingGrantStore from "./auth/PairingGrantStore.ts";
import * as SessionStore from "./auth/SessionStore.ts";
import {
  isOrchestrationDispatchCommandError,
  subscriptionDriverByProvider,
  subscriptionProviderForDriver,
  resolveAvailableEditorsForConfig,
  resolveFileManagerRevealKindForConfig,
  type ProviderSubscribeRefreshes,
  ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
} from "./wsSupport.ts";

import { createWsMemoryAccess } from "./wsMemoryAccess.ts";

export const createWsServices = (
  currentSession: EnvironmentAuth.AuthenticatedSession,
  clientOrigin: OrchestrationClientOrigin,
  previewAutomationBroker: PreviewAutomationBroker.PreviewAutomationBroker["Service"],
  voiceCalls: VoiceCallManager.VoiceCallManager["Service"],
  providerRefreshes: ProviderSubscribeRefreshes,
) =>
  Effect.gen(function* () {
    const currentSessionId = currentSession.sessionId;

    const crypto = yield* Crypto.Crypto;

    const voiceCallOwnerId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);

    const computerClients = new Set<string>();

    const computerClient = (id: number) => {
      const key = `${voiceCallOwnerId}:${id}`;
      computerClients.add(key);

      return key;
    };

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const client of computerClients) computerRegistry.disconnect(client);
      }),
    );

    const isComputerError = Schema.is(ComputerError);

    const computerOperation = <A>(client: string, operation: () => Promise<A>) =>
      Effect.tryPromise({
        try: operation,
        catch: (cause) =>
          isComputerError(cause)
            ? cause
            : new ComputerError({ code: "adapter", message: "Computer operation failed." }),
      }).pipe(Effect.onInterrupt(() => Effect.sync(() => computerRegistry.disconnect(client))));

    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

    const projectionBots = yield* ProjectionBots.ProjectionBotRepository;

    const botUsageLedger = yield* BotUsageLedger;

    const projectionGroups = yield* ProjectionGroups.ProjectionGroupRepository;

    const routineRepository = yield* RoutineRepository;

    const routineRuntime = yield* RoutineRuntime;

    const orchestrationEngine = yield* OrchestrationEngine.OrchestrationEngineService;

    const canReplayPersistedRange = Effect.fnUntraced(function* (
      afterSequence: number,
      headSequence: number,
      maxGap: number,
    ) {
      const replayGap = headSequence - afterSequence;

      if (replayGap < 0 || replayGap > maxGap) {
        return false;
      }

      const stats = yield* projectionSnapshotQuery
        .getEventReplayStats({
          fromSequenceExclusive: afterSequence,
          toSequenceInclusive: headSequence,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to measure orchestration replay range",
                cause,
              }),
          ),
        );

      if (stats.payloadBytes > ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES) {
        yield* Effect.logDebug("orchestration replay replaced by snapshot", {
          afterSequence,
          headSequence,
          replayGap,
          eventCount: stats.eventCount,
          payloadBytes: stats.payloadBytes,
          payloadBudgetBytes: ORCHESTRATION_REPLAY_PAYLOAD_BUDGET_BYTES,
        });

        return false;
      }

      return true;
    });

    const threadDeletionReactor = yield* ThreadDeletionReactor;

    // Every command dispatched on this connection carries the connecting
    // client's origin, including server-generated bootstrap sub-commands:
    // the client's request caused them.
    const hasClientOrigin =
      clientOrigin.surface !== undefined || clientOrigin.appVersion !== undefined;

    const dispatchActor = {
      personId: currentSessionId,
      canManageGroups: currentSession.scopes.includes(AuthAccessWriteScope),
    };

    const dispatchFromClient: OrchestrationEngine.OrchestrationEngineShape["dispatch"] = (
      command,
    ) =>
      orchestrationEngine.dispatch(command, {
        actor: dispatchActor,
        ...(hasClientOrigin ? { origin: clientOrigin } : {}),
      });

    const checkpointDiffQuery = yield* CheckpointDiffQuery.CheckpointDiffQuery;

    const keybindings = yield* Keybindings.Keybindings;

    const externalLauncher = yield* ExternalLauncher.ExternalLauncher;

    const remoteOpenTargets = yield* RemoteOpenTargets.RemoteOpenTargets;

    const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;

    const previewManager = yield* PreviewManager.PreviewManager;

    const portDiscovery = yield* PortScanner.PortDiscovery;

    const agentController = yield* AgentController.AgentController;

    const entityMemoryRepositoryOption = yield* Effect.serviceOption(EntityMemoryRepository);

    const entityMemoryRepository = Option.getOrNull(entityMemoryRepositoryOption);

    const memoryApprovals = Option.getOrNull(yield* Effect.serviceOption(MemoryApprovals));

    const providerRegistry = yield* ProviderRegistry.ProviderRegistry;

    const providerMaintenanceRunner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;

    const serverSelfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;

    const config = yield* ServerConfig.ServerConfig;

    const remoteDoctorTarget = {
      baseDir: config.baseDir,
      remote: isRemoteInstall({
        launcherManaged: Option.match(
          yield* Effect.serviceOption(ServiceLauncherClient.ServiceLauncherClient),
          { onNone: () => false, onSome: (launcher) => launcher.managed },
        ),
        env: process.env,
      }),
    };

    const botMemoryStore = new BotMemoryStore(config.stateDir);

    const subscriptionAuth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir, {
      checkHealthOnConnect: true,
    });

    const botInbox = BotInboxService.forSecretsDir(config.secretsDir);

    const lifecycleEvents = yield* ServerLifecycleEvents.ServerLifecycleEvents;

    const serverSettings = yield* ServerSettings.ServerSettingsService;

    const syncSubscriptionProviderSettings = Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings;
      const patch = subscriptionProviderSettingsPatch(settings, subscriptionAuth.statuses());

      if (patch) yield* serverSettings.updateSettings(patch);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Failed to align provider settings with subscription connections", {
          detail: cause.message,
        }),
      ),
    );

    yield* syncSubscriptionProviderSettings;

    const resetChangedApiKeySessions = makeApiKeySessionReset(
      subscriptionAuth,
      agentController,
      serverSettings.getSettings.pipe(
        Effect.map(deriveProviderInstanceConfigMap),
        Effect.orElseSucceed(() => ({})),
      ),
    );

    const validateAccountInstance = Effect.fn("validateAccountInstance")(function* (
      provider: SubscriptionProviderId,
      instanceId: ProviderInstanceId | undefined,
    ) {
      if (!instanceId) return;

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => new SubscriptionAuthError({ reason: cause.message })),
      );

      const instance = deriveProviderInstanceConfigMap(settings)[instanceId];
      const driver = subscriptionDriverByProvider[provider];

      if (instance?.driver !== driver) {
        return yield* new SubscriptionAuthError({
          reason: `Provider instance '${instanceId}' does not belong to ${provider}.`,
        });
      }
    });

    const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;

    const workspaceEntries = yield* WorkspaceEntries.WorkspaceEntries;

    const workspaceFileSystem = yield* WorkspaceFileSystem.WorkspaceFileSystem;

    const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;

    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;

    const rpcClientIds = yield* Ref.make(new Set<RpcClientId>());

    yield* Effect.addFinalizer(() =>
      Effect.all(
        [
          Ref.get(rpcClientIds).pipe(
            Effect.flatMap((clientIds) =>
              Effect.forEach(
                clientIds,
                (clientId) => backgroundPolicy.removeRpcClient(currentSessionId, clientId),
                { discard: true },
              ),
            ),
            Effect.ignore,
          ),
          voiceCalls.hangupOwner(voiceCallOwnerId),
        ],
        { discard: true },
      ),
    );

    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;

    const secretStore = yield* ServerSecretStore.ServerSecretStore;

    const composioService = yield* Effect.serviceOption(Composio.ComposioService);

    const composio = Option.getOrElse(composioService, () => Composio.make(secretStore));

    const commandReceipts = yield* Effect.serviceOption(OrchestrationCommandReceiptRepository);

    const channelRuntime = yield* Effect.serviceOption(ChannelRuntime.ChannelRuntime);

    const channelBindingsForRuntime = (bindings: ReadonlyArray<ChannelBinding>) =>
      Option.match(channelRuntime, {
        onNone: () => ChannelRuntime.channelBindingsForRuntime(bindings, () => false),
        onSome: (runtime) => runtime.channelBindingsForRuntime(bindings),
      });

    const bootstrapCredentials = yield* PairingGrantStore.PairingGrantStore;

    const sessions = yield* SessionStore.SessionStore;

    const processDiagnostics = yield* ProcessDiagnostics.ProcessDiagnostics;

    const processResourceMonitor = yield* ProcessResourceMonitor.ProcessResourceMonitor;

    const resourceTelemetry = yield* ResourceTelemetry.ResourceTelemetry;

    const usage = yield* UsageService.UsageService;

    const { resolveMemoryAccess, resolveBotMemoryAccess, readArchiveConversations } =
      createWsMemoryAccess(projectionSnapshotQuery, projectionGroups, agentController);

    const authorizationError = (requiredScope: AuthEnvironmentScope) =>
      new EnvironmentAuthorizationError({
        message: `The authenticated token is missing required scope: ${requiredScope}.`,
        requiredScope,
      });

    const getAccessHealthSnapshot = Effect.fn("getAccessHealthSnapshot")(function* () {
      yield* subscriptionAuth.reload();
      botInbox.reload();
      yield* syncSubscriptionProviderSettings;

      const [providers, bots, snapshot, settings] = yield* Effect.all([
        providerRegistry.getProviders,
        projectionBots
          .listAll()
          .pipe(Effect.mapError((cause) => new SubscriptionAuthError({ reason: cause.message }))),
        projectionSnapshotQuery
          .getShellSnapshot()
          .pipe(Effect.mapError((cause) => new SubscriptionAuthError({ reason: cause.message }))),
        serverSettings.getSettings.pipe(
          Effect.mapError((cause) => new SubscriptionAuthError({ reason: cause.message })),
        ),
      ]);

      const dependentBots = subscriptionDependentBots(
        bots.map((bot) => ({ id: bot.botId, name: bot.name, engine: bot.engine })),
        providers,
      );

      const subscriptionStatuses = subscriptionAuth.statuses(dependentBots);

      const access = buildProviderAccessCapabilities(
        subscriptionStatuses,
        providers,
        (instanceId) => subscriptionAuth.providerInstanceRequestHealth(instanceId),
        snapshot.mcpServers ?? [],
        bots.map((bot) => ({
          id: bot.botId,
          name: bot.name,
          engine: bot.engine,
          disabledMcpServerIds: bot.disabledMcpServerIds,
        })),
        (serverId) => subscriptionAuth.mcpRequestHealth(serverId),
      );

      syncConnectorIncidents(botInbox, subscriptionStatuses);
      syncAccessIncidents(botInbox, access);

      return {
        providers: subscriptionStatuses.map((status) => ({
          ...status,
          dependentBots: status.dependentBots.filter((dependent) =>
            bots.some(
              (bot) =>
                bot.botId === dependent.id &&
                bot.engine?.provider === subscriptionDriverByProvider[status.provider],
            ),
          ),
        })),
        accounts: Object.entries(deriveProviderInstanceConfigMap(settings)).flatMap(
          ([instanceId, instance]) => {
            const provider = subscriptionProviderForDriver(instance.driver);

            return provider && instanceId !== subscriptionDriverByProvider[provider]
              ? [
                  subscriptionAuth.accountStatus(
                    provider,
                    ProviderInstanceId.make(instanceId),
                    bots
                      .filter((bot) => bot.engine?.provider === instanceId)
                      .map((bot) => ({
                        id: bot.botId,
                        name: bot.name,
                        provider,
                      })),
                  ),
                ]
              : [];
          },
        ),
        access,
        inbox: botInbox.list(),
      };
    });

    const getImageProviderSnapshot = Effect.fn("getImageProviderSnapshot")(function* () {
      yield* subscriptionAuth.reload();

      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError((cause) => new ImageGenerationError({ reason: cause.message })),
      );

      return {
        providers: imageProviderStatuses({
          settings: settings.imageGeneration,
          subscriptionStatuses: subscriptionAuth.statuses(),
          chatgptAccountConnected: subscriptionAuth.hasOpenAICodexAccount(),
          requestHealth: (provider) => subscriptionAuth.imageRequestHealth(provider),
          lastGenerationAt: (provider) => subscriptionAuth.imageLastGenerationAt(provider),
        }),
      };
    });

    const authorizeEffect = <A, E, R>(
      requiredScope: AuthEnvironmentScope,
      effect: Effect.Effect<A, E, R>,
    ): Effect.Effect<A, E | EnvironmentAuthorizationError, R> =>
      currentSession.scopes.includes(requiredScope)
        ? effect
        : Effect.fail(authorizationError(requiredScope));

    const authorizeStream = <A, E, R>(
      requiredScope: AuthEnvironmentScope,
      stream: Stream.Stream<A, E, R>,
    ): Stream.Stream<A, E | EnvironmentAuthorizationError, R> =>
      currentSession.scopes.includes(requiredScope)
        ? stream
        : Stream.fail(authorizationError(requiredScope));

    const observeRpcEffect = <A, E, R>(
      method: string,
      effect: Effect.Effect<A, E, R>,
      traceAttributes?: Parameters<typeof instrumentRpcEffect>[2],
    ) =>
      instrumentRpcEffect(
        method,
        authorizeEffect(requiredScopeForRpcMethod(method), effect),
        traceAttributes,
      );

    const observeRpcStream = <A, E, R>(
      method: string,
      stream: Stream.Stream<A, E, R>,
      traceAttributes?: Parameters<typeof instrumentRpcEffect>[2],
    ) =>
      instrumentRpcStream(
        method,
        authorizeStream(requiredScopeForRpcMethod(method), stream),
        traceAttributes,
      );

    const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
      method: string,
      effect: Effect.Effect<
        Stream.Stream<A, StreamError, StreamContext>,
        EffectError,
        EffectContext
      >,
      traceAttributes?: Parameters<typeof instrumentRpcEffect>[2],
    ) =>
      instrumentRpcStreamEffect(
        method,
        authorizeEffect(requiredScopeForRpcMethod(method), effect),
        traceAttributes,
      );

    const toDispatchCommandError = (cause: unknown, fallbackMessage: string) =>
      isOrchestrationDispatchCommandError(cause)
        ? cause
        : new OrchestrationDispatchCommandError({
            message: cause instanceof Error ? cause.message : fallbackMessage,
            cause,
          });

    const randomUUID = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        toDispatchCommandError(cause, "Failed to generate orchestration command identifier."),
      ),
    );

    const serverCommandId = (tag: string) =>
      randomUUID.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

    const loadEnvironmentPeople = () =>
      serverAuth.listClientSessions(currentSessionId).pipe(
        Effect.map((clientSessions) => {
          const currentClient = clientSessions.find(
            (session) => session.sessionId === currentSessionId,
          );

          const hostClient = clientSessions.find((session) =>
            session.scopes.includes(AuthAccessWriteScope),
          );

          return {
            current: {
              personId: currentSessionId,
              displayName:
                currentClient?.client.label ??
                (currentSession.scopes.includes(AuthAccessWriteScope) ? "Host" : "Paired person"),
            },
            host:
              hostClient === undefined
                ? undefined
                : {
                    personId: hostClient.sessionId,
                    displayName: hostClient.client.label ?? "Host",
                  },
          };
        }),
      );

    const loadAuthAccessSnapshot = () =>
      Effect.all({
        pairingLinks: serverAuth.listPairingLinks(),
        clientSessions: serverAuth.listClientSessions(currentSessionId),
      }).pipe(
        Effect.mapError(
          (error) =>
            new AuthAccessStreamError({
              message: error.message,
            }),
        ),
      );

    const toBootstrapDispatchCommandCauseError = (cause: Cause.Cause<unknown>) => {
      const error = Cause.squash(cause);

      return isOrchestrationDispatchCommandError(error)
        ? error
        : new OrchestrationDispatchCommandError({
            message: error instanceof Error ? error.message : "Failed to start the chat.",
            cause,
          });
    };

    const loadServerConfig = Effect.gen(function* () {
      const keybindingsConfig = yield* keybindings.loadConfigState;
      const providers = yield* providerRegistry.getProviders;

      const settings = ServerSettings.redactServerSettingsForClient(
        yield* serverSettings.getSettings,
      );

      const environment = yield* serverEnvironment.getDescriptor;
      const auth = yield* serverAuth.getDescriptor();

      const availableEditors: ReadonlyArray<EditorId> = yield* resolveAvailableEditorsForConfig(
        externalLauncher.resolveAvailableEditors(),
      );

      const fileManagerRevealKind = availableEditors.includes("file-manager")
        ? yield* resolveFileManagerRevealKindForConfig(
            externalLauncher.resolveFileManagerRevealKind(),
          )
        : undefined;

      return {
        environment,
        auth,
        cwd: config.cwd,
        keybindingsConfigPath: config.keybindingsConfigPath,
        keybindings: keybindingsConfig.keybindings,
        issues: keybindingsConfig.issues,
        providers,
        availableEditors,
        // Same discovery-with-timeout treatment as editors: a slow probe
        // must not stall server.getConfig, so it degrades to no targets.
        remoteOpenTargets: yield* resolveAvailableEditorsForConfig(
          remoteOpenTargets.resolveTargets(),
        ),
        observability: {
          logsDirectoryPath: config.logsDir,
          localTracingEnabled: true,
          ...(config.otlpTracesUrl !== undefined ? { otlpTracesUrl: config.otlpTracesUrl } : {}),
          otlpTracesEnabled: config.otlpTracesUrl !== undefined,
          ...(config.otlpMetricsUrl !== undefined ? { otlpMetricsUrl: config.otlpMetricsUrl } : {}),
          otlpMetricsEnabled: config.otlpMetricsUrl !== undefined,
        },
        settings,
        shellResumeCompletionMarker: true,
        ...(fileManagerRevealKind === undefined
          ? {}
          : {
              shellRevealInFileManager: true,
              shellRevealInFileManagerKind: fileManagerRevealKind,
            }),
        threadResumeCompletionMarker: true,
        threadSnapshotPagination: true,
      };
    });

    return {
      currentSession,
      clientOrigin,
      previewAutomationBroker,
      voiceCalls,
      providerRefreshes,
      currentSessionId,
      crypto,
      voiceCallOwnerId,
      computerClients,
      computerClient,
      isComputerError,
      computerOperation,
      projectionSnapshotQuery,
      projectionBots,
      botUsageLedger,
      projectionGroups,
      routineRepository,
      routineRuntime,
      orchestrationEngine,
      canReplayPersistedRange,
      threadDeletionReactor,
      hasClientOrigin,
      dispatchActor,
      dispatchFromClient,
      checkpointDiffQuery,
      keybindings,
      externalLauncher,
      remoteOpenTargets,
      gitWorkflow,
      previewManager,
      portDiscovery,
      agentController,
      entityMemoryRepositoryOption,
      entityMemoryRepository,
      memoryApprovals,
      providerRegistry,
      providerMaintenanceRunner,
      serverSelfUpdate,
      config,
      remoteDoctorTarget,
      botMemoryStore,
      subscriptionAuth,
      botInbox,
      lifecycleEvents,
      serverSettings,
      syncSubscriptionProviderSettings,
      resetChangedApiKeySessions,
      validateAccountInstance,
      startup,
      workspaceEntries,
      workspaceFileSystem,
      serverEnvironment,
      backgroundPolicy,
      rpcClientIds,
      serverAuth,
      secretStore,
      composioService,
      composio,
      commandReceipts,
      channelRuntime,
      channelBindingsForRuntime,
      bootstrapCredentials,
      sessions,
      processDiagnostics,
      processResourceMonitor,
      resourceTelemetry,
      usage,
      resolveMemoryAccess,
      resolveBotMemoryAccess,
      readArchiveConversations,
      authorizationError,
      getAccessHealthSnapshot,
      getImageProviderSnapshot,
      authorizeEffect,
      authorizeStream,
      observeRpcEffect,
      observeRpcStream,
      observeRpcStreamEffect,
      toDispatchCommandError,
      randomUUID,
      serverCommandId,
      loadEnvironmentPeople,
      loadAuthAccessSnapshot,
      toBootstrapDispatchCommandCauseError,
      loadServerConfig,
    };
  });

export type WsServices = Effect.Success<ReturnType<typeof createWsServices>>;
