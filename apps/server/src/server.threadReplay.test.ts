// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite.ts";
import { OrchestrationEventStoreLive } from "./persistence/Layers/OrchestrationEventStore.ts";
import { OrchestrationEventStore } from "./persistence/Services/OrchestrationEventStore.ts";

import {
  defaultOrchestrationReadModel,
  defaultThreadId,
  makeLiveToolActivityEvent,
} from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient, jsonRequestBody } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect(
    "subscribeThread sends a fresh snapshot when its event count exceeds the replay limit",
    () =>
      Effect.gen(function* () {
        let readEventsCalls = 0;
        const thread = defaultOrchestrationReadModel().threads[0]!;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              latestSequence: Effect.succeed(100_000),
              getThreadReplayStats: () =>
                Effect.succeed({
                  eventCount: 1_001,
                  payloadBytes: 1_000,
                  hasCreateEvent: false,
                }),
              readThreadEvents: () =>
                Stream.sync(() => {
                  readEventsCalls += 1;

                  return {} as OrchestrationEvent;
                }),
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.succeed(Option.some({ snapshotSequence: 100_000, thread })),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");

        const items = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeThread]({
              threadId: defaultThreadId,
              afterSequence: 5,
              requestCompletionMarker: true,
            }).pipe(Stream.take(2), Stream.runCollect),
          ),
        );

        const [first, second] = Array.from(items);
        // Never truncate a thread's replay at the event limit.
        assert.equal(first?.kind, "snapshot");

        if (first?.kind === "snapshot") {
          assert.equal(first.snapshot.thread.id, defaultThreadId);
          assert.equal(first.snapshot.snapshotSequence, 100_000);
        }

        assert.equal(second?.kind, "synchronized");
        assert.equal(readEventsCalls, 0);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const thread = defaultOrchestrationReadModel().threads[0]!;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            getThreadReplayStats: () =>
              Effect.die("An invalid cursor must not start a replay query"),
            readThreadEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;

                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 10,
          }).pipe(Stream.runHead),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread bounds catch-up replay to the captured head", () =>
    Effect.gen(function* () {
      let replayHead: number | undefined;
      let headSequence = 50;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const now = "2026-01-01T00:00:00.000Z";

      const messageEvent = {
        sequence: 3,
        eventId: EventId.make("event-replay-message"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {
          threadId: defaultThreadId,
          messageId: MessageId.make("message-replay"),
          role: "user",
          text: "Replayed message",
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.sync(() => headSequence),
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            getThreadReplayStats: () =>
              Effect.sync(() => {
                headSequence = 100;

                return { eventCount: 1, payloadBytes: 100, hasCreateEvent: false };
              }),
            readThreadEvents: ({ toSequenceInclusive }) => {
              replayHead = toSequenceInclusive;

              return Stream.fromEffect(
                PubSub.publish(liveEvents, {
                  ...messageEvent,
                  sequence: 51,
                  eventId: EventId.make("event-live-after-head"),
                  payload: {
                    ...messageEvent.payload,
                    messageId: MessageId.make("message-live-after-head"),
                  },
                }),
              ).pipe(Stream.flatMap(() => Stream.make(messageEvent)));
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.deepEqual(
        items.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
        [3, 51, "synchronized"],
      );
      assert.equal(replayHead, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread replays a small thread range across a large global gap", () =>
    Effect.gen(function* () {
      const event = makeLiveToolActivityEvent(99_999, "tool.completed");
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(100_000),
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: 1,
                payloadBytes: Buffer.byteLength(jsonRequestBody(event.payload)),
                hasCreateEvent: false,
              }),
            readThreadEvents: () => Stream.make(event),
            readEvents: () => Stream.die("Thread replay must not read the global log"),
          },
          projectionSnapshotQuery: {
            getEventReplayStats: () => Effect.die("Thread replay must not measure the global log"),
            getThreadDetailSnapshot: () =>
              Effect.die("Unrelated activity must not force a snapshot"),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.deepEqual(
        items.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
        [99_999, "synchronized"],
      );
      const first = items[0];
      assertTrue(first?.kind === "event" && first.event.type === "thread.activity-appended");
      assert.equal(first.event.payload.activity.kind, "tool.completed");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeThread resets cached history when its ID is created again", () =>
    Effect.gen(function* () {
      const thread = {
        ...defaultOrchestrationReadModel().threads[0]!,
        title: "Recreated thread",
      };

      let requestedTurnLimit: number | undefined;
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            getThreadReplayStats: () =>
              Effect.succeed({
                eventCount: 3,
                payloadBytes: 1_000,
                hasCreateEvent: true,
              }),
            readThreadEvents: () => Stream.die("A recreated thread must not reuse cached history"),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: (_threadId, options) => {
              requestedTurnLimit = options?.turnLimit;

              return Effect.succeed(Option.some({ snapshotSequence: 5, thread }));
            },
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            afterSequence: 2,
            turnLimit: 1,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      const first = items[0];
      assertTrue(first?.kind === "snapshot");
      assert.equal(first.snapshot.thread.title, "Recreated thread");
      assert.equal(first.snapshot.snapshotSequence, 5);
      assert.equal(requestedTurnLimit, 1);
      assert.deepEqual(items[1], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const { createBeforeDelete, oversized } of [
    { createBeforeDelete: false, oversized: false },
    { createBeforeDelete: true, oversized: false },
    { createBeforeDelete: true, oversized: true },
  ]) {
    it.effect(
      oversized
        ? "keeps the missing-snapshot error when an absent thread exceeds the replay limit"
        : `synchronizes an absent thread and removes its shell after ${createBeforeDelete ? "creation and deletion" : "deletion"}`,
      () =>
        Effect.gen(function* () {
          const store = yield* OrchestrationEventStore;
          const base = makeLiveToolActivityEvent(0, "tool.completed");

          if (createBeforeDelete) {
            const thread = defaultOrchestrationReadModel().threads[0]!;
            yield* store.append({
              ...base,
              eventId: EventId.make(`create-before-final-delete-${oversized}`),
              type: "thread.created",
              payload: {
                threadId: defaultThreadId,
                projectId: thread.projectId,
                title: thread.title,
                modelSelection: thread.modelSelection,
                runtimeMode: thread.runtimeMode,
                interactionMode: thread.interactionMode,
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                createdAt: thread.createdAt,
                updatedAt: thread.updatedAt,
              },
            });
          }

          if (oversized) {
            yield* Effect.forEach(
              Array.from({ length: 1_000 }, (_, index) => index + 1),
              (sequence) => store.append(makeLiveToolActivityEvent(sequence, "tool.completed")),
              { discard: true },
            );
          }

          const deleted = yield* store.append({
            ...base,
            eventId: EventId.make(`deleted-replay-${createBeforeDelete}-${oversized}`),
            type: "thread.deleted",
            payload: { threadId: defaultThreadId, deletedAt: base.occurredAt },
          });

          yield* buildAppUnderTest({
            layers: {
              orchestrationEngine: {
                latestSequence: Effect.succeed(deleted.sequence),
                getThreadReplayStats: ({ threadId, ...range }) =>
                  store.getAggregateReplayStats({
                    ...range,
                    aggregateKind: "thread",
                    aggregateId: threadId,
                  }),
                readThreadEvents: ({ threadId, ...range }) =>
                  store.readAggregateRange({
                    ...range,
                    aggregateKind: "thread",
                    aggregateId: threadId,
                  }),
                readEvents: store.readFromSequence,
              },
              projectionSnapshotQuery: {
                getThreadDetailSnapshot: () => Effect.succeed(Option.none()),
              },
            },
          });
          const wsUrl = yield* getWsServerUrl("/ws");
          yield* Effect.scoped(
            withWsRpcClient(wsUrl, (client) =>
              Effect.gen(function* () {
                const threadResult = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                  threadId: defaultThreadId,
                  afterSequence: 0,
                  requestCompletionMarker: true,
                }).pipe(
                  Stream.takeUntil((item) => item.kind === "synchronized"),
                  Stream.runCollect,
                  Effect.result,
                );

                if (oversized) {
                  assertTrue(Predicate.isTagged(threadResult, "Failure"));
                  assert.equal(threadResult.failure._tag, "OrchestrationGetSnapshotError");
                  assert.equal(
                    threadResult.failure.message,
                    `Chat ${defaultThreadId} was not found`,
                  );

                  return;
                }

                assertTrue(Predicate.isTagged(threadResult, "Success"));
                assert.deepEqual(threadResult.success, [{ kind: "synchronized" }]);

                const shellItems = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
                  afterSequence: 0,
                  requestCompletionMarker: true,
                }).pipe(
                  Stream.takeUntil((item) => item.kind === "synchronized"),
                  Stream.runCollect,
                );

                assert.deepEqual(shellItems, [
                  { kind: "thread-removed", sequence: deleted.sequence, threadId: defaultThreadId },
                  { kind: "synchronized" },
                ]);
              }),
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              OrchestrationEventStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
              NodeHttpServer.layerTest,
            ),
          ),
        ),
    );
  }
});
