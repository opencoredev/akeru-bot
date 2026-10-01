import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as ThreadBackgroundLiveness from "../../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../ThreadPlanProgress.ts";
import { OrchestrationEngineLive } from "../OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../ProjectionSnapshotQuery.ts";

export const TestLayer = OrchestrationEngineLive.pipe(
  Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provideMerge(OrchestrationProjectionPipelineLive),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), {
      prefix: "t3-bot-persistence-test-",
    }),
  ),
  Layer.provideMerge(NodeServices.layer),
);
