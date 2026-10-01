import * as Layer from "effect/Layer";
import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import { ChannelRuntime } from "./channels/ChannelRuntime.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import { ProviderSessionDirectoryLive } from "./provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionRuntime from "./persistence/ProviderSessionRuntime.ts";
import { ProviderAdapterRegistryLive } from "./provider/Layers/ProviderAdapterRegistry.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ProviderEventLoggers from "./provider/Layers/ProviderEventLoggers.ts";
import { AgentControllerLive } from "./provider/Layers/AgentController.ts";
import { LegacyProviderBridgeLive } from "./provider/Layers/LegacyProviderBridge.ts";
import { ProviderServiceLive } from "./provider/Layers/ProviderService.ts";
import { ProviderSessionReaperLive } from "./provider/Layers/ProviderSessionReaper.ts";
import * as OpenCodeRuntime from "./provider/opencodeRuntime.ts";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as ProviderUsageHistory from "./usage/ProviderUsageHistory.ts";
import { ProviderInstanceRegistryHydrationLive } from "./provider/Layers/ProviderInstanceRegistryHydration.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as Keybindings from "./keybindings.ts";
import { OrchestrationReactorLive } from "./orchestration/Layers/OrchestrationReactor.ts";
import { RuntimeReceiptBusLive } from "./orchestration/Layers/RuntimeReceiptBus.ts";
import { ProviderRuntimeIngestionLive } from "./orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ProviderCommandReactorLive } from "./orchestration/Layers/ProviderCommandReactor.ts";
import { CheckpointReactorLive } from "./orchestration/Layers/CheckpointReactor.ts";
import { ThreadDeletionReactorLive } from "./orchestration/Layers/ThreadDeletionReactor.ts";
import { ProviderRegistryLive } from "./provider/Layers/ProviderRegistry.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import { ObservabilityLive } from "./observability/Layers/Observability.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as RemoteOpenTargets from "./environment/RemoteOpenTargets.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as Composio from "./composio/ComposioService.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageService from "./usage/UsageService.ts";
import { EntityMemoryRepositoryLive } from "./memory/Layers/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "./memory/Services/MemoryRevisionWriteLock.ts";
import { OrchestrationLayerLive } from "./orchestration/runtimeLayer.ts";
import * as NetService from "@akeru/shared/Net";
import { RoutineLayerLive } from "./routines/layer.ts";
import * as ImageGenerationRuntime from "./image-generation/ImageGenerationRuntime.ts";
import { RoutineDraftDispatcherLive } from "./routines/RoutineDraftDispatcher.ts";
import { MemoryApprovalsLive } from "./memory/MemoryApprovals.ts";

export const ResourceAttributionLayerLive = ResourceAttribution.layer;

export const ApplicationObservabilityLive = ObservabilityLive.pipe(
  Layer.provideMerge(ResourceAttributionLayerLive),
);

export const ServerSettingsLayerLive = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

export const AnalyticsLayerLive = AnalyticsService.layer.pipe(
  Layer.provide(ServerSettingsLayerLive),
  Layer.provide(SqlitePersistenceLayerLive),
);

export const NativeTelemetryLayerLive = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);

export const DesktopTelemetryReceiverLayerLive = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(ServerSettingsLayerLive),
);

export const ResourceTelemetryLayerLive = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(NativeTelemetryLayerLive),
  Layer.provideMerge(DesktopTelemetryReceiverLayerLive),
);

export const HostPowerMonitorLayerLive = HostPowerMonitor.layer.pipe(
  Layer.provide(DesktopTelemetryReceiverLayerLive),
);

export const BackgroundLayerLive = BackgroundPolicy.layer.pipe(
  Layer.provide(HostPowerMonitorLayerLive),
  Layer.provideMerge(ServerSettingsLayerLive),
);

export const ProviderUsageHistoryLayerLive = ProviderUsageHistory.layer.pipe(
  Layer.provide(SqlitePersistenceLayerLive),
);

export const UsageLayerLive = UsageService.layer.pipe(Layer.provide(ProviderUsageHistoryLayerLive));

export const ResourceDiagnosticsLayerLive = Layer.mergeAll(
  ResourceTelemetryLayerLive,
  ProcessDiagnostics.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(ResourceTelemetryLayerLive)),
);

export const ReactorLayerLive = Layer.empty.pipe(
  Layer.provideMerge(OrchestrationReactorLive),
  Layer.provideMerge(ProviderRuntimeIngestionLive),
  Layer.provideMerge(ProviderCommandReactorLive),
  Layer.provideMerge(CheckpointReactorLive),
  Layer.provideMerge(ThreadDeletionReactorLive),
  Layer.provideMerge(RuntimeReceiptBusLive),
  // Channel transports live in this runtime's scope. Ingestion, startup, commands,
  // and the webhook route all resolve the same instance.
  Layer.provideMerge(ChannelRuntime.layer),
);

export const ProviderSessionDirectoryLayerLive = ProviderSessionDirectoryLive.pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);

// `ProviderAdapterRegistryLive` is now a facade that resolves kind → adapter
// by looking up the default `ProviderInstance` per driver in the instance
// registry. Adapter construction itself moved inside each driver's
// `create()`; `ProviderEventLoggers.layer` owns the shared native/canonical
// NDJSON writers and is provided at the outer runtime layer so both
// `ProviderService` and the per-instance drivers read the same logger pair.
export const ProviderServiceLayerLive = ProviderServiceLive.pipe(
  Layer.provide(ProviderAdapterRegistryLive),
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
);

export const LegacyProviderLayerLive = LegacyProviderBridgeLive.pipe(
  Layer.provide(ProviderServiceLayerLive),
);

export const PersistenceLayerLive = Layer.empty.pipe(
  Layer.provideMerge(SqlitePersistenceLayerLive),
);

export const McpSessionRegistryLayerLive = McpSessionRegistry.layer;

export const RuntimeMemoryRepositoriesLive = EntityMemoryRepositoryLive.pipe(
  Layer.provide(MemoryRevisionWriteLockLive),
);

export const RuntimeMemoryRepositoriesWithPersistenceLive = RuntimeMemoryRepositoriesLive.pipe(
  Layer.provideMerge(PersistenceLayerLive),
);

export const MemoryApprovalsLayerLive = MemoryApprovalsLive.pipe(
  Layer.provide(OrchestrationLayerLive),
  Layer.provide(RuntimeMemoryRepositoriesWithPersistenceLive),
);

export const ProviderLayerLive = AgentControllerLive.pipe(
  Layer.provide(LegacyProviderLayerLive),
  Layer.provide(RuntimeMemoryRepositoriesWithPersistenceLive),
  Layer.provide(MemoryApprovalsLayerLive),
  Layer.provide(RoutineDraftDispatcherLive.pipe(Layer.provide(OrchestrationLayerLive))),
);

export const VcsDriverRegistryLayerLive = VcsDriverRegistry.layer.pipe(
  Layer.provide(VcsProjectConfig.layer),
);

export const GitLayerLive = Layer.empty.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(TextGeneration.layer),
);

export const GitWorkflowLayerLive = GitWorkflowService.layer.pipe(
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitLayerLive),
);

export const VcsLayerLive = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(VcsDriverRegistryLayerLive),
  Layer.provideMerge(GitWorkflowLayerLive),
);

export const CheckpointingLayerLive = Layer.empty.pipe(
  Layer.provideMerge(CheckpointDiffQuery.layer),
  Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistryLayerLive))),
);

export const PortScannerLayerLive = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

export const PreviewLayerLive = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(PortScannerLayerLive),
);

export const WorkspaceEntriesLayerLive = WorkspaceEntries.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
);

export const WorkspaceFileSystemLayerLive = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(WorkspaceEntriesLayerLive),
);

export const WorkspaceLayerLive = Layer.mergeAll(
  WorkspacePaths.layer,
  WorkspaceEntriesLayerLive,
  WorkspaceFileSystemLayerLive,
);

export const ServerEnvironmentLayerLive = ServerEnvironment.layer;

export const AuthLayerLive = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(PersistenceLayerLive),
  Layer.provide(ServerEnvironmentLayerLive),
  Layer.provide(ServerSecretStore.layer),
);

export const ProviderRuntimeLayerLive = ProviderSessionReaperLive.pipe(
  Layer.provideMerge(ProviderSessionDirectoryLayerLive),
  Layer.provideMerge(ProviderLayerLive),
  Layer.provideMerge(MemoryApprovalsLayerLive),
  Layer.provideMerge(OrchestrationLayerLive),
);

export const RuntimeCoreDependenciesLive = ReactorLayerLive.pipe(
  // Core Services
  Layer.provideMerge(McpSessionRegistryLayerLive),
  Layer.provideMerge(ServerSettingsLayerLive),
  Layer.provideMerge(CheckpointingLayerLive),
  Layer.provideMerge(GitLayerLive),
  Layer.provideMerge(VcsLayerLive),
  Layer.provideMerge(ProviderRuntimeLayerLive),
  Layer.provideMerge(PreviewLayerLive),
  Layer.provideMerge(RuntimeMemoryRepositoriesWithPersistenceLive),
  Layer.provideMerge(Keybindings.layer),
  Layer.provideMerge(ProviderRegistryLive),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // `providerInstances` hydration merges `settings.providers.<kind>`
  // with explicit `providerInstances` entries on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
  // Shared native/canonical NDJSON writers used by both the per-instance
  // drivers (native stream, written from inside each `<X>Adapter`) and
  // `ProviderService` (canonical stream, written after event normalization).
  // Provided once at the runtime level so every consumer sees the same
  // logger instances.
  // `ModelManifest.layer` is the legacy-model classification data, refreshed
  // from the repo's `model-manifest.json` on `main` and applied by the
  // Codex/Claude drivers.
  Layer.provideMerge(Layer.mergeAll(ProviderEventLoggers.layer, ModelManifest.layer)),
  // `OpenCodeDriver.create()` yields `OpenCodeRuntime`; previously the old
  // `ProviderRegistryLive` pulled `OpenCodeRuntimeLive` in for itself, but
  // the rewritten registry reads snapshots off the instance registry and
  // no longer transitively provides it. Exposing it at the runtime level
  // keeps a single Live for all opencode consumers.
  Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
  Layer.provideMerge(WorkspaceLayerLive),
  Layer.provideMerge(RepositoryIdentityResolver.layer),
  Layer.provideMerge(ServerEnvironmentLayerLive),
  Layer.provideMerge(AuthLayerLive),
  Layer.provideMerge(
    Layer.mergeAll(
      ServerSecretStore.layer,
      Composio.layer.pipe(Layer.provide(ServerSecretStore.layer)),
    ),
  ),
);

export const RuntimeCoreWithRoutinesLive = Layer.mergeAll(
  RuntimeCoreDependenciesLive,
  RoutineLayerLive.pipe(Layer.provide(RuntimeCoreDependenciesLive)),
  ImageGenerationRuntime.layer.pipe(Layer.provide(RuntimeCoreDependenciesLive)),
);

export const RuntimeDependenciesLive = RuntimeCoreWithRoutinesLive.pipe(
  // Misc.
  Layer.provideMerge(BackgroundLayerLive),
  Layer.provideMerge(ResourceDiagnosticsLayerLive),
  Layer.provideMerge(UsageLayerLive),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(AnalyticsLayerLive),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(RemoteOpenTargets.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);
