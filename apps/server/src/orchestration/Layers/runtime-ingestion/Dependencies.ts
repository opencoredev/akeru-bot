import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AgentController } from "../../../provider/Services/AgentController.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import { ProjectionThreadActivityRepository } from "../../../persistence/Services/ProjectionThreadActivities.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionThreadProposedPlanRepository } from "../../../persistence/Services/ProjectionThreadProposedPlans.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import { ThreadBackgroundLivenessService } from "../../ThreadBackgroundLiveness.ts";
import { ThreadPlanProgressService } from "../../ThreadPlanProgress.ts";
import { ProjectionSnapshotQuery } from "../../Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { ServerConfig } from "../../../config.ts";
import { BotInboxService } from "../../../bot-inbox/service.ts";
import { BotUsageLedger } from "../../../usage/BotUsageLedger.ts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";

export const createDependencies = Effect.fn("makeRuntimeDependencies")(function* () {
  const threadBackgroundLiveness = yield* ThreadBackgroundLivenessService;

  const threadPlanProgress = yield* ThreadPlanProgressService;

  const crypto = yield* Crypto.Crypto;

  const orchestrationEngine = yield* OrchestrationEngineService;

  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const agentController = yield* AgentController;

  const checkpointStore = yield* CheckpointStore.CheckpointStore;

  const projectionTurnRepository = yield* ProjectionTurnRepository;

  const projectionThreadMessages = yield* ProjectionThreadMessageRepository;

  const projectionThreadActivities = yield* ProjectionThreadActivityRepository;

  const projectionThreadProposedPlans = yield* ProjectionThreadProposedPlanRepository;

  const botUsageLedger = yield* BotUsageLedger;

  const serverSettingsService = yield* ServerSettingsService;

  const channelRuntime = Option.getOrNull(
    yield* Effect.serviceOption(ChannelRuntime.ChannelRuntime),
  );

  const serverConfig = yield* ServerConfig;

  const botInbox = BotInboxService.forSecretsDir(serverConfig.secretsDir);

  return {
    threadBackgroundLiveness,
    threadPlanProgress,
    crypto,
    orchestrationEngine,
    projectionSnapshotQuery,
    agentController,
    checkpointStore,
    projectionTurnRepository,
    projectionThreadMessages,
    projectionThreadActivities,
    projectionThreadProposedPlans,
    botUsageLedger,
    serverSettingsService,
    channelRuntime,
    serverConfig,
    botInbox,
  };
});
