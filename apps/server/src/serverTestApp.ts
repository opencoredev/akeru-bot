// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import { HostProcessEnvironment } from "@akeru/shared/hostProcess";

import { DEFAULT_SERVER_SETTINGS, type PreviewEvent } from "@akeru/contracts";

import * as Context from "effect/Context";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as PubSub from "effect/PubSub";

import * as Stream from "effect/Stream";

import { ChildProcessSpawner } from "effect/unstable/process";

import { FetchHttpClient, HttpRouter } from "effect/unstable/http";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";

import * as ServerConfig from "./config.ts";

// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This test composition root builds routes with the requested fake dependencies.
import { makeRoutesLayer } from "./server.ts";

import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";

import * as Keybindings from "./keybindings.ts";

import * as ExternalLauncher from "./process/externalLauncher.ts";

import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";

import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";

import { ThreadDeletionReactor } from "./orchestration/Services/ThreadDeletionReactor.ts";

import * as ProjectionSnapshotQuery from "./orchestration/Services/ProjectionSnapshotQuery.ts";

import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";

import { OrchestrationCommandReceiptRepository } from "./persistence/Services/OrchestrationCommandReceipts.ts";

import * as ProjectionBots from "./persistence/Services/ProjectionBots.ts";

import * as ProjectionGroups from "./persistence/Services/ProjectionGroups.ts";

import { EntityMemoryRepositoryLive } from "./memory/Layers/EntityMemoryRepository.ts";

import { MemoryRevisionWriteLockLive } from "./memory/Services/MemoryRevisionWriteLock.ts";

import {
  EntityMemoryRepository,
  type EntityMemoryRepositoryShape,
  type EntityMemoryRepositoryError,
} from "./memory/Services/EntityMemoryRepository.ts";

import * as AgentController from "./provider/Services/AgentController.ts";

import * as ProviderRegistry from "./provider/Services/ProviderRegistry.ts";

import { manualOnlyProviderMaintenanceCapabilities } from "./provider/providerMaintenance.ts";

import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";

import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";

import * as ServerSettings from "./serverSettings.ts";

import * as PreviewManager from "./preview/Manager.ts";

import * as PortScanner from "./preview/PortScanner.ts";

import * as BrowserTraceCollector from "./observability/BrowserTraceCollector.ts";

import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";

import * as ServerEnvironment from "./environment/ServerEnvironment.ts";

import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";

import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";

import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";

import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

import * as VcsDriver from "./vcs/VcsDriver.ts";

import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";

import * as GitWorkflowService from "./git/GitWorkflowService.ts";

import * as ServerSecretStore from "./auth/ServerSecretStore.ts";

import * as ChannelDeliveryStore from "./channels/ChannelDeliveryStore.ts";

import * as ChannelRuntime from "./channels/ChannelRuntime.ts";

import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";

import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";

import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";

import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";

import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";

import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";

import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";

import * as UsageService from "./usage/UsageService.ts";

import { BotUsageLedger, type BotUsageLedgerShape } from "./usage/BotUsageLedger.ts";

import * as AnalyticsService from "./telemetry/AnalyticsService.ts";

import { RoutineRepository, type RoutineRepositoryShape } from "./routines/Repository.ts";

import { RoutineRuntime, type RoutineRuntimeShape } from "./routines/Runtime.ts";

import {
  defaultDesktopBootstrapToken,
  TEST_EPOCH,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This pure fixture creates the initial read model for an isolated test server.
  makeDefaultOrchestrationReadModel,
  defaultThreadId,
  testEnvironmentDescriptor,
} from "./serverTestFixtures.ts";

// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- This test composition root assembles authentication for its sandbox environment.
import { makeAuthTestLayer } from "./serverTestClients.ts";

export const buildAppUnderTest = (options?: {
  durableMemory?: {
    readonly seed?: (
      repository: EntityMemoryRepositoryShape,
    ) => Effect.Effect<void, EntityMemoryRepositoryError, never>;
  };
  config?: Partial<ServerConfig.ServerConfig["Service"]>;
  layers?: {
    keybindings?: Partial<Keybindings.Keybindings["Service"]>;
    providerRegistry?: Partial<ProviderRegistry.ProviderRegistry["Service"]>;
    agentController?: Partial<AgentController.AgentController["Service"]>;
    serverSettings?: Partial<ServerSettings.ServerSettingsService["Service"]>;
    externalLauncher?: Partial<ExternalLauncher.ExternalLauncher["Service"]>;
    vcsDriver?: Partial<VcsDriver.VcsDriver["Service"]>;
    vcsDriverRegistry?: Partial<VcsDriverRegistry.VcsDriverRegistry["Service"]>;
    gitVcsDriver?: Partial<GitVcsDriver.GitVcsDriver["Service"]>;
    previewManager?: Partial<PreviewManager.PreviewManager["Service"]>;
    orchestrationEngine?: Partial<OrchestrationEngine.OrchestrationEngineService["Service"]>;
    commandReceipts?: Partial<OrchestrationCommandReceiptRepository["Service"]>;
    threadDeletionReactor?: Partial<ThreadDeletionReactor["Service"]>;
    routineRepository?: Partial<RoutineRepositoryShape>;
    routineRuntime?: Partial<RoutineRuntimeShape>;
    projectionSnapshotQuery?: Partial<ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]>;
    projectionBots?: Partial<ProjectionBots.ProjectionBotRepositoryShape>;
    projectionGroups?: Partial<ProjectionGroups.ProjectionGroupRepositoryShape>;
    botUsageLedger?: Partial<BotUsageLedgerShape>;
    checkpointDiffQuery?: Partial<CheckpointDiffQuery.CheckpointDiffQuery["Service"]>;
    browserTraceCollector?: Partial<BrowserTraceCollector.BrowserTraceCollector["Service"]>;
    serverLifecycleEvents?: Partial<ServerLifecycleEvents.ServerLifecycleEvents["Service"]>;
    serverRuntimeStartup?: Partial<ServerRuntimeStartup.ServerRuntimeStartup["Service"]>;
    channelDeliveryStore?: ChannelDeliveryStore.ChannelDeliveryStoreShape | null;
    channelRuntime?: Partial<ChannelRuntime.ChannelRuntimeShape> &
      Pick<ChannelRuntime.ChannelRuntimeShape, "channelBindingsForRuntime">;
    serverEnvironment?: Partial<ServerEnvironment.ServerEnvironment["Service"]>;
    repositoryIdentityResolver?: Partial<
      RepositoryIdentityResolver.RepositoryIdentityResolver["Service"]
    >;
    nativeTelemetryClient?: Partial<NativeTelemetryClient.NativeTelemetryClient["Service"]>;
    desktopTelemetryReceiver?: Partial<
      DesktopTelemetryReceiver.DesktopTelemetryReceiver["Service"]
    >;
  };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const tempBaseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-router-test-" });
    const baseDir = options?.config?.baseDir ?? tempBaseDir;
    const devUrl = options?.config?.devUrl;
    const derivedPaths = yield* ServerConfig.deriveServerPaths(baseDir, devUrl);

    const config: ServerConfig.ServerConfig["Service"] = {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 200,
      traceMaxBytes: 10 * 1024 * 1024,
      traceMaxFiles: 10,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 10_000,
      otlpServiceName: "akeru-server",
      mode: "desktop",
      port: 0,
      host: "127.0.0.1",
      cwd: process.cwd(),
      baseDir,
      ...derivedPaths,
      staticDir: undefined,
      devUrl,
      devAllowedOrigins: [],
      noBrowser: true,
      startupPresentation: "browser",
      desktopBootstrapToken: defaultDesktopBootstrapToken,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      publicOrigin: undefined,
      ...options?.config,
    };

    const layerConfig = ServerConfig.layer(config);

    const defaultVcsDriver: VcsDriver.VcsDriver["Service"] = {
      capabilities: {
        kind: "git",
        supportsWorktrees: true,
        supportsBookmarks: false,
        supportsAtomicSnapshot: false,
        supportsPushDefaultRemote: true,
        ignoreClassifier: "native",
      },
      execute: () =>
        Effect.succeed({
          exitCode: ChildProcessSpawner.ExitCode(0),
          stdout: "",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        }),
      detectRepository: () => Effect.succeed(null),
      isInsideWorkTree: () => Effect.succeed(false),
      listWorkspaceFiles: () =>
        Effect.succeed({
          paths: [],
          truncated: false,
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      listRemotes: () =>
        Effect.succeed({
          remotes: [],
          freshness: {
            source: "live-local",
            observedAt: TEST_EPOCH,
            expiresAt: Option.none(),
          },
        }),
      filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
      initRepository: () => Effect.void,
      ...options?.layers?.vcsDriver,
    };

    const vcsDriverRegistryLayer = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      get: () => Effect.succeed(defaultVcsDriver),
      detect: (input) =>
        defaultVcsDriver.detectRepository(input.cwd).pipe(
          Effect.flatMap((repository) =>
            repository
              ? Effect.succeed(repository)
              : defaultVcsDriver.isInsideWorkTree(input.cwd).pipe(
                  Effect.map((isInsideWorkTree) =>
                    isInsideWorkTree
                      ? {
                          kind: "git" as const,
                          rootPath: input.cwd,
                          metadataPath: null,
                          freshness: {
                            source: "live-local" as const,
                            observedAt: TEST_EPOCH,
                            expiresAt: Option.none(),
                          },
                        }
                      : null,
                  ),
                ),
          ),
          Effect.map((repository) =>
            repository
              ? ({
                  kind: repository.kind,
                  repository,
                  driver: defaultVcsDriver,
                } satisfies VcsDriverRegistry.VcsDriverHandle)
              : null,
          ),
        ),
      resolve: (input) =>
        Effect.succeed({
          kind:
            input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
          repository: {
            kind:
              input.requestedKind === "auto" || !input.requestedKind ? "git" : input.requestedKind,
            rootPath: input.cwd,
            metadataPath: null,
            freshness: {
              source: "live-local",
              observedAt: TEST_EPOCH,
              expiresAt: Option.none(),
            },
          },
          driver: defaultVcsDriver,
        }),
      ...options?.layers?.vcsDriverRegistry,
    });

    const gitVcsDriverLayer = Layer.mock(GitVcsDriver.GitVcsDriver)({
      ...options?.layers?.gitVcsDriver,
    });

    const workspaceEntriesLayer = WorkspaceEntries.layer.pipe(
      Layer.provide(WorkspacePaths.layer),
      Layer.provideMerge(vcsDriverRegistryLayer),
    );

    const workspaceAndProjectServicesLayer = Layer.mergeAll(
      WorkspacePaths.layer,
      workspaceEntriesLayer,
      WorkspaceFileSystem.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(workspaceEntriesLayer),
      ),
    );

    const gitWorkflowLayer = GitWorkflowService.layer.pipe(
      Layer.provideMerge(vcsDriverRegistryLayer),
      Layer.provideMerge(gitVcsDriverLayer),
    );

    const resourceTelemetryLayer = ResourceTelemetry.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NativeTelemetryClient.layerTest(options?.layers?.nativeTelemetryClient),
          DesktopTelemetryReceiver.layerTest(options?.layers?.desktopTelemetryReceiver),
          ResourceAttribution.layer,
        ),
      ),
    );

    const serviceLauncherClientLayer = ServiceLauncherClient.layer.pipe(
      Layer.provide(Layer.succeed(HostProcessEnvironment, {})),
    );

    const servedRoutesLayer = HttpRouter.serve(
      makeRoutesLayer.pipe(Layer.provide(serviceLauncherClientLayer)),
      {
        disableListenLog: true,
        disableLogger: true,
      },
    ).pipe(
      Layer.provide(
        Layer.mock(Keybindings.Keybindings)({
          loadConfigState: Effect.succeed({
            keybindings: [],
            issues: [],
          }),
          streamChanges: Stream.empty,
          ...options?.layers?.keybindings,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([]),
            refresh: () => Effect.succeed([]),
            refreshInstance: () => Effect.succeed([]),
            getProviderMaintenanceCapabilitiesForInstance: (_instanceId, provider) =>
              Effect.succeed(
                manualOnlyProviderMaintenanceCapabilities({ provider, packageName: null }),
              ),
            setProviderMaintenanceActionState: () => Effect.succeed([]),
            streamChanges: Stream.empty,
            ...options?.layers?.providerRegistry,
          }),
          Layer.mock(AgentController.AgentController)({
            uploadFeedback: () => Effect.die("Provider feedback is not stubbed in this test"),
            ...options?.layers?.agentController,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ServerSettings.ServerSettingsService)({
          start: Effect.void,
          ready: Effect.void,
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
          streamChanges: Stream.empty,
          ...options?.layers?.serverSettings,
        }),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ExternalLauncher.ExternalLauncher)({
            resolveAvailableEditors: () => Effect.succeed([]),
            resolveFileManagerRevealKind: () => Effect.sync((): undefined => undefined),
            ...options?.layers?.externalLauncher,
          }),
          Layer.mock(RemoteOpenTargets.RemoteOpenTargets)({
            resolveTargets: () => Effect.succeed([]),
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(ProcessDiagnostics.ProcessDiagnostics)({
          read: Effect.succeed({
            serverPid: process.pid,
            readAt: TEST_EPOCH,
            processCount: 0,
            totalRssBytes: 0,
            totalCpuPercent: 0,
            processes: [],
            error: Option.none(),
          }),
          signal: (input) =>
            Effect.succeed({
              pid: input.pid,
              signal: input.signal,
              signaled: true,
              message: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(ProcessResourceMonitor.ProcessResourceMonitor)({
          readHistory: (input) =>
            Effect.succeed({
              readAt: TEST_EPOCH,
              windowMs: input.windowMs,
              bucketMs: input.bucketMs,
              sampleIntervalMs: 5_000,
              retainedSampleCount: 0,
              totalCpuSecondsApprox: 0,
              buckets: [],
              topProcesses: [],
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(
        Layer.mock(TraceDiagnostics.TraceDiagnostics)({
          read: () =>
            Effect.succeed({
              traceFilePath: "",
              scannedFilePaths: [],
              readAt: TEST_EPOCH,
              recordCount: 0,
              parseErrorCount: 0,
              firstSpanAt: Option.none(),
              lastSpanAt: Option.none(),
              failureCount: 0,
              interruptionCount: 0,
              slowSpanThresholdMs: 1_000,
              slowSpanCount: 0,
              logLevelCounts: {},
              topSpansByCount: [],
              slowestSpans: [],
              commonFailures: [],
              latestFailures: [],
              latestWarningAndErrorLogs: [],
              partialFailure: Option.none(),
              error: Option.none(),
            }),
        }),
      ),
      Layer.provide(gitVcsDriverLayer),
      Layer.provide(gitWorkflowLayer),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(PreviewManager.PreviewManager)({
            open: () => Effect.die("PreviewManager not stubbed in this test"),
            navigate: () => Effect.die("PreviewManager not stubbed in this test"),
            resize: () => Effect.die("PreviewManager not stubbed in this test"),
            reportStatus: () => Effect.void,
            refresh: () => Effect.void,
            close: () => Effect.void,
            list: () => Effect.succeed({ sessions: [], serverEpoch: "test-server", revision: 0 }),
            streamEvents: () => Stream.empty,
            subscribeEvents: Effect.flatMap(PubSub.unbounded<PreviewEvent>(), (pubsub) =>
              PubSub.subscribe(pubsub),
            ),
            ...options?.layers?.previewManager,
          }),
          Layer.mock(PortScanner.PortDiscovery)({
            scan: () => Effect.succeed([]),
            subscribe: () => Effect.void,
            retain: Effect.void,
          }),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
            readEvents: () => Stream.empty,
            readThreadEvents: () => Stream.empty,
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: 0,
                payloadBytes: 0,
                hasCreateEvent: false,
              }),
            dispatch: () => Effect.succeed({ sequence: 0 }),
            streamDomainEvents: Stream.empty,
            subscribeDomainEvents: Effect.succeed(Stream.empty),
            latestSequence: Effect.succeed(0),
            ...options?.layers?.orchestrationEngine,
          }),
          Layer.succeed(
            OrchestrationCommandReceiptRepository,
            OrchestrationCommandReceiptRepository.of({
              getByCommandId: () => Effect.succeed(Option.none()),
              upsert: () => Effect.void,
              ...options?.layers?.commandReceipts,
            }),
          ),
          Layer.mock(ThreadDeletionReactor)({
            start: () => Effect.void,
            drain: Effect.void,
            drainThrough: () => Effect.void,
            ...options?.layers?.threadDeletionReactor,
          }),
          Layer.succeed(
            RoutineRepository,
            RoutineRepository.of({
              listAll: Effect.succeed([]),
              listEnabled: Effect.succeed([]),
              getById: () => Effect.succeed(null),
              listRuns: () => Effect.succeed([]),
              listThreadRuns: () => Effect.succeed({ runs: [], nextCursor: null }),
              listAllRuns: Effect.succeed([]),
              getActiveRunByThreadRef: () => Effect.succeed(null),
              listSkillAssignments: Effect.succeed([]),
              claim: () => Effect.succeed(false),
              markDispatched: () => Effect.void,
              markBlocked: () => Effect.void,
              listRecoverable: Effect.succeed([]),
              ...options?.layers?.routineRepository,
              markSettled: options?.layers?.routineRepository?.markSettled ?? (() => Effect.void),
            } satisfies RoutineRepositoryShape),
          ),
          Layer.succeed(
            RoutineRuntime,
            RoutineRuntime.of({
              runDue: Effect.void,
              canRunNow: () => Effect.succeed(true),
              runNow: () => Effect.succeed(null),
              recover: Effect.void,
              start: Effect.void,
              ...options?.layers?.routineRuntime,
            } satisfies RoutineRuntimeShape),
          ),
        ),
      ),
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(ProjectionBots.ProjectionBotRepository, {
            upsert: () => Effect.void,
            getById: () => Effect.succeed(Option.none()),
            listAll: () => Effect.succeed([]),
            deleteById: () => Effect.void,
            ...options?.layers?.projectionBots,
          } satisfies ProjectionBots.ProjectionBotRepositoryShape),
          Layer.mock(BotUsageLedger)({
            pricingTotals: () => Effect.succeed({ complete: true, models: [] }),
            summarize: (botId) =>
              Effect.succeed({
                botId,
                consumedTokens: 0,
                reservedTokens: 0,
                measurements: {
                  input: { tokens: 0, unavailableEntries: 0 },
                  output: { tokens: 0, unavailableEntries: 0 },
                  observer: { tokens: 0, unavailableEntries: 0 },
                  reflector: { tokens: 0, unavailableEntries: 0 },
                },
                entries: [],
              }),
            ...options?.layers?.botUsageLedger,
          }),
          Layer.succeed(ProjectionGroups.ProjectionGroupRepository, {
            upsert: () => Effect.void,
            getById: () => Effect.succeed(Option.none()),
            listAll: () => Effect.succeed([]),
            deleteById: () => Effect.void,
            ...options?.layers?.projectionGroups,
          } satisfies ProjectionGroups.ProjectionGroupRepositoryShape),
          Layer.mock(ProjectionSnapshotQuery.ProjectionSnapshotQuery)({
            getCommandReadModel: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            getSnapshot: () => Effect.succeed(makeDefaultOrchestrationReadModel()),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                bots: [],
                groups: [],
                delegations: [],
                projects: [],
                threads: [],
                updatedAt: "1970-01-01T00:00:00.000Z",
              }),
            getArchivedShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 0,
                bots: [],
                groups: [],
                delegations: [],
                projects: [],
                threads: [],
                updatedAt: "1970-01-01T00:00:00.000Z",
              }),
            searchThreads: () => Effect.succeed({ matches: [] }),
            getSnapshotSequence: () => Effect.succeed({ snapshotSequence: 0 }),
            getProjectShellById: () => Effect.succeed(Option.none()),
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
            getThreadDetailById: () => Effect.succeed(Option.none()),
            getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
            getCounts: () => Effect.succeed({ projectCount: 0, threadCount: 0 }),
            getEventReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) =>
              Effect.succeed({
                eventCount: Math.max(0, toSequenceInclusive - fromSequenceExclusive),
                payloadBytes: 0,
              }),
            getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
            getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
            getThreadCheckpointContext: () => Effect.succeed(Option.none()),
            ...options?.layers?.projectionSnapshotQuery,
          }),
        ),
      ),
      Layer.provide(
        Layer.mock(CheckpointDiffQuery.CheckpointDiffQuery)({
          getTurnDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          getFullThreadDiff: () =>
            Effect.succeed({
              threadId: defaultThreadId,
              fromTurnCount: 0,
              toTurnCount: 0,
              diff: "",
            }),
          ...options?.layers?.checkpointDiffQuery,
        }),
      ),
    );

    const appLayer = servedRoutesLayer.pipe(
      Layer.provide(resourceTelemetryLayer),
      Layer.provide(UsageService.layerTest),
      Layer.provide(
        Layer.mock(AnalyticsService.AnalyticsService)({
          flush: Effect.void,
        }),
      ),
      Layer.provide(
        Layer.mock(BrowserTraceCollector.BrowserTraceCollector)({
          record: () => Effect.void,
          ...options?.layers?.browserTraceCollector,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) => Effect.succeed({ ...event, sequence: 1 }),
          snapshot: Effect.succeed({ sequence: 0, events: [] }),
          stream: Stream.empty,
          ...options?.layers?.serverLifecycleEvents,
        }),
      ),
      Layer.provide(
        Layer.mock(ServerRuntimeStartup.ServerRuntimeStartup)({
          awaitCommandReady: Effect.void,
          markHttpListening: Effect.void,
          enqueueCommand: (effect) => effect,
          ...options?.layers?.serverRuntimeStartup,
        }),
      ),
      Layer.provide(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          reportClientActivity: () => Effect.void,
          removeRpcClient: () => Effect.void,
          reportHostPowerState: () => Effect.void,
          snapshot: Effect.succeed({
            hostPower: {
              source: "unknown",
              idle: "unknown",
              idleSeconds: null,
              locked: "unknown",
              suspended: false,
              onBattery: "unknown",
              lowPowerMode: "unknown",
              thermalState: "unknown",
              stale: true,
              updatedAt: TEST_EPOCH,
            },
            leases: [],
            activeForegroundLeaseCount: 0,
            activeScopeKeys: [],
            shouldRunOpportunisticWork: false,
            updatedAt: TEST_EPOCH,
          }),
          streamChanges: Stream.empty,
          subscribe: Effect.succeed({
            latest: {
              hostPower: {
                source: "unknown",
                idle: "unknown",
                idleSeconds: null,
                locked: "unknown",
                suspended: false,
                onBattery: "unknown",
                lowPowerMode: "unknown",
                thermalState: "unknown",
                stale: true,
                updatedAt: TEST_EPOCH,
              },
              leases: [],
              activeForegroundLeaseCount: 0,
              activeScopeKeys: [],
              shouldRunOpportunisticWork: false,
              updatedAt: TEST_EPOCH,
            },
            changes: Stream.empty,
          }),
          hasDemand: () => Effect.succeed(false),
          shouldRunScopeWork: () => Effect.succeed(false),
          shouldRunOpportunisticWork: Effect.succeed(false),
        }),
      ),
      Layer.provide(
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(testEnvironmentDescriptor.environmentId),
          getDescriptor: Effect.succeed(testEnvironmentDescriptor),
          ...options?.layers?.serverEnvironment,
        }),
      ),
      Layer.provide(
        Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
          resolve: () => Effect.succeed(null),
          ...options?.layers?.repositoryIdentityResolver,
        }),
      ),
      Layer.provideMerge(makeAuthTestLayer()),
      Layer.provideMerge(
        options?.durableMemory
          ? EntityMemoryRepositoryLive.pipe(
              Layer.provide(MemoryRevisionWriteLockLive),
              Layer.provide(SqlitePersistenceMemory),
              Layer.tap((context) =>
                options.durableMemory?.seed
                  ? options.durableMemory.seed(Context.get(context, EntityMemoryRepository))
                  : Effect.void,
              ),
            )
          : Layer.empty,
      ),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(
        options?.layers?.channelRuntime
          ? Layer.mock(ChannelRuntime.ChannelRuntime)(options.layers.channelRuntime)
          : Layer.empty,
      ),
      Layer.provideMerge(
        options?.layers?.channelDeliveryStore === null
          ? Layer.empty
          : Layer.succeed(
              ChannelDeliveryStore.ChannelDeliveryStore,
              options?.layers?.channelDeliveryStore ??
                ChannelDeliveryStore.makeMemoryChannelDeliveryStore(),
            ),
      ),
      Layer.provide(workspaceAndProjectServicesLayer),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provide(layerConfig),
    );

    yield* Layer.build(Layer.fresh(appLayer));

    return config;
  });
