import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  CHANNEL_PROVIDERS,
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { makeSqlitePersistenceLive } from "../persistence/Layers/Sqlite.ts";
import { OrchestrationCommandReceiptRepository } from "../persistence/Services/OrchestrationCommandReceipts.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import { makeMemoryChannelDeliveryStore } from "./ChannelDeliveryStore.ts";
import {
  dispatchInboundChannelMessage,
  shutdownAllChannels,
  type ChannelRuntimeDependencies,
} from "./ChannelRuntime.ts";

const NOW = "2026-09-04T12:00:00.000Z";
const LATER = "2026-09-04T13:00:00.000Z";
const BOT_ID = BotId.make("inbound-restart-bot");
const FIRST_PROJECT_ID = ProjectId.make("first-project");
const TARGET_PROJECT_ID = ProjectId.make("selected-project");

function makeLayer(dbPath: string) {
  return OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provide(ThreadPlanProgress.layer),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provideMerge(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(makeSqlitePersistenceLive(dbPath)),
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "akeru-inbound-restart-" })),
    Layer.provideMerge(NodeServices.layer),
  );
}

const makeDependencies = Effect.fn("makeDependencies")(function* (now: string) {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const queries = yield* Queue.unbounded<Effect.Effect<void>>();
  yield* Queue.take(queries).pipe(Effect.flatten, Effect.forever, Effect.forkScoped);

  // Promise callbacks submit projection reads to the scoped test worker.
  const readAsPromise = <A, E>(query: Effect.Effect<A, E>): Promise<A> =>
    new Promise((resolve, reject) => {
      Queue.offerUnsafe(
        queries,
        query.pipe(
          Effect.matchCause({
            onSuccess: resolve,
            onFailure: (cause) => reject(Cause.squash(cause)),
          }),
        ),
      );
    });

  return {
    engine,
    readModel: () => readAsPromise(snapshots.getCommandReadModel()),
    readThread: (threadId) =>
      readAsPromise(snapshots.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrNull))),
    nowIso: async () => now,
    randomUuid: async () => NodeCrypto.randomUUID(),
    deliveryStore: makeMemoryChannelDeliveryStore(),
    secretStore: {
      get: () => Effect.die("Inbound dispatch must not read secrets."),
      set: () => Effect.die("Inbound dispatch must not write secrets."),
      create: () => Effect.die("Inbound dispatch must not create secrets."),
      getOrCreateRandom: () => Effect.die("Inbound dispatch must not create secrets."),
      remove: () => Effect.die("Inbound dispatch must not remove secrets."),
    },
    settings: {
      getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
      updateSettings: () => Effect.die("Inbound dispatch must not change settings."),
    },
  } satisfies ChannelRuntimeDependencies;
});

const seedProjectsAndBot = Effect.fn("seedProjectsAndBot")(function* (root: string) {
  const engine = yield* OrchestrationEngineService;
  const path = yield* Path.Path;
  for (const projectId of [FIRST_PROJECT_ID, TARGET_PROJECT_ID]) {
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`create-${projectId}`),
      projectId,
      title: projectId,
      workspaceRoot: path.join(root, projectId),
      defaultModelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6",
      },
      createdAt: NOW,
    });
  }
  yield* engine.dispatch({
    type: "bot.create",
    commandId: CommandId.make("create-inbound-bot"),
    botId: BOT_ID,
    name: "Scout",
    title: "Agent",
    avatar: { kind: "dither", seed: "scout" },
    engine: null,
    sandbox: "local",
    runtimeMode: "full-access",
    usageCap: null,
    groupId: null,
    createdAt: NOW,
  });
});

const readReceipt = Effect.fn("readReceipt")(function* (commandId: CommandId) {
  const receipts = yield* OrchestrationCommandReceiptRepository;
  return Option.getOrThrow(yield* receipts.getByCommandId({ commandId }));
});

describe("channel inbound persistence across restart", () => {
  for (const provider of CHANNEL_PROVIDERS) {
    it.effect(
      `${provider} suppresses redelivery after reconstruction and accepts distinct messages in the selected project`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-channel-inbound-" });
          const dbPath = path.join(root, "state.sqlite");
          yield* Effect.addFinalizer(() => Effect.promise(shutdownAllChannels));
          const input = {
            botId: BOT_ID,
            projectId: TARGET_PROJECT_ID,
            provider,
            externalThreadId: "external-conversation",
            externalMessageId: "external-message-1",
            externalSenderId: "sender-1",
            externalSenderName: "External sender",
            text: "Work in the selected project",
          };

          const original = yield* Effect.gen(function* () {
            const before = yield* makeDependencies(NOW);
            yield* seedProjectsAndBot(root);
            yield* Effect.promise(() => dispatchInboundChannelMessage(before, input));

            const originalEvents = yield* Stream.runCollect(before.engine.readEvents(0));
            const originalTurns = originalEvents.filter(
              (event) => event.type === "thread.turn-start-requested",
            );
            expect(originalTurns).toHaveLength(1);
            const originalTurn = originalTurns[0]!;
            const commandId = originalTurn.commandId!;
            const threadId = originalTurn.payload.threadId;
            const originalReceipt = yield* readReceipt(commandId);
            expect(originalReceipt).toMatchObject({
              status: "accepted",
              aggregateKind: "thread",
              aggregateId: threadId,
            });
            const originalThread = yield* Effect.promise(() => before.readThread(threadId));
            expect(originalThread).toMatchObject({ projectId: TARGET_PROJECT_ID, botId: BOT_ID });
            expect(
              originalThread?.messages.filter((message) => message.role === "user"),
            ).toHaveLength(1);
            const expectedOrigin = {
              provider,
              externalThreadId: input.externalThreadId,
              externalMessageId: input.externalMessageId,
              externalSenderId: input.externalSenderId,
            };
            expect(originalThread?.messages[0]).toMatchObject({
              channelOrigin: expectedOrigin,
              authorDisplayName: input.externalSenderName,
            });
            const snapshots = yield* ProjectionSnapshotQuery;
            const fullSnapshot = yield* snapshots.getSnapshot();
            expect(
              fullSnapshot.threads.find((entry) => entry.id === threadId)?.messages[0],
            ).toMatchObject({
              channelOrigin: expectedOrigin,
              authorDisplayName: input.externalSenderName,
            });
            const windowed = Option.getOrThrow(
              yield* snapshots.getThreadDetailSnapshot(threadId, { turnLimit: 1 }),
            );
            expect(windowed.thread.messages[0]).toMatchObject({
              channelOrigin: expectedOrigin,
              authorDisplayName: input.externalSenderName,
            });
            const originalSequence = yield* before.engine.latestSequence;
            yield* Effect.promise(shutdownAllChannels);
            return {
              before,
              commandId,
              threadId,
              originalReceipt,
              originalThread,
              originalEvents,
              originalSequence,
            };
          }).pipe(Effect.provide(makeLayer(dbPath)), Effect.scoped);

          // The first scope closes its SQLite connection before the second layer opens it.
          yield* Effect.gen(function* () {
            const {
              before,
              commandId,
              threadId,
              originalReceipt,
              originalThread,
              originalEvents,
              originalSequence,
            } = original;
            const after = yield* makeDependencies(LATER);
            expect(after.engine).not.toBe(before.engine);
            expect(after.deliveryStore).not.toBe(before.deliveryStore);
            expect(yield* readReceipt(commandId)).toEqual(originalReceipt);
            expect(yield* Effect.promise(() => after.readThread(threadId))).toEqual(originalThread);

            yield* Effect.promise(() => dispatchInboundChannelMessage(after, input));

            expect(yield* after.engine.latestSequence).toBe(originalSequence);
            expect(yield* readReceipt(commandId)).toEqual(originalReceipt);
            expect(yield* Stream.runCollect(after.engine.readEvents(0))).toEqual(originalEvents);
            expect(yield* Effect.promise(() => after.readThread(threadId))).toEqual(originalThread);

            yield* Effect.promise(() =>
              dispatchInboundChannelMessage(after, {
                ...input,
                externalMessageId: "external-message-2",
              }),
            );

            const events = yield* Stream.runCollect(after.engine.readEvents(0));
            const turns = events.filter((event) => event.type === "thread.turn-start-requested");
            expect(turns).toHaveLength(2);
            expect(new Set(turns.map((event) => event.commandId)).size).toBe(2);
            expect(turns.map((event) => event.payload.threadId)).toEqual([threadId, threadId]);
            const messageEvents = events
              .filter((event) => event.type === "thread.message-sent")
              .filter((event) => event.payload.role === "user");
            expect(messageEvents).toHaveLength(2);
            expect(
              messageEvents.map((event) => event.payload.channelOrigin?.externalMessageId),
            ).toEqual([input.externalMessageId, "external-message-2"]);
            const thread = yield* Effect.promise(() => after.readThread(threadId));
            expect(thread).toMatchObject({ projectId: TARGET_PROJECT_ID, botId: BOT_ID });
            const messages = thread?.messages.filter((message) => message.role === "user") ?? [];
            expect(messages.map((message) => message.id)).toEqual(
              messageEvents.map((event) => event.payload.messageId),
            );
            expect(messages.map((message) => message.text)).toEqual([input.text, input.text]);
            expect(new Set(messages.map((message) => message.id)).size).toBe(2);
            expect(
              (yield* Effect.promise(after.readModel)).threads.map((entry) => entry.projectId),
            ).toEqual([TARGET_PROJECT_ID]);
            expect(yield* readReceipt(turns[1]!.commandId!)).toMatchObject({
              status: "accepted",
              aggregateId: threadId,
            });
          }).pipe(Effect.provide(makeLayer(dbPath)), Effect.scoped);
        }).pipe(Effect.provide(NodeServices.layer)),
    );
  }
});
