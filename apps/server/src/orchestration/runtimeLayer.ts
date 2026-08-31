import * as Layer from "effect/Layer";

import { ChannelDeliveryStoreLive } from "../channels/ChannelDeliveryStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionBotRepositoryLive } from "../persistence/Layers/ProjectionBots.ts";
import { ProjectionGroupRepositoryLive } from "../persistence/Layers/ProjectionGroups.ts";
import { OrchestrationEngineLive } from "./Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "./ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "./ThreadPlanProgress.ts";

export const OrchestrationEventInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationEventStoreLive,
  OrchestrationCommandReceiptRepositoryLive,
);

export const OrchestrationProjectionPipelineLayerLive = OrchestrationProjectionPipelineLive.pipe(
  Layer.provide(OrchestrationEventStoreLive),
);

export const OrchestrationInfrastructureLayerLive = Layer.mergeAll(
  OrchestrationProjectionSnapshotQueryLive,
  OrchestrationEventInfrastructureLayerLive,
  OrchestrationProjectionPipelineLayerLive,
  ProjectionBotRepositoryLive,
  ProjectionGroupRepositoryLive,
  ChannelDeliveryStoreLive,
  // Shared background-liveness and plan-progress registries: written by
  // runtime ingestion, read by the snapshot query. provideMerge feeds the
  // same instance to the snapshot query here and re-exports it for runtime
  // ingestion.
).pipe(
  Layer.provideMerge(ThreadBackgroundLiveness.layer),
  Layer.provideMerge(ThreadPlanProgress.layer),
);

export const OrchestrationLayerLive = Layer.mergeAll(
  OrchestrationInfrastructureLayerLive,
  OrchestrationEngineLive.pipe(Layer.provide(OrchestrationInfrastructureLayerLive)),
);
