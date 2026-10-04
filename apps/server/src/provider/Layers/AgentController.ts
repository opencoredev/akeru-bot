import { createControllerState } from "./agentController/ControllerState.ts";
import { createAuxiliaryOperations } from "./agentController/AuxiliaryOperations.ts";
import { createToolRuntime } from "./agentController/ToolRuntime.ts";
import { createHarness } from "./agentController/Harness.ts";
import { createWorkers } from "./agentController/Workers.ts";
import {
  DEFAULT_MODE_ID,
  omitNullToolFields,
  mastraModelOptions,
  failureDetail,
  sessionFailureDetail,
  deleteCatalogMcpServer,
  messageText,
  permissionPolicy,
  mcpToolNeedsApproval,
  approvalDetail,
  usesMastraCode,
  disabledProviderError,
  itemType,
  ThreadIdBrand,
  approvalDecision,
  toProviderSession,
} from "./agentController/Policy.ts";

export { usesMastraCode } from "./agentController/Policy.ts";

import type { AgentControllerLiveOptions } from "./agentController/Options.ts";

export type { AgentControllerLiveOptions } from "./agentController/Options.ts";

import { createMemoryAccess } from "./agentController/MemoryAccess.ts";
import { createMemoryCadence } from "./agentController/MemoryCadence.ts";
import { createDelegation } from "./agentController/Delegation.ts";
import { createEvents } from "./agentController/Events.ts";
import { createTurnLifecycle } from "./agentController/TurnLifecycle.ts";
import { createEngineRouting } from "./agentController/EngineRouting.ts";
import { createSessionLifecycle } from "./agentController/SessionLifecycle.ts";
import { createTurnRequests } from "./agentController/TurnRequests.ts";
import { createApprovals } from "./agentController/Approvals.ts";
import { createConversation } from "./agentController/Conversation.ts";

import { createMcpManager } from "@mastra/code-sdk/mcp/index";

import { TurnId, type ProviderRuntimeEvent, type RuntimeMode, ThreadId } from "@akeru/contracts";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Ref from "effect/Ref";

import { type BotMemoryAccess } from "../../memory/BotMemory.ts";

import { EntityMemoryRepository } from "../../memory/Services/EntityMemoryRepository.ts";

import { ProjectionThreadMessageRepositoryLive } from "../../persistence/Layers/ProjectionThreadMessages.ts";
import { ProjectionTurnRepositoryLive } from "../../persistence/Layers/ProjectionTurns.ts";

import * as McpMemoryToolSession from "../../mcp/McpMemoryToolSession.ts";

import { createAkeruChannelRuntime } from "../AkeruChannelRuntime.ts";
import { createAkeruBotStateRuntime } from "../AkeruBotStateRuntime.ts";
import { type AkeruMemoryTurn } from "../AkeruMemoryTurnHarness.ts";

import {
  createAkeruPluginRuntime,
  type AkeruPluginRuntimeOptions,
} from "../AkeruCatalogToolHandlers.ts";

import { authenticateMcpServer } from "../McpServerAuthentication.ts";

import { AgentControllerRuntimeError } from "../Errors.ts";
import { AgentController } from "../Services/AgentController.ts";

import {
  type PendingTurn,
  type ActiveSession,
  type LegacyTurnMemoryState,
  type LegacyResourceIdentity,
  type WorkerOrchestration,
} from "./agentController/State.ts";

import { toMcpServerConfigs } from "./agentController/McpConfiguration.ts";

const DEFAULT_MEMORY_TOOL_SETTINGS = {
  enabled: true,
  privateBotMemory: true,
  sharedProjectMemory: "ask",
} as const;

const APPROVAL_FREE_MASTRA_TOOL_NAMES: ReadonlySet<string> = new Set(["ask_user"]);

const make = (options?: AgentControllerLiveOptions) =>
  Effect.gen(function* () {
    const {
      config,
      fileSystem,
      path,
      legacyProviderBridge,
      botUsageLedger,
      serverSettings,
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
      sessionResources,
      authStorage,
      subscriptionAuth,
      botInbox,
      botMemoryStore,
      memoryTurnHarness,
      creatingRoutineReviews,
      runPromise,
      fork,
      forkPromise,
    } = yield* createControllerState(options);

    // A turn waits on the user while any tool approval, question, or routine review
    // it opened is unanswered, or an accepted routine is still being created.
    const {
      turnStillWaiting,
      cancelPendingApproval,
      cancelAllPendingApprovals,
      failActiveTurn,
      handlePendingTurnFailure,
      admitPendingTurn,
      endTurnAdmissionGeneration,
      finishTurn,
    } = createTurnLifecycle({
      runPromise,
      forkPromise,
      fork,
      pendingRoutineRequests,
      creatingRoutineReviews,
      get publish() {
        return publish;
      },
      get baseEvent() {
        return baseEvent;
      },
      get toolRuntime() {
        return toolRuntime;
      },
      memoryUsageByThread,
      get publishSessionState() {
        return publishSessionState;
      },
      sessionFailureDetail,
      get stopSessionWithResources() {
        return stopSessionWithResources;
      },
      get memorySettings() {
        return memorySettings;
      },
      get refreshEntityMemoryAccess() {
        return refreshEntityMemoryAccess;
      },
      get memoryTurnHarness() {
        return memoryTurnHarness;
      },
      get mastraReservationKey() {
        return mastraReservationKey;
      },
      get mastraMemoryTurns() {
        return mastraMemoryTurns;
      },
      get entityMemoryContext() {
        return entityMemoryContext;
      },
      legacyProviderBridge,
      get startPendingTurn() {
        return startPendingTurn;
      },
      get queueTurnMemory() {
        return queueTurnMemory;
      },
      get completeAssistantMessages() {
        return completeAssistantMessages;
      },
      resolveChildWaiter,
      get workerRuntime() {
        return workerRuntime;
      },
      wired,
      failureDetail,
    });

    /** Calls out to a Promise-based library and types its failure. */
    const runMastra = <A>(operation: string, run: (signal: AbortSignal) => Promise<A>) =>
      Effect.tryPromise({
        try: run,
        catch: (cause) =>
          new AgentControllerRuntimeError({
            operation,
            detail: failureDetail(cause),
            cause,
          }),
      });

    const { toolRuntime } = createToolRuntime({
      botInbox,
      sessions,
      runtimeEvents,
      toolUsageKey,
      toolUsageStarts,
      runPromise,
      botUsageLedger,
      get baseEvent() {
        return baseEvent;
      },
    });

    const { memoryAccessFor, refreshEntityMemoryAccess, entityMemoryContext, memoryHandlers } =
      createMemoryAccess({
        runPromise,
        projectionSnapshotQuery,
        options,
        get memorySettings() {
          return memorySettings;
        },
        memoryApprovals,
        botMemoryStore,
      });

    // Image providers for the GenerateImage tool, read on every session start or reuse. An
    // unreadable settings file hides the tool rather than offering a call that can only fail
    // (ProviderService denies the MCP capability the same way). Without the service, tests
    // keep the tool visible.
    const imageToolSettings = Option.isSome(serverSettings)
      ? serverSettings.value.getSettings.pipe(
          Effect.map((settings) => settings.imageGeneration),
          Effect.orElseSucceed(() => ({ chatgptEnabled: false, grokEnabled: false })),
          Effect.map(({ chatgptEnabled, grokEnabled }) => ({ chatgptEnabled, grokEnabled })),
        )
      : Effect.succeed({ chatgptEnabled: true, grokEnabled: true });

    const memorySettings = () =>
      Option.isSome(serverSettings)
        ? serverSettings.value.getSettings.pipe(
            Effect.map((settings) => ({
              enabled: settings.memory.enabled,
              privateBotMemory: settings.memory.privateBotMemory,
              sharedProjectMemory: settings.memory.sharedProjectMemory,
            })),
            // Fail closed: an unreadable setting must not re-enable memory the user turned off.
            Effect.orElseSucceed(() => ({
              ...DEFAULT_MEMORY_TOOL_SETTINGS,
              enabled: false,
              privateBotMemory: false,
            })),
          )
        : Effect.succeed(DEFAULT_MEMORY_TOOL_SETTINGS);

    const memoryAccessKey = (access: BotMemoryAccess | undefined): string | undefined =>
      access ? `${access.botId}:${access.groupId ?? "private"}` : undefined;

    const legacyResourceIdentity = new Map<string, LegacyResourceIdentity>();
    const legacyTurnMemory = new Map<string, Array<LegacyTurnMemoryState>>();
    const legacyPending = (key: string) => legacyTurnMemory.get(key) ?? [];

    const addLegacyPending = (key: string, pending: LegacyTurnMemoryState) =>
      legacyTurnMemory.set(key, [...legacyPending(key), pending]);

    const removeLegacyPending = (key: string, pending: LegacyTurnMemoryState) => {
      const remaining = legacyPending(key).filter((entry) => entry !== pending);

      if (remaining.length > 0) legacyTurnMemory.set(key, remaining);
      else legacyTurnMemory.delete(key);
    };

    const hasLegacyPending = (key: string, pending: LegacyTurnMemoryState) =>
      legacyPending(key).includes(pending);

    const restoreLegacyMemoryHandler = (key: string, pending: LegacyTurnMemoryState) => {
      if (
        !pending.reviewMemoryHandler ||
        McpMemoryToolSession.readMcpMemoryToolSession(ThreadId.make(key)) !==
          pending.reviewMemoryHandler
      ) {
        return;
      }

      if (pending.priorMemoryHandler) {
        McpMemoryToolSession.setMcpMemoryToolSession(
          ThreadId.make(key),
          pending.priorMemoryHandler,
        );
      } else {
        McpMemoryToolSession.clearMcpMemoryToolSession(ThreadId.make(key));
      }
    };

    const legacyBufferedTerminals = new Map<string, Map<string, ProviderRuntimeEvent>>();
    const mastraMemoryTurns = new Map<string, AkeruMemoryTurn>();

    const mastraReservationKey = (threadId: ThreadId, turnId: TurnId) =>
      `${String(threadId)}:${String(turnId)}`;

    const { releaseMastraReservations, drainLegacyTerminals, queueTurnMemory } =
      createMemoryCadence({
        forkPromise,
        mastraMemoryTurns,
        runMastra,
        hasLegacyPending,
        resolveChildWaiter,
        restoreLegacyMemoryHandler,
        removeLegacyPending,
        legacyPending,
        get bundle() {
          return bundle;
        },
        legacyBufferedTerminals,
        resolvedByThread,
      });

    const { delegationFor, makeDelegationRuntime } = createDelegation({
      runPromise,
      fork,
      wired,
      sessions,
      childWaiters,
      legacyProviderBridge,
      get publish() {
        return publish;
      },
      failureDetail,
    });

    const { bundle } = yield* createHarness({
      options,
      authStorage,
      subscriptionAuth,
      modelConnections,
      config,
      sessions,
      runPromise,
      legacyProviderBridge,
      sessionResources,
      orchestrationEngine,
      routineDispatcher,
      pendingRoutineRequests,
      get publishSessionState() {
        return publishSessionState;
      },
      get publish() {
        return publish;
      },
      get baseEvent() {
        return baseEvent;
      },
      turnStillWaiting,
      toolRuntime,
      memoryUsageByThread,
      get readSessionStartContext() {
        return readSessionStartContext;
      },
      unreservedMemoryCalls,
      botUsageLedger,
    });

    yield* runMastra("init", () => bundle.controller.init());

    const publish = (event: ProviderRuntimeEvent) => {
      PubSub.publishUnsafe(runtimeEvents, event);
    };

    if (Option.isSome(orchestrationEngine) && Option.isSome(projectionSnapshotQuery)) {
      const orchestration: WorkerOrchestration = {
        readSnapshot: () => runPromise(projectionSnapshotQuery.value.getCommandReadModel()),
        dispatch: (command) => runPromise(orchestrationEngine.value.dispatch(command)),
      };

      yield* Ref.update(lateWiring, (current) => ({
        ...current,
        delegationRuntime: current.delegationRuntime ?? makeDelegationRuntime(orchestration),
        workerOrchestration: orchestration,
      }));
    }

    /** Runtime mode for each hidden worker thread's turns, keyed by child thread id. */
    const workerTurnDefaults = new Map<string, RuntimeMode>();

    const { workerRuntime, workersFor } = yield* createWorkers({
      runMastra,
      wired,
      sessions,
      workerTurnDefaults,
      runPromise,
    });

    const { baseEvent, publishSessionState, completeAssistantMessages, handleControllerEvent } =
      createEvents({
        forkPromise,
        runPromise,
        publish,
        messageText,
        itemType,
        config,
        subscriptionAuth,
        cancelPendingApproval,
        sessionResources,
        get APPROVAL_FREE_MASTRA_TOOL_NAMES() {
          return APPROVAL_FREE_MASTRA_TOOL_NAMES;
        },
        omitNullToolFields,
        mcpToolNeedsApproval,
        permissionPolicy,
        legacyProviderBridge,
        toolRuntime,
        failActiveTurn,
        wired,
        workerRuntime,
        approvalDetail,
        sessionFailureDetail,
        finishTurn,
      });

    function startPendingTurn(active: ActiveSession, pending: PendingTurn) {
      forkPromise(
        "Akeru turn admission failed.",
        () => runPromise(admitPendingTurn(active, pending)),
        {
          annotations: { threadId: pending.threadId, turnId: pending.turnId },
          onFailure: (cause) => handlePendingTurnFailure(active, pending, cause),
        },
      );
    }

    const { inspectEngine, resolveEngine } = createEngineRouting({
      legacyProviderBridge,
      usesMastraCode,
      disabledProviderError,
      modelConnections,
      subscriptionAuth,
      mutationLock,
      resolvedByThread,
      sessions,
      mastraModelOptions,
      runMastra,
    });

    const { readSessionStartContext, startSession } = createSessionLifecycle({
      webFetch,
      runPromise,
      projectionSnapshotQuery,
      workerRuntime,
      wired,
      sessions,
      resolvedByThread,
      usesMastraCode,
      legacyProviderBridge,
      disabledProviderError,
      options,
      botMemoryStore,
      failureDetail,
      runMastra,
      imageToolSettings,
      memorySettings,
      memoryHandlers,
      delegationFor,
      workersFor,
      memoryAccessFor,
      toolRuntime,
      toProviderSession,
      legacyResourceIdentity,
      memoryAccessKey,
      sessionResources,
      get stopSessionWithResources() {
        return stopSessionWithResources;
      },
      preparePreviewMcpSession,
      clearPreviewMcpSession,
      entityMemoryContext,
      subscriptionAuth,
      botInbox,
      deleteCatalogMcpServer,
      bundle,
      mastraModelOptions,
      DEFAULT_MODE_ID,
      permissionPolicy,
      handleControllerEvent,
      publish,
      baseEvent,
      publishSessionState,
    });

    const { sendTurn, interruptTurn } = createTurnRequests({
      fileSystem,
      resolvedByThread,
      sessions,
      usesMastraCode,
      legacyProviderBridge,
      disabledProviderError,
      memorySettings,
      legacyResourceIdentity,
      runMastra,
      refreshEntityMemoryAccess,
      entityMemoryContext,
      bundle,
      memoryTurnHarness,
      addLegacyPending,
      hasLegacyPending,
      legacyHiddenWakeByTurn,
      drainLegacyTerminals,
      restoreLegacyMemoryHandler,
      removeLegacyPending,
      toolRuntime,
      config,
      options,
      admitPendingTurn,
      handlePendingTurnFailure,
      legacyPending,
      legacyTurnMemory,
      legacyBufferedTerminals,
      endTurnAdmissionGeneration,
      releaseMastraReservations,
      finishTurn,
    });

    const { respondToRequest, respondToUserInput } = createApprovals({
      sessions,
      usesMastraCode,
      resolvedByThread,
      legacyProviderBridge,
      disabledProviderError,
      pendingRoutineRequests,
      turnStillWaiting,
      publish,
      baseEvent,
      publishSessionState,
      creatingRoutineReviews,
      routineDispatcher,
      ThreadIdBrand,
      toolRuntime,
      approvalDecision,
      runMastra,
    });

    const { stopSessionWithResources, stopSession, rollbackConversation } = createConversation({
      fileSystem,
      sessions,
      legacyProviderBridge,
      legacyPending,
      restoreLegacyMemoryHandler,
      legacyTurnMemory,
      legacyBufferedTerminals,
      runMastra,
      sessionResources,
      clearPreviewMcpSession,
      legacyResourceIdentity,
      usesMastraCode,
      resolvedByThread,
      toolRuntime,
      endTurnAdmissionGeneration,
      releaseMastraReservations,
      finishTurn,
      cancelAllPendingApprovals,
      publishSessionState,
      bundle,
      memoryUsageByThread,
      workerRuntime,
      workerTurnDefaults,
      projectionMessages,
      projectionTurns,
      config,
      interruptTurn,
      startSession,
    });

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        for (const [threadId, active] of sessions) {
          endTurnAdmissionGeneration(active);
          active.pendingTurns.length = 0;
          active.admittingTurn = null;
          active.session.abort();

          if (active.activeTurn) {
            finishTurn(ThreadId.make(threadId), active, "interrupted");
          }

          active.unsubscribe();
          yield* releaseMastraReservations(ThreadId.make(threadId));
          yield* runMastra("deleteSession", () =>
            bundle.controller.deleteSession({ resourceId: threadId }),
          ).pipe(Effect.ignoreCause({ log: true }));
          yield* clearPreviewMcpSession(ThreadId.make(threadId));
          toolRuntime.unregisterSession(threadId);
        }

        for (const threadId of legacyResourceIdentity.keys()) {
          yield* clearPreviewMcpSession(ThreadId.make(threadId));
        }

        for (const pendingTurns of legacyTurnMemory.values()) {
          for (const pending of pendingTurns) {
            if (pending.memoryTurn) {
              yield* runMastra("memory.abandon", () => pending.memoryTurn!.abandon()).pipe(
                Effect.ignoreCause({ log: true }),
              );
            }
          }
        }

        legacyTurnMemory.clear();
        legacyBufferedTerminals.clear();
        legacyResourceIdentity.clear();
        sessions.clear();
        yield* runMastra("resources.shutdown", () => sessionResources.shutdown()).pipe(
          Effect.ignoreCause({ log: true }),
        );
      }),
    );

    yield* runMastra("resources.retryFailedWorkspaceSleeps", () =>
      sessionResources.retryFailedWorkspaceSleeps(),
    ).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.repeat(Schedule.spaced("30 seconds")),
      Effect.forkScoped,
    );

    const auxiliary = createAuxiliaryOperations({
      bundle,
      runMastra,
      legacyProviderBridge,
      sessions,
      runtimeEvents,
      legacyHiddenWakeByTurn,
      legacyPending,
      subscriptionAuth,
      resolvedByThread,
      legacyBufferedTerminals,
      drainLegacyTerminals,
    });

    return AgentController.of({
      readConversationMemory: auxiliary.readConversationMemory,
      clearConversationMemory: auxiliary.clearConversationMemory,
      restoreConversationMemory: auxiliary.restoreConversationMemory,
      listSessions: auxiliary.listSessions,
      get streamEvents() {
        return auxiliary.streamEvents;
      },
      configurePluginRuntime: (input: AkeruPluginRuntimeOptions) =>
        Ref.update(lateWiring, (current) => ({
          ...current,
          pluginRuntimeOptions: input,
          pluginRuntime: createAkeruPluginRuntime(input),
        })),
      configureDelegation: (input) =>
        Ref.update(lateWiring, (current) => ({
          ...current,
          botStateRuntime: createAkeruBotStateRuntime(input),
          channelRuntime: createAkeruChannelRuntime(input),
          delegationRuntime: current.delegationRuntime ?? makeDelegationRuntime(input),
          workerOrchestration: current.workerOrchestration ?? input,
        })),
      failDelegation: ({ threadId, error }) =>
        Effect.sync(() =>
          resolveChildWaiter(threadId, { state: "failed", turnId: null, error }),
        ).pipe(
          Effect.andThen(workerRuntime.childTurnFinished(threadId, { state: "failed", error })),
        ),
      dispatchDelegation: (input) =>
        Effect.tryPromise({
          try: async () => {
            const dispatchDelegation = wired().delegationRuntime?.dispatchDelegation;

            if (!dispatchDelegation) throw new Error("Bot work is not available yet.");

            return dispatchDelegation(input);
          },
          catch: (cause) =>
            new AgentControllerRuntimeError({
              operation: "dispatchDelegation",
              detail: failureDetail(cause),
              cause,
            }),
        }),
      authenticateMcpServer: ({ server, onAuthorizationUrl }) =>
        runMastra("mcp.authenticate", async (signal) => {
          const recoveryFailures: string[] = [];

          const managerSessions = sessionResources.getMcpManagerSessionsForServer(
            String(server.id),
          );

          const status = await authenticateMcpServer({
            server,
            managers: managerSessions.map(({ manager }) => manager),
            managerThreadIds: managerSessions.map(({ threadId }) => threadId),
            createManager: () =>
              (options?.makeMcpManager ?? createMcpManager)(
                path.join(config.stateDir, "bot-mcp-runtime"),
                ".akeru-runtime",
                toMcpServerConfigs([server]),
              ),
            onAuthorizationUrl,
            signal,
            recordSuccess: (serverId) => subscriptionAuth.recordMcpRequestSuccess(serverId),
            recordFailure: (serverId, message) =>
              subscriptionAuth.recordMcpRequestFailure(serverId, message),
            recordRecoveryFailure: (serverId, message) => {
              recoveryFailures.push(message);
              fork("MCP session recovery failed after authentication.", Effect.fail(message), {
                serverId,
              });
            },
          });

          return { toolCount: status.toolCount, recoveryFailures };
        }),

      resolveEngine,
      inspectEngine,
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,

      rollbackConversation,
      uploadFeedback: legacyProviderBridge.uploadFeedback,
    });
  });

export const agentControllerLayerWith = (options?: AgentControllerLiveOptions) =>
  Layer.effect(AgentController, make(options));

export const AgentControllerLive = Layer.effect(
  AgentController,
  Effect.gen(function* () {
    const entityMemoryRepository = yield* EntityMemoryRepository;

    return yield* make({ entityMemoryRepository });
  }),
).pipe(
  Layer.provide(ProjectionThreadMessageRepositoryLive),
  Layer.provide(ProjectionTurnRepositoryLive),
);

export {
  createAkeruMastraAuthStorage,
  delegatedUsageReceipt,
  mastraConnectionIssue,
  recordProviderAccessHealth,
} from "./agentController/ProviderAccess.ts";

export {
  toMcpServerConfigs,
  toMcpServerConfig,
  mcpServerIdForToolName,
} from "./agentController/McpConfiguration.ts";
