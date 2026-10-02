import * as BotWorkspaceIO from "../../workspace/BotWorkspaceIO.ts";
import { createSessionResources } from "./SessionResources.ts";
import { BotInboxService } from "../../../bot-inbox/service.ts";
import { SubscriptionAuthService } from "../../../subscription-auth/service.ts";
import { createAkeruMastraAuthStorage } from "./ProviderAccess.ts";
import { BotMemoryStore } from "../../../memory/BotMemory.ts";
import { AkeruMemoryTurnHarness } from "../../AkeruMemoryTurnHarness.ts";
import { createPreviewMcpSessions } from "./PreviewMcpSessions.ts";
import type { AgentControllerLiveOptions } from "./Options.ts";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import {
  ProviderDriverKind,
  TurnId,
  type BotId,
  type AkeruCreateRoutineInput,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { ServerConfig } from "../../../config.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProjectionThreadMessageRepository } from "../../../persistence/Services/ProjectionThreadMessages.ts";
import { ProjectionTurnRepository } from "../../../persistence/Services/ProjectionTurns.ts";
import * as McpSessionRegistry from "../../../mcp/McpSessionRegistry.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { BotUsageLedger } from "../../../usage/BotUsageLedger.ts";
import type { ProviderInstanceRoutingInfo } from "../../Services/ProviderAdapterRegistry.ts";
import { type AkeruChannelRuntime } from "../../AkeruChannelRuntime.ts";
import { type AkeruBotStateRuntime } from "../../AkeruBotStateRuntime.ts";
import { type AkeruDelegationChildOutcome } from "../../AkeruDelegationRuntime.ts";
import * as AkeruRuntimeSeam from "../../AkeruRuntimeSeam.ts";
import * as PendingWaiters from "../../PendingWaiters.ts";
import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../../AkeruCatalogToolHandlers.ts";
import { createAkeruWebFetch } from "../../AkeruWebFetch.ts";
import { LegacyProviderBridge } from "../../Services/LegacyProviderBridge.ts";
import { RoutineDraftDispatcher } from "../../../routines/RoutineDraftDispatcher.ts";
import { MemoryApprovals } from "../../../memory/MemoryApprovals.ts";
import { type ResolvedEngine, type ActiveSession, type WorkerOrchestration } from "./State.ts";

export const createControllerState = Effect.fn("createControllerState")(function* (
  options?: AgentControllerLiveOptions,
) {
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const legacyProviderBridge = yield* LegacyProviderBridge;
  const botUsageLedger = yield* BotUsageLedger;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const mcpSessionRegistry = yield* Effect.serviceOption(McpSessionRegistry.McpSessionRegistry);
  // Promise-based callers re-enter Effect only through this seam; its fibers
  // are interrupted when the layer scope closes.
  const { runPromise, fork, forkPromise } = yield* AkeruRuntimeSeam.makeAkeruRuntimeSeam;
  const routineDraftDispatcher = yield* Effect.serviceOption(RoutineDraftDispatcher);
  const memoryApprovals = yield* Effect.serviceOption(MemoryApprovals);
  const routineDispatcher = Option.getOrUndefined(routineDraftDispatcher);
  const mutationLock = yield* Semaphore.make(1);
  const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const orchestrationEngine = yield* Effect.serviceOption(OrchestrationEngineService);
  const projectionSnapshotQuery = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const projectionMessages = yield* Effect.serviceOption(ProjectionThreadMessageRepository);
  const projectionTurns = yield* Effect.serviceOption(ProjectionTurnRepository);
  const resolvedByThread = new Map<string, ResolvedEngine>();
  const webFetch = createAkeruWebFetch(options?.webFetch);

  const modelConnections = new Map<
    string,
    NonNullable<ProviderInstanceRoutingInfo["mastraConnection"]>
  >();

  const sessions = new Map<string, ActiveSession>();

  // Tool calls consume no model tokens, so their entries hold no cap while they run.
  // `persisted` is false when the start write failed; finish then writes the whole entry.
  const toolUsageStarts = new Map<
    string,
    {
      persisted: boolean;
      readonly turnId: TurnId | null;
      readonly provider: ProviderDriverKind | null;
      readonly model: string | null;
    }
  >();

  // Providers only promise tool-call ids unique within a chat.
  const toolUsageKey = (input: { readonly threadId: string; readonly toolCallId: string }) =>
    `tool:${input.threadId}:${input.toolCallId}`;

  const legacyHiddenWakeByTurn = new Map<string, boolean>();

  // Memory calls with no live turn reservation, recorded when they finish.
  const unreservedMemoryCalls = new Map<
    string,
    {
      readonly botId: BotId;
      readonly threadId: ThreadId;
      readonly category: "observer" | "reflector";
      readonly provider: ProviderDriverKind | null;
      readonly model: string | null;
    }
  >();

  const memoryUsageByThread = new Map<
    string,
    { readonly botId: BotId; readonly capLimit: number; turnId: TurnId }
  >();

  const { clearPreviewMcpSession, preparePreviewMcpSession } = createPreviewMcpSessions({
    options,
    mcpSessionRegistry,
    serverSettings,
  });

  /**
   * Orchestration-backed runtimes. The orchestration layer is built after this
   * controller, so it hands them over through configurePluginRuntime and
   * configureDelegation.
   */
  const lateWiring = yield* Ref.make<{
    readonly channelRuntime?: AkeruChannelRuntime;
    readonly pluginRuntime?: ReturnType<typeof createAkeruPluginRuntime>;
    readonly pluginRuntimeOptions?: AkeruPluginRuntimeOptions;
    readonly botStateRuntime?: AkeruBotStateRuntime;
    readonly delegationRuntime?: AgentControllerLiveOptions["delegationRuntime"];
    readonly workerOrchestration?: WorkerOrchestration;
  }>({ delegationRuntime: options?.delegationRuntime });

  const wired = () => Ref.getUnsafe(lateWiring);

  const childWaiters = yield* PendingWaiters.makePendingWaiters<null, AkeruDelegationChildOutcome>(
    "The agent controller stopped.",
  );

  const resolveChildWaiter = (threadId: ThreadId, outcome: AkeruDelegationChildOutcome) => {
    childWaiters.resolve(String(threadId), outcome);
  };

  const pendingRoutineRequests = yield* PendingWaiters.makePendingWaiters<
    {
      readonly threadId: string;
      readonly input: AkeruCreateRoutineInput;
      readonly timezone: string;
    },
    unknown,
    Error
  >("The agent controller stopped before the routine review finished.");

  // Accepted routine reviews whose routine is still being created, by tool call.
  const creatingRoutineReviews = new Map<string, string>();

  yield* fileSystem
    .makeDirectory(config.stateDir, { recursive: true, mode: 0o700 })
    .pipe(Effect.orDie);

  const authStorage = yield* createAkeruMastraAuthStorage(config.secretsDir);
  const subscriptionAuth = yield* SubscriptionAuthService.forSecretsDir(config.secretsDir);
  const botInbox = BotInboxService.forSecretsDir(config.secretsDir);

  const { sessionResources } = createSessionResources({
    io: BotWorkspaceIO.makeBotWorkspaceIO(fileSystem, path, runPromise),
    get config() {
      return config;
    },
    get hostPlatform() {
      return hostPlatform;
    },
    get subscriptionAuth() {
      return subscriptionAuth;
    },
    get botInbox() {
      return botInbox;
    },
    get options() {
      return options;
    },
  });

  const botMemoryStore = options?.botMemoryStore ?? new BotMemoryStore(config.stateDir);
  const memoryTurnHarness = new AkeruMemoryTurnHarness(botMemoryStore);

  return {
    sessionResources,
    authStorage,
    subscriptionAuth,
    botInbox,
    botMemoryStore,
    memoryTurnHarness,
    config,
    fileSystem,
    path,
    hostPlatform,
    legacyProviderBridge,
    botUsageLedger,
    serverSettings,
    mcpSessionRegistry,
    routineDraftDispatcher,
    memoryApprovals,
    routineDispatcher,
    mutationLock,
    runtimeEvents,
    orchestrationEngine,
    projectionSnapshotQuery,
    projectionMessages,
    projectionTurns,
    resolvedByThread,
    webFetch,
    modelConnections,
    sessions,
    toolUsageStarts,
    toolUsageKey,
    legacyHiddenWakeByTurn,
    unreservedMemoryCalls,
    memoryUsageByThread,
    lateWiring,
    wired,
    childWaiters,
    resolveChildWaiter,
    pendingRoutineRequests,
    clearPreviewMcpSession,
    preparePreviewMcpSession,
    creatingRoutineReviews,
    runPromise,
    fork,
    forkPromise,
  };
});
