import type { ActivityRecord } from "../../ActivityPayloadBounds.ts";
import * as Match from "effect/Match";
import { createObservationHistory } from "../../test-support/Observations.ts";
import {
  normalizeFixtureEvent,
  type LegacyProviderRuntimeEvent,
} from "../../test-support/ProviderFixtureEvents.ts";

export type {
  LegacyProviderRuntimeEvent,
  FixtureProviderRuntimeEvent,
} from "../../test-support/ProviderFixtureEvents.ts";

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import {
  OrchestrationReadModel,
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ProviderSession,
  ProviderInstanceId,
} from "@akeru/contracts";
import {
  AkeruUsageReservationId,
  BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  type OrchestrationCommand,
  ProjectId,
  ProviderItemId,
  RuntimeRequestId,
  type ServerSettings,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as ChannelRuntime from "../../../channels/ChannelRuntime.ts";
import {
  ChannelDeliveryStore,
  ChannelDeliveryStoreLive,
} from "../../../channels/ChannelDeliveryStore.ts";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
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
import { BotUsageLedger, BotUsageLedgerLive } from "../../../usage/BotUsageLedger.ts";

export function makeTestServerSettingsLayer(overrides: Partial<ServerSettings> = {}) {
  return ServerSettingsService.layerTest(overrides);
}

export const asProjectId = (value: string): ProjectId => ProjectId.make(value);

export const asItemId = (value: string): ProviderItemId => ProviderItemId.make(value);

export const asEventId = (value: string): EventId => EventId.make(value);

export const asMessageId = (value: string): MessageId => MessageId.make(value);

export const asThreadId = (value: string): ThreadId => ThreadId.make(value);

export const asTurnId = (value: string): TurnId => TurnId.make(value);

export function createAgentControllerHarness() {
  const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
  const runtimeSessions: ProviderSession[] = [];

  const unsupported = () => Effect.die(new Error("Unsupported provider call in test")) as never;

  const service: AgentControllerShape = {
    authenticateMcpServer: () => unsupported(),
    resolveEngine: () => unsupported(),
    inspectEngine: () => unsupported(),
    startSession: () => unsupported(),
    sendTurn: () => unsupported(),
    interruptTurn: () => unsupported(),
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

  const setSession = (session: ProviderSession): void => {
    const existingIndex = runtimeSessions.findIndex((entry) => entry.threadId === session.threadId);

    if (existingIndex >= 0) {
      runtimeSessions[existingIndex] = session;

      return;
    }

    runtimeSessions.push(session);
  };

  const emit = (event: LegacyProviderRuntimeEvent): void => {
    Effect.runSync(PubSub.publish(runtimeEventPubSub, normalizeFixtureEvent(event)));
  };

  const emitUnsafe = (event: ActivityRecord) => {
    // SAFETY: Only malformed-event tests use this boundary to exercise handler isolation.
    Effect.runSync(PubSub.publish(runtimeEventPubSub, event as ProviderRuntimeEvent));
  };

  return {
    service,
    emitUnsafe,
    emit,
    setSession,
  };
}

export type ProviderRuntimeTestReadModel = OrchestrationReadModel;

export type ProviderRuntimeTestThread = ProviderRuntimeTestReadModel["threads"][number];

export type ProviderRuntimeTestMessage = ProviderRuntimeTestThread["messages"][number];

export type ProviderRuntimeTestProposedPlan = ProviderRuntimeTestThread["proposedPlans"][number];

export type ProviderRuntimeTestActivity = ProviderRuntimeTestThread["activities"][number];

export type ProviderRuntimeTestCheckpoint = ProviderRuntimeTestThread["checkpoints"][number];

export async function waitForThread(
  harness: {
    waitForThread: (
      predicate: (thread: ProviderRuntimeTestThread) => boolean,
      threadId: ThreadId,
      timeoutMs: number,
    ) => Promise<ProviderRuntimeTestThread>;
  },
  predicate: (thread: ProviderRuntimeTestThread) => boolean,
  timeoutMs = 2000,
  threadId: ThreadId = asThreadId("thread-1"),
) {
  return harness.waitForThread(predicate, threadId, timeoutMs);
}

export function createRuntimeIngestionHarness() {
  let runtime: ManagedRuntime.ManagedRuntime<
    | OrchestrationEngineService
    | ProviderRuntimeIngestionService
    | ProjectionSnapshotQuery
    | BotUsageLedger
    | ServerSecretStore.ServerSecretStore
    | ServerSettingsService
    | ChannelDeliveryStore
    | ChannelRuntime.ChannelRuntime,
    unknown
  > | null = null;

  let scope: Scope.Closeable | null = null;

  const tempDirs: string[] = [];

  function makeTempDir(prefix: string): string {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
    tempDirs.push(dir);

    return dir;
  }

  async function createHarness(options?: {
    serverSettings?: Partial<ServerSettings>;
    threadTitle?: string;
    botOwned?: boolean;
    workspaceSubdirectory?: string;
  }) {
    const repositoryRoot = makeTempDir("t3-provider-project-");
    NodeChildProcess.execFileSync("git", ["init", "--initial-branch=main"], {
      cwd: repositoryRoot,
      stdio: "ignore",
    });
    const workspaceRoot = NodePath.join(repositoryRoot, options?.workspaceSubdirectory ?? "");
    NodeFS.mkdirSync(workspaceRoot, { recursive: true });
    const provider = createAgentControllerHarness();
    let startTransport: ChannelRuntime.ChannelRuntimeDependencies["startTransport"];
    let nextChannelId = 0;

    const channelRuntimeLayer = Layer.unwrap(
      Effect.gen(function* () {
        const snapshotQuery = yield* ProjectionSnapshotQuery;

        return ChannelRuntime.ChannelRuntime.layerWith({
          engine: yield* OrchestrationEngineService,
          secretStore: yield* ServerSecretStore.ServerSecretStore,
          settings: yield* ServerSettingsService,
          deliveryStore: yield* ChannelDeliveryStore,
          readModel: snapshotQuery.getSnapshot(),
          readThread: (threadId) =>
            snapshotQuery
              .getSnapshot()
              .pipe(
                Effect.map(
                  (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
                ),
              ),
          listChannelConversationIds:
            ChannelRuntime.listChannelConversationIdsFromQuery(snapshotQuery),
          nowIso: Effect.succeed("2026-01-01T00:00:00.000Z"),
          randomUuid: Effect.sync(() => `channel-test-${++nextChannelId}`),
          startTransport: (input, onMessage, context) =>
            startTransport
              ? startTransport(input, onMessage, context)
              : Promise.reject(new Error("No test transport configured.")),
        });
      }),
    );

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
      Layer.provideMerge(channelRuntimeLayer),
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(projectionSnapshotLayer),
      // Single shared liveness instance across ingestion (writer), the
      // engine, and the snapshot query (reader).
      Layer.provideMerge(ThreadBackgroundLiveness.layer),
      Layer.provideMerge(ThreadPlanProgress.layer),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(BotUsageLedgerLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(Layer.succeed(AgentController, provider.service)),
      Layer.provideMerge(ChannelDeliveryStoreLive.pipe(Layer.provide(SqlitePersistenceMemory))),
      Layer.provideMerge(ServerSecretStore.layer),
      Layer.provideMerge(makeTestServerSettingsLayer(options?.serverSettings)),
      Layer.provideMerge(CheckpointStore.layer.pipe(Layer.provide(VcsDriverRegistry.layer))),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), workspaceRoot)),
      Layer.provideMerge(NodeServices.layer),
    );

    runtime = ManagedRuntime.make(layer);
    const engine = await runtime.runPromise(Effect.service(OrchestrationEngineService));
    const snapshotQuery = await runtime.runPromise(Effect.service(ProjectionSnapshotQuery));
    const ingestion = await runtime.runPromise(Effect.service(ProviderRuntimeIngestionService));
    scope = await Effect.runPromise(Scope.make("sequential"));
    const observations = createObservationHistory<void>();

    const domainEvents = await runtime.runPromise(
      engine.subscribeDomainEvents.pipe(Scope.provide(scope)),
    );

    await runtime.runPromise(
      Stream.runForEach(domainEvents, () => observations.publish(undefined)).pipe(
        Effect.forkIn(scope),
      ),
    );
    await Effect.runPromise(ingestion.start().pipe(Scope.provide(scope)));
    const drain = () => Effect.runPromise(ingestion.drain);
    const dispatch = (command: OrchestrationCommand) => Effect.runPromise(engine.dispatch(command));

    const createdAt = "2026-01-01T00:00:00.000Z";
    await dispatch({
      type: "project.create",
      commandId: CommandId.make("cmd-provider-project-create"),
      projectId: asProjectId("project-1"),
      title: "Provider Project",
      workspaceRoot,
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      createdAt,
    });

    if (options?.botOwned) {
      await dispatch({
        type: "bot.create",
        commandId: CommandId.make("cmd-bot-create"),
        botId: BotId.make("bot-akeru"),
        name: "Akeru",
        title: "Research bot",
        avatar: { kind: "dither", seed: "akeru" },
        engine: {
          provider: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        sandbox: null,
        runtimeMode: "approval-required",
        groupId: null,
        createdAt,
      });
    }

    await dispatch({
      type: "thread.create",
      commandId: CommandId.make("cmd-thread-create"),
      threadId: ThreadId.make("thread-1"),
      projectId: asProjectId("project-1"),
      ...(options?.botOwned ? { botId: BotId.make("bot-akeru") } : {}),
      title: options?.threadTitle ?? "Thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    await dispatch({
      type: "thread.session.set",
      commandId: CommandId.make("cmd-session-seed"),
      threadId: ThreadId.make("thread-1"),
      session: {
        threadId: ThreadId.make("thread-1"),
        status: "ready",
        providerName: "codex",
        runtimeMode: "approval-required",
        activeTurnId: null,
        updatedAt: createdAt,
        lastError: null,
      },
      createdAt,
    });
    provider.setSession({
      provider: ProviderDriverKind.make("codex"),
      status: "ready",
      runtimeMode: "approval-required",
      threadId: ThreadId.make("thread-1"),
      createdAt,
      updatedAt: createdAt,
    });

    const withChannels = <A, E>(
      use: (channels: ChannelRuntime.ChannelRuntimeShape) => Effect.Effect<A, E>,
    ) => runtime!.runPromise(ChannelRuntime.ChannelRuntime.pipe(Effect.flatMap(use)));

    return {
      run: <A, E>(effect: Effect.Effect<A, E>) => runtime!.runPromise(effect),
      engine,
      dispatch,
      connectChannel: async (
        post: (externalThreadId: string, text: string) => Promise<void>,
        channelProvider: "telegram" | "slack" | "discord" = "telegram",
        reactions?: {
          add: (threadId: string, messageId: string, emoji: string) => Promise<void>;
          remove: (threadId: string, messageId: string, emoji: string) => Promise<void>;
        },
      ) => {
        let inbound:
          | Parameters<NonNullable<ChannelRuntime.ChannelRuntimeDependencies["startTransport"]>>[1]
          | undefined;

        startTransport = async (_input, onMessage) => {
          inbound = onMessage;

          return {
            externalIdentity: "test-channel",
            runtime: {
              post,
              shutdown: async () => {},
              ...(reactions ? { react: reactions.add, removeReaction: reactions.remove } : {}),
            },
          };
        };

        await withChannels((channels) =>
          channels.connect({
            type: "channel.connect",
            commandId: CommandId.make("cmd-channel-connect"),
            botId: BotId.make("bot-akeru"),
            targetProjectId: asProjectId("project-1"),
            ...Match.value(channelProvider).pipe(
              Match.when(
                "telegram",
                () => ({ provider: "telegram", token: "test-token" }) as const,
              ),
              Match.when(
                "slack",
                () =>
                  ({
                    provider: "slack",
                    botToken: "test-token",
                    appToken: "app-token",
                  }) as const,
              ),
              Match.orElse(
                () =>
                  ({
                    provider: "discord",
                    botToken: "test-token",
                    applicationId: "test-app",
                    publicKey: "test-key",
                  }) as const,
              ),
            ),
          }),
        );

        return {
          inbound: (message: Parameters<NonNullable<typeof inbound>>[0]) => inbound!(message),
        };
      },
      disconnectChannel: (botId: BotId, channelProvider: "telegram" | "slack" | "discord") =>
        withChannels((channels) => channels.disconnect(botId, channelProvider)),
      shutdownChannels: () => withChannels((channels) => channels.shutdown),
      channels: () => withChannels((channels) => Effect.succeed(channels)),
      readModel: () => Effect.runPromise(snapshotQuery.getSnapshot()),
      waitForThread: (
        predicate: (thread: ProviderRuntimeTestThread) => boolean,
        threadId: ThreadId,
        timeoutMs: number,
      ) =>
        Effect.runPromise(
          observations.readUntil(
            snapshotQuery.getSnapshot(),
            (snapshot) => {
              const thread = snapshot.threads.find((entry) => entry.id === threadId);

              return thread !== undefined && predicate(thread);
            },
            "runtime thread state",
            timeoutMs,
          ),
        ).then((snapshot) => snapshot.threads.find((entry) => entry.id === threadId)!),
      readThreadShell: () =>
        runtime!.runPromise(
          snapshotQuery
            .getThreadShellById(asThreadId("thread-1"))
            .pipe(Effect.map(Option.getOrThrow)),
        ),
      emit: provider.emit,
      emitUnsafe: provider.emitUnsafe,
      setProviderSession: provider.setSession,
      drain,
      botInbox: new BotInboxService(
        NodePath.join(workspaceRoot, "userdata", "secrets", "bot-inbox.json"),
      ),
      reserveBotUsage: (turnId: TurnId | null) =>
        runtime!.runPromise(
          BotUsageLedger.pipe(
            Effect.flatMap((ledger) =>
              ledger.reserve({
                reservationId: AkeruUsageReservationId.make(`test:${turnId}`),
                sourceKey: `test:${turnId}`,
                botId: BotId.make("bot-akeru"),
                threadId: ThreadId.make("thread-1"),
                turnId,
                category: "turn",
                maximumTokens: 1_000,
                provider: ProviderDriverKind.make("codex"),
                model: "gpt-5-codex",
                createdAt,
              }),
            ),
          ),
        ),
      summarizeBotUsage: () =>
        runtime!.runPromise(
          BotUsageLedger.pipe(
            Effect.flatMap((ledger) => ledger.summarize(BotId.make("bot-akeru"))),
          ),
        ),
    };
  }

  function userInputEvent(
    turnId: string,
    requestId: string,
    responseMode?: "message",
  ): ProviderRuntimeEvent {
    return {
      type: "user-input.requested",
      eventId: asEventId(`requested:${requestId}`),
      provider: ProviderDriverKind.make("codex"),
      threadId: asThreadId("thread-1"),
      turnId: asTurnId(turnId),
      requestId: RuntimeRequestId.make(requestId),
      createdAt: "2026-01-01T00:00:01.000Z",
      payload: {
        ...(responseMode ? { responseMode } : {}),
        questions: ["first", "second"].map((id) => ({
          id,
          header: id,
          question: `Choose ${id}`,
          options: [{ label: "yes", description: "Continue" }],
          multiSelect: false,
        })),
      },
    };
  }

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
    userInputEvent,
    dispose,
    get runtime() {
      return runtime;
    },
    get scope() {
      return scope;
    },
  };
}
