// @effect-diagnostics nodeBuiltinImport:off
// oxlint-disable t3code/no-manual-effect-runtime-in-tests -- This integration harness owns the runtime so it can advance TestClock and drain the ingestion worker.
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
  RuntimeRequestId,
  THREAD_SILENT_RUN_ACTIVITY_KIND,
  THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
  ThreadId,
  ThreadSilentRunActivityPayload,
  TurnId,
  type OrchestrationCommand,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as ChannelRuntime from "../../channels/ChannelRuntime.ts";
import { ChannelDeliveryStoreLive } from "../../channels/ChannelDeliveryStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  AgentController,
  type AgentControllerShape,
} from "../../provider/Services/AgentController.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotInboxService } from "../../bot-inbox/service.ts";
import { SILENCE_WATCHDOG_SILENT_MS } from "../SilenceWatchdog.ts";
import { BotUsageLedgerLive } from "../../usage/BotUsageLedger.ts";

const asProjectId = (value: string): ProjectId => value as unknown as ProjectId;
const asEventId = (value: string): EventId => EventId.make(value);
const asThreadId = (value: string): ThreadId => ThreadId.make(value);
const asTurnId = (value: string): TurnId => TurnId.make(value);

const SILENT_MS = SILENCE_WATCHDOG_SILENT_MS;

type ReadModel = OrchestrationReadModel;
type TestThread = ReadModel["threads"][number];
type TestActivity = TestThread["activities"][number];

interface HarnessOptions {
  readonly provider?: ProviderDriverKind;
  readonly botOwned?: boolean;
  readonly threadTitle?: string;
  readonly serverSettings?: Partial<ServerSettings>;
}

describe("ProviderRuntimeIngestion silence watchdog", () => {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | ServerSecretStore.ServerSecretStore
    | ServerSettingsService
    | ServerConfig
    | import("../../channels/ChannelDeliveryStore.ts").ChannelDeliveryStore,
    unknown
  > | null = null;
  let scope: Scope.Closeable | null = null;
  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    await ChannelRuntime.shutdownAllChannels();
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
  });

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

  // Codex and Kimi run through the Mastra AgentController; Claude, Grok, and OpenCode
  // through the legacy adapter bridge. All reach ingestion as normalized runtime events.
  it.each(["codex", "kimi", "claude", "grok", "opencode"])(
    "records a silent run and one inbox item for a quiet %s turn without interrupting it",
    async (driver) => {
      const harness = await createHarness({
        provider: ProviderDriverKind.make(driver),
        botOwned: true,
      });
      const turnId = asTurnId(`turn-silent-${driver}`);
      harness.emitTurnStarted(turnId);
      await harness.drain();

      await harness.adjustClock(SILENT_MS - 1);
      await harness.drain();
      expect(await harness.watchdogActivities()).toHaveLength(0);

      await harness.adjustClock(1);
      await harness.drain();
      const watchdog = await harness.watchdogActivities();
      expect(silentKinds(watchdog)).toEqual([THREAD_SILENT_RUN_ACTIVITY_KIND]);
      expect(watchdog[0]?.turnId).toBe(turnId);
      expect(
        Schema.decodeUnknownSync(ThreadSilentRunActivityPayload)(watchdog[0]?.payload),
      ).toEqual({
        provider: driver,
        lastActivityAt: "1970-01-01T00:00:00.000Z",
      });
      expect(harness.interruptCalls).toEqual([]);

      const incidents = silenceIncidents(harness);
      expect(incidents).toHaveLength(1);
      expect(incidents[0]).toMatchObject({
        status: "open",
        incidentKey: `silence:thread-1:${turnId}`,
        botName: "Akeru",
        taskOrRoutine: "Watchdog thread",
      });
    },
  );

  it("clears the silent run and resolves the inbox item when output resumes", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = "turn-resume";
    harness.emitTurnStarted(turnId);
    await harness.drain();
    await harness.adjustClock(SILENT_MS);
    await harness.drain();
    expect(silenceIncidents(harness)[0]?.status).toBe("open");

    await harness.adjustClock(1_000);
    harness.emitReasoning(turnId, "resume");
    await harness.drain();
    await harness.adjustClock(1);
    await harness.drain();

    expect(silentKinds(await harness.watchdogActivities())).toEqual([
      THREAD_SILENT_RUN_ACTIVITY_KIND,
      THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND,
    ]);
    expect(silenceIncidents(harness)).toMatchObject([{ status: "resolved" }]);
  });

  it("keeps one inbox item across repeated silent windows in the same turn", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = "turn-repeated";
    harness.emitTurnStarted(turnId);
    await harness.drain();

    for (const window of [1, 2, 3]) {
      await harness.adjustClock(SILENT_MS);
      await harness.drain();
      await harness.adjustClock(1_000);
      harness.emitReasoning(turnId, `window-${window}`);
      await harness.drain();
    }
    await harness.adjustClock(SILENT_MS);
    await harness.drain();

    const incidents = silenceIncidents(harness);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ status: "open", occurrenceCount: 4 });
    const kinds = silentKinds(await harness.watchdogActivities());
    expect(kinds.filter((kind) => kind === THREAD_SILENT_RUN_ACTIVITY_KIND)).toHaveLength(4);
    expect(kinds.filter((kind) => kind === THREAD_SILENT_RUN_CLEARED_ACTIVITY_KIND)).toHaveLength(
      3,
    );
  });

  it("keeps the turn alive on reasoning and tool content deltas", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-delta-alive");
    harness.emitTurnStarted(turnId);
    await harness.drain();

    await harness.adjustClock(SILENT_MS - 10_000);
    harness.emitReasoning(turnId, "reasoning");
    await harness.drain();
    await harness.adjustClock(SILENT_MS - 5_000);
    await harness.drain();

    harness.emit({
      type: "content.delta",
      eventId: asEventId("evt-delta-tool"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { streamKind: "command_output", delta: "tool output" },
    });
    await harness.drain();
    await harness.adjustClock(SILENT_MS - 5_000);
    await harness.drain();
    expect(await harness.watchdogActivities()).toHaveLength(0);
  });

  it("pauses on approval wait and resumes on request.resolved", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-approval-pause");
    const requestId = RuntimeRequestId.make("req-approval-pause");
    harness.emitTurnStarted(turnId);
    await harness.drain();

    harness.emit({
      type: "request.opened",
      eventId: asEventId("evt-approval-opened"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      requestId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { requestType: "command_execution_approval", detail: "pwd" },
    });
    await harness.drain();

    await harness.adjustClock(SILENT_MS * 3);
    await harness.drain();
    expect(await harness.watchdogActivities()).toHaveLength(0);

    harness.emit({
      type: "request.resolved",
      eventId: asEventId("evt-approval-resolved"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      requestId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { requestType: "command_execution_approval", decision: "accept" },
    });
    await harness.drain();

    await harness.adjustClock(SILENT_MS);
    await harness.drain();
    expect(silentKinds(await harness.watchdogActivities())).toEqual([
      THREAD_SILENT_RUN_ACTIVITY_KIND,
    ]);
    expect(harness.interruptCalls).toEqual([]);
  });

  it("pauses on user-input wait and resumes on user-input.resolved", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-userinput-pause");
    const requestId = RuntimeRequestId.make("req-userinput-pause");
    harness.emitTurnStarted(turnId);
    await harness.drain();

    harness.emit({
      type: "user-input.requested",
      eventId: asEventId("evt-userinput-opened"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      requestId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {
        questions: [
          {
            id: "q1",
            header: "Q",
            question: "Pick one",
            options: [{ label: "a", description: "A" }],
          },
        ],
      },
    });
    await harness.drain();

    await harness.adjustClock(SILENT_MS * 3);
    await harness.drain();
    expect(await harness.watchdogActivities()).toHaveLength(0);

    harness.emit({
      type: "user-input.resolved",
      eventId: asEventId("evt-userinput-resolved"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      requestId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { answers: { q1: "a" } },
    });
    await harness.drain();

    await harness.adjustClock(SILENT_MS);
    await harness.drain();
    expect(silentKinds(await harness.watchdogActivities())).toEqual([
      THREAD_SILENT_RUN_ACTIVITY_KIND,
    ]);
  });

  it.each(["completed", "interrupted", "aborted"] as const)(
    "disposes the watchdog and resolves the inbox item when a silent turn is %s",
    async (ending) => {
      const harness = await createHarness({ botOwned: true });
      const turnId = `turn-ended-${ending}`;
      harness.emitTurnStarted(turnId);
      await harness.drain();
      await harness.adjustClock(SILENT_MS);
      await harness.drain();
      expect(silenceIncidents(harness)).toMatchObject([{ status: "open" }]);

      harness.emitTurnEnded(turnId, ending);
      await harness.drain();
      expect(silenceIncidents(harness)).toMatchObject([{ status: "resolved" }]);

      // A late event for the ended turn cannot revive the disposed watchdog.
      harness.emitReasoning(turnId, "late");
      await harness.drain();
      await harness.adjustClock(SILENT_MS * 3);
      await harness.drain();
      expect(silentKinds(await harness.watchdogActivities())).toEqual([
        THREAD_SILENT_RUN_ACTIVITY_KIND,
      ]);
      expect(silenceIncidents(harness)).toMatchObject([{ status: "resolved" }]);
    },
  );

  it("stops the watchdog on session.exited", async () => {
    const harness = await createHarness({ botOwned: true });
    const turnId = asTurnId("turn-exited-stop");
    harness.emitTurnStarted(turnId);
    await harness.drain();
    harness.emit({
      type: "session.exited",
      eventId: asEventId("evt-exited-stop"),
      provider: harness.provider,
      threadId: asThreadId("thread-1"),
      turnId,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: {},
    });
    await harness.drain();
    await harness.adjustClock(SILENT_MS * 3);
    await harness.drain();
    expect(await harness.watchdogActivities()).toHaveLength(0);
    expect(silenceIncidents(harness)).toHaveLength(0);
  });

  it("records the silent state without an inbox item for a chat with no bot", async () => {
    const harness = await createHarness();
    harness.emitTurnStarted("turn-no-bot");
    await harness.drain();
    await harness.adjustClock(SILENT_MS);
    await harness.drain();
    expect(silentKinds(await harness.watchdogActivities())).toEqual([
      THREAD_SILENT_RUN_ACTIVITY_KIND,
    ]);
    expect(silenceIncidents(harness)).toHaveLength(0);
  });
});
