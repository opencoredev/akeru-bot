import * as Schema from "effect/Schema";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderDriverKind } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as CheckpointStore from "../../src/checkpointing/CheckpointStore.ts";
import { TextGeneration } from "../../src/textGeneration/TextGeneration.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionBotRepositoryLive } from "../../src/persistence/Layers/ProjectionBots.ts";
import { ProjectionThreadMessageRepositoryLive } from "../../src/persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../src/persistence/Layers/ProjectionTurns.ts";
import { ProjectionCheckpointRepositoryLive } from "../../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../src/persistence/Layers/ProviderSessionRuntime.ts";
import { sqlitePersistenceLayer } from "../../src/persistence/Layers/Sqlite.ts";
import { adapterRegistryMock } from "../../src/provider/testUtils/providerAdapterRegistryMock.ts";
import { ProviderAdapterRegistry } from "../../src/provider/Services/ProviderAdapterRegistry.ts";
import { makeProviderRegistryLayer } from "../../src/provider/testUtils/providerRegistryMock.ts";
import { ProviderSessionDirectoryLive } from "../../src/provider/Layers/ProviderSessionDirectory.ts";
import { ServerSettingsService } from "../../src/serverSettings.ts";
import { agentControllerLayerWith } from "../../src/provider/Layers/AgentController.ts";
import { EntityMemoryRepository } from "../../src/memory/Services/EntityMemoryRepository.ts";
import { type TestMastraHarness } from "../TestMastraHarness.integration.ts";
import { EntityMemoryRepositoryLive } from "../../src/memory/Layers/EntityMemoryRepository.ts";
import { MemoryRevisionWriteLockLive } from "../../src/memory/Services/MemoryRevisionWriteLock.ts";
import { LegacyProviderBridgeLive } from "../../src/provider/Layers/LegacyProviderBridge.ts";
import { ProviderServiceLive } from "../../src/provider/Layers/ProviderService.ts";
import { makeCodexAdapter } from "../../src/provider/Layers/CodexAdapter.ts";
import {
  NoOpProviderEventLoggers,
  ProviderEventLoggers,
} from "../../src/provider/Layers/ProviderEventLoggers.ts";
import { AnalyticsService } from "../../src/telemetry/Services/AnalyticsService.ts";
import { CheckpointReactorLive } from "../../src/orchestration/Layers/CheckpointReactor.ts";
import * as RepositoryIdentityResolver from "../../src/project/RepositoryIdentityResolver.ts";
import { OrchestrationEngineLive } from "../../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../src/orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../src/orchestration/ThreadPlanProgress.ts";
import { RuntimeReceiptBusTest } from "../../src/orchestration/Layers/RuntimeReceiptBus.ts";
import { OrchestrationReactorLive } from "../../src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import { ThreadDeletionReactor } from "../../src/orchestration/Services/ThreadDeletionReactor.ts";
import { type TestProviderAdapterHarness } from "../TestProviderAdapter.integration.ts";
import { ServerConfig } from "../../src/config.ts";
import * as WorkspaceEntries from "../../src/workspace/WorkspaceEntries.ts";
import * as WorkspacePaths from "../../src/workspace/WorkspacePaths.ts";
import * as VcsDriverRegistry from "../../src/vcs/VcsDriverRegistry.ts";
import * as GitVcsDriver from "../../src/vcs/GitVcsDriver.ts";
import { GitWorkflowService } from "../../src/git/GitWorkflowService.ts";
import * as VcsProcess from "../../src/vcs/VcsProcess.ts";
import { BotUsageLedgerLive } from "../../src/usage/BotUsageLedger.ts";

const decodeCodexSettings = Schema.decodeEffect(CodexSettings);

export function createIntegrationLayers({
  adapterHarness,
  mastraHarness,
  useRealCodex,
  dbPath,
  rootDir,
  workspaceDir,
}: {
  adapterHarness: TestProviderAdapterHarness | null;
  mastraHarness: TestMastraHarness | null;
  useRealCodex: boolean;
  dbPath: string;
  rootDir: string;
  workspaceDir: string;
}) {
  const fakeRegistry = adapterHarness
    ? Layer.succeed(
        ProviderAdapterRegistry,
        adapterRegistryMock({ [adapterHarness.provider]: adapterHarness.adapter }),
      )
    : null;

  const persistenceLayer = sqlitePersistenceLayer(dbPath);

  const memoryRepositoriesLayer = EntityMemoryRepositoryLive.pipe(
    Layer.provide(MemoryRevisionWriteLockLive),
    Layer.provide(persistenceLayer),
  );

  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );

  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );

  const realCodexRegistry = Layer.effect(
    ProviderAdapterRegistry,
    Effect.gen(function* () {
      const codexSettings = yield* decodeCodexSettings({});
      const codexAdapter = yield* makeCodexAdapter(codexSettings);

      return adapterRegistryMock({
        [ProviderDriverKind.make("codex")]: codexAdapter,
      });
    }),
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(providerSessionDirectoryLayer),
  );

  const providerEventLoggersLayer = Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers);

  const providerLayer = useRealCodex
    ? ProviderServiceLive.pipe(
        Layer.provide(providerSessionDirectoryLayer),
        Layer.provide(realCodexRegistry),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(providerEventLoggersLayer),
      )
    : ProviderServiceLive.pipe(
        Layer.provide(providerSessionDirectoryLayer),
        Layer.provide(fakeRegistry!),
        Layer.provide(AnalyticsService.layerTest),
        Layer.provide(providerEventLoggersLayer),
      );

  const legacyProviderLayer = LegacyProviderBridgeLive.pipe(Layer.provide(providerLayer));

  const agentControllerLayer = Layer.unwrap(
    Effect.map(Effect.service(EntityMemoryRepository), (entityMemoryRepository) =>
      agentControllerLayerWith({
        entityMemoryRepository,
        ...(mastraHarness ? { makeMastraHarness: mastraHarness.factory } : {}),
      }),
    ),
  ).pipe(
    Layer.provide(memoryRepositoriesLayer),
    Layer.provide(legacyProviderLayer),
    Layer.provide(BotUsageLedgerLive),
    Layer.provide(ProjectionThreadMessageRepositoryLive),
    Layer.provide(ProjectionTurnRepositoryLive),
  );

  const providerRegistryLayer = makeProviderRegistryLayer();

  const checkpointStoreLayer = CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer));

  const projectionSnapshotQueryLayer = OrchestrationProjectionSnapshotQueryLive;

  const runtimeServicesLayer = Layer.mergeAll(
    projectionSnapshotQueryLayer,
    orchestrationLayer.pipe(Layer.provide(projectionSnapshotQueryLayer)),
    ProjectionBotRepositoryLive,
    ProjectionCheckpointRepositoryLive,
    ProjectionPendingApprovalRepositoryLive,
    BotUsageLedgerLive,
    checkpointStoreLayer,
    agentControllerLayer,
    RuntimeReceiptBusTest,
  ).pipe(
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
  );

  const serverSettingsLayer = ServerSettingsService.layerTest();

  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(serverSettingsLayer),
  );

  const gitWorkflowLayer = Layer.mock(GitWorkflowService)({
    renameBranch: (input: {
      readonly cwd: string;
      readonly oldBranch: string;
      readonly newBranch: string;
    }) => Effect.succeed({ branch: input.newBranch }),
  });

  const textGenerationLayer = Layer.mock(TextGeneration)({
    generateBranchName: () => Effect.succeed({ branch: "update" }),
    generateThreadTitle: () => Effect.succeed({ title: "New thread" }),
  });

  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(gitWorkflowLayer),
    Layer.provideMerge(textGenerationLayer),
    Layer.provideMerge(serverSettingsLayer),
  );

  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(
      Layer.mock(GitVcsDriver.GitVcsDriver)({
        statusDetailsLocal: () =>
          Effect.succeed({
            isRepo: true,
            hasOriginRemote: false,
            isDefaultBranch: true,
            branch: "main",
            upstreamRef: null,
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
            hasUpstream: false,
            aheadCount: 0,
            behindCount: 0,
            aheadOfDefaultCount: 0,
          }),
      }),
    ),
    Layer.provideMerge(
      WorkspaceEntries.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provideMerge(VcsDriverRegistry.layer),
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(VcsProcess.layer),
  );

  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
    Layer.provideMerge(
      Layer.succeed(ThreadDeletionReactor, {
        start: () => Effect.void,
        drain: Effect.void,
        drainThrough: () => Effect.void,
      }),
    ),
  );

  const layer = Layer.empty.pipe(
    Layer.provideMerge(runtimeServicesLayer),
    Layer.provideMerge(orchestrationReactorLayer),
    Layer.provideMerge(providerRegistryLayer),
    Layer.provide(persistenceLayer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(workspaceDir, rootDir)),
    Layer.provideMerge(NodeServices.layer),
  );

  return layer;
}
