// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable akeru/no-manual-effect-runtime-in-tests -- This integration harness owns the runtime so it can advance TestClock and drain the ingestion worker.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ProviderSession,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  ProjectId,
  type ServerSettings,
} from "@akeru/contracts";
import { ChannelDeliveryStoreLive } from "../../../channels/ChannelDeliveryStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEventStoreLive } from "../../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import {
  AgentController,
  type AgentControllerShape,
} from "../../../provider/Services/AgentController.ts";
import * as RepositoryIdentityResolver from "../../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import { OrchestrationEngineLive } from "../OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../../ThreadPlanProgress.ts";
import { ProviderRuntimeIngestionLive } from "../ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../../config.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotInboxService } from "../../../bot-inbox/service.ts";
import { SILENCE_WATCHDOG_SILENT_MS } from "../../SilenceWatchdog.ts";
import { BotUsageLedgerLive } from "../../../usage/BotUsageLedger.ts";

export const asProjectId = (value: string): ProjectId => ProjectId.make(value);

export const asEventId = (value: string): EventId => EventId.make(value);

export const asThreadId = (value: string): ThreadId => ThreadId.make(value);

export const asTurnId = (value: string): TurnId => TurnId.make(value);

export const SILENT_MS = SILENCE_WATCHDOG_SILENT_MS;

export type ReadModel = OrchestrationReadModel;

export type TestThread = ReadModel["threads"][number];

export type TestActivity = TestThread["activities"][number];

export interface HarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly botOwned?: boolean;
  readonly threadTitle?: string;
  readonly serverSettings?: Partial<ServerSettings>;
}

export function makeSilenceWatchdogHarness() {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | ServerSecretStore.ServerSecretStore
    | ServerSettingsService
    | ServerConfig
    | import("../../../channels/ChannelDeliveryStore.ts").ChannelDeliveryStore,
    unknown
  > | null = null;

  let scope: Scope.Closeable | null = null;

  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);

    return dir;
  }

  async function createHarness(options: HarnessOptions = {}) {
    const repositoryRoot = makeTempDir("t3-watchdog-project-");
    NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    const workspaceRoot = repositoryRoot;
    const provider = options.provider ?? ProviderDriverKind.make("codex");

    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const runtimeSessions: ProviderSession[] = [];
    const interruptCalls: Array<{ threadId: ThreadId; turnId: TurnId }> = [];

    const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

    const service: AgentControllerShape = {
      authenticateMcpServer: () => unsupported(),
      resolveEngine: () => unsupported(),
      inspectEngine: () => unsupported(),
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      interruptTurn: (input) =>
        Effect.sync(() => {
          if (input.turnId !== undefined) {
            interruptCalls.push({ threadId: input.threadId, turnId: input.turnId });
          }
        }),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed([...runtimeSessions]),
      rollbackConversation: () => unsupported(),
      uploadFeedback: () => unsupported(),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEventPubSub);
      },
    };

    const emit = (event: ProviderRuntimeEvent): void => {
      Effect.runSync(PubSub.publish(runtimeEventPubSub, event));
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const projectionSnapshotLayer = OrchestrationProjectionSnapshotQueryLive.pipe(
      Layer.provide(RepositoryIdentityResolver.layer),
      Layer.provide(SqlitePersistenceMemory),
    );

    const layer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(BotUsageLedgerLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(Layer.succeed(AgentController, service)),
      Layer.provideMerge(ChannelDeliveryStoreLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(ServerSettingsService.layerTest(options.serverSettings)),
      Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), workspaceRoot)),
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(TestClock.layer()),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);
    const adjustClock = (ms: number) => runtime!.runPromise(TestClock.adjust(ms));
    const dispatch = (command: OrchestrationCommand) => Effect.runPromise(engine.dispatch(command));

    const createdAt = "2026-01-01T00:00:00.000Z";
    await dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-watchdog-project-create"),
      projectId: asProjectId("project-1"),
      title: "Watchdog Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make(provider),
        model: "test-model",
      },
      createdAt,
    });

    if (options.botOwned) {
      await dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-watchdog-bot-create"),
        botId: BotId.make("bot-akeru"),
        name: "Akeru",
        title: "Research bot",
        avatar: { kind: "dither", seed: "akeru" },
        engine: {
          provider: ProviderInstanceId.make(provider),
          model: "test-model",
        },
        sandbox: null,
        runtimeMode: "approval-required",
        usageCap: null,
        groupId: null,
        createdAt,
      });
    }

    await dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-watchdog-thread-create"),
      threadId: asThreadId("thread-1"),
      projectId: asProjectId("project-1"),
      ...(options.botOwned ? { botId: BotId.make("bot-akeru") } : {}),
      title: options.threadTitle ?? "Watchdog thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make(provider),
        model: "test-model",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-watchdog-session-seed"),
      threadId: asThreadId("thread-1"),
      session: {
        threadId: asThreadId("thread-1"),
        status: "ready",
        providerName: provider,
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: createdAt,
        lastError: null,
      },
      createdAt,
    });
    runtimeSessions.push({
      provider,
      status: "ready",
      runtimeMode: "approval-required",
      threadId: asThreadId("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    const readModel = () => Effect.runPromise(snapshotQuery.getSnapshot());
    const serverConfig = await runtime!.runPromise(Effect.service(ServerConfig));
    const botInbox = new BotInboxService(NodePath.join(serverConfig.secretsDir, "bot-inbox.json"));

    const botInboxList = () => {
      botInbox.reload();

      return botInbox.list();
    };

    const emitTurnStarted = (turnId: string) => {
      emit({
        type: "turn.started",
        eventId: asEventId(`evt-turn-started-${turnId}`),
        provider,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId(turnId),
        createdAt,
        payload: {},
      });
    };

    const emitReasoning = (turnId: string, id: string) => {
      emit({
        type: "content.delta",
        eventId: asEventId(`evt-delta-${id}`),
        provider,
        threadId: asThreadId("thread-1"),
        turnId: asTurnId(turnId),
        createdAt,
        payload: { streamKind: "reasoning_text", delta: "thinking" },
      });
    };

    const emitTurnEnded = (turnId: string, kind: "completed" | "interrupted" | "aborted") => {
      emit(
        kind === "aborted"
          ? {
              type: "turn.aborted",
              eventId: asEventId(`evt-turn-aborted-${turnId}`),
              provider,
              threadId: asThreadId("thread-1"),
              turnId: asTurnId(turnId),
              createdAt,
              payload: { reason: "user cancelled" },
            }
          : {
              type: "turn.completed",
              eventId: asEventId(`evt-turn-${kind}-${turnId}`),
              provider,
              threadId: asThreadId("thread-1"),
              turnId: asTurnId(turnId),
              createdAt,
              payload: { state: kind },
            },
      );
    };

    const activitiesOf = async () =>
      (await readModel()).threads.find((t) => t.id === asThreadId("thread-1"))?.activities ?? [];

    const watchdogActivities = async () =>
      (await activitiesOf()).filter((a) => a.id.startsWith("silence-watchdog:"));

    return {
      emit,
      emitTurnStarted,
      emitReasoning,
      emitTurnEnded,
      drain,
      dispatch,
      readModel,
      activitiesOf,
      watchdogActivities,
      interruptCalls,
      botInboxList,
      provider,
      adjustClock,
    };
  }

  const silenceIncidents = (harness: Awaited<ReturnType<typeof createHarness>>) =>
    harness.botInboxList().filter((item) => item.kind === "silence-watchdog-failure");

  const silentKinds = (activities: ReadonlyArray<TestActivity>) =>
    activities.map((activity) => activity.kind);

  const dispose = async () => {
    if (scope) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }

    scope = null;

    if (runtime) {
      await runtime.dispose();
    }

    runtime = null;

    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  };

  return {
    makeTempDir,
    createHarness,
    silenceIncidents,
    silentKinds,
    dispose,
    get runtime() {
      return runtime;
    },
    get scope() {
      return scope;
    },
  };
}
