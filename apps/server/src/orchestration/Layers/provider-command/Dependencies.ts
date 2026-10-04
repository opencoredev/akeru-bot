import { CommandId, EventId, type ModelSelection, type McpServer } from "@akeru/contracts";
import * as Cache from "effect/Cache";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import { TextGeneration } from "../../../textGeneration/TextGeneration.ts";
import { BotUsageLedger } from "../../../usage/BotUsageLedger.ts";
import { AgentController } from "../../../provider/Services/AgentController.ts";
import { ProviderSessionDirectory } from "../../../provider/Services/ProviderSessionDirectory.ts";
import { ProviderRegistry } from "../../../provider/Services/ProviderRegistry.ts";
import { ProjectionBotRepository } from "../../../persistence/Services/ProjectionBots.ts";
import { ProjectionMcpServerRepository } from "../../../persistence/Services/ProjectionMcpServers.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { GitWorkflowService } from "../../../git/GitWorkflowService.ts";
import { ComposioService } from "../../../composio/ComposioService.ts";
import { HANDLED_TURN_REQUEST_KEY_MAX, HANDLED_TURN_REQUEST_KEY_TTL } from "./Fields.ts";

export const createDependencies = Effect.fn("makeprovider-command-Dependencies")(function* () {
  const crypto = yield* Crypto.Crypto;

  const orchestrationEngine = yield* OrchestrationEngineService;

  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

  const projectionBotRepository = yield* ProjectionBotRepository;

  const projectionMcpServerRepository = yield* ProjectionMcpServerRepository;

  const agentController = yield* AgentController;

  const providerSessionDirectory = yield* Effect.serviceOption(ProviderSessionDirectory);

  const providerRegistry = yield* ProviderRegistry;

  const gitWorkflow = yield* GitWorkflowService;

  const fileSystem = yield* FileSystem.FileSystem;

  const textGeneration = yield* TextGeneration;

  const serverSettingsService = yield* ServerSettingsService;

  const botUsageLedger = yield* BotUsageLedger;

  const composio = yield* Effect.serviceOption(ComposioService);

  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

  if (agentController.configurePluginRuntime) {
    yield* agentController.configurePluginRuntime({
      readSnapshot: () => runPromise(projectionSnapshotQuery.getCommandReadModel()),
      dispatch: (command) => runPromise(orchestrationEngine.dispatch(command)),
      ...(Option.isSome(composio)
        ? {
            searchComposioToolkits: async (input: {
              readonly query?: string;
              readonly limit?: number;
            }) => {
              const status = await runPromise(composio.value.getStatus);

              if (!status.configured) {
                return { status: "setup-required" as const, toolkits: [] };
              }

              return {
                status: "available" as const,
                toolkits: await runPromise(composio.value.searchToolkits(input)),
              };
            },
          }
        : {}),
    });
  }

  if (agentController.configureDelegation) {
    yield* agentController.configureDelegation({
      readSnapshot: () => runPromise(projectionSnapshotQuery.getCommandReadModel()),
      readThread: (threadId) =>
        runPromise(
          projectionSnapshotQuery
            .getThreadDetailById(threadId, { activityKinds: [] })
            .pipe(Effect.map(Option.getOrUndefined)),
        ),
      dispatch: (command) => runPromise(orchestrationEngine.dispatch(command)),
    });
  }

  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));

  const serverEventId = () => crypto.randomUUIDv4.pipe(Effect.map(EventId.make));

  const handledTurnRequestKeys = yield* Cache.make<string, true>({
    capacity: HANDLED_TURN_REQUEST_KEY_MAX,
    timeToLive: HANDLED_TURN_REQUEST_KEY_TTL,
    lookup: () => Effect.succeed(true),
  });

  const hasHandledTurnRequestRecently = (key: string) =>
    Cache.getOption(handledTurnRequestKeys, key).pipe(
      Effect.flatMap((cached) =>
        Cache.set(handledTurnRequestKeys, key, true).pipe(Effect.as(Option.isSome(cached))),
      ),
    );

  const threadModelSelections = new Map<string, ModelSelection>();

  const threadBotWorkspaceKeys = new Map<string, string>();

  const threadMcpServers = new Map<string, readonly McpServer[]>();

  const threadsAwaitingRestrictiveSessionCleanup = new Set<string>();

  return {
    crypto,
    orchestrationEngine,
    projectionSnapshotQuery,
    projectionBotRepository,
    projectionMcpServerRepository,
    agentController,
    providerSessionDirectory,
    providerRegistry,
    gitWorkflow,
    fileSystem,
    textGeneration,
    serverSettingsService,
    botUsageLedger,
    composio,
    runPromise,
    serverCommandId,
    serverEventId,
    handledTurnRequestKeys,
    hasHandledTurnRequestRecently,
    threadModelSelections,
    threadBotWorkspaceKeys,
    threadMcpServers,
    threadsAwaitingRestrictiveSessionCleanup,
  };
});
