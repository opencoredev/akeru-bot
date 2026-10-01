// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type OrchestrationShellStreamItem,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { PersistenceSqlError } from "./persistence/Errors.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { makeDefaultOrchestrationThreadShell } from "./serverTestFixtures.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("subscribeShell coalesces live bursts after the synchronization marker", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-live-busy");
      const newThreadId = ThreadId.make("thread-live-new");
      const now = "2026-01-01T00:00:00.000Z";
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const synchronized = yield* Deferred.make<void>();
      const shellFetches: Array<string> = [];
      const observedLiveThreadIds = new Set<string>();

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-live-${sequence}`),
          aggregateKind: "thread",
          aggregateId: busyThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.message-sent",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      const createdEvent: OrchestrationEvent = {
        sequence: 50,
        eventId: EventId.make("event-live-created"),
        aggregateKind: "thread",
        aggregateId: newThreadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.created",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(liveEvents)),
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);

                return Option.some(makeDefaultOrchestrationThreadShell({ id: threadId }));
              }),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        Effect.gen(function* () {
          const itemsFiber = yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(
              Stream.tap((item) =>
                item.kind === "synchronized"
                  ? Deferred.succeed(synchronized, undefined).pipe(Effect.ignore)
                  : Effect.void,
              ),
              Stream.takeUntil((item) => {
                if (item.kind === "thread-upserted") {
                  observedLiveThreadIds.add(item.thread.id);
                }

                return (
                  observedLiveThreadIds.has(busyThreadId) && observedLiveThreadIds.has(newThreadId)
                );
              }),
              Stream.runCollect,
            ),
          ).pipe(Effect.forkScoped);

          yield* Deferred.await(synchronized);

          for (const event of [
            ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
            createdEvent,
          ]) {
            yield* PubSub.publish(liveEvents, event);
          }

          return yield* Fiber.join(itemsFiber);
        }),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "synchronized");

      const liveUpsertedIds = Array.from(items)
        .slice(2)
        .flatMap((item) => (item.kind === "thread-upserted" ? [item.thread.id] : []));

      assert.include(liveUpsertedIds, busyThreadId);
      assert.include(liveUpsertedIds, newThreadId);
      assert.isBelow(shellFetches.filter((id) => id === busyThreadId).length, 20);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeShell skips a thread upsert whose shell did not change", () =>
    Effect.gen(function* () {
      const quietThreadId = ThreadId.make("thread-dedupe-quiet");
      const otherThreadId = ThreadId.make("thread-dedupe-other");
      const now = "2026-01-01T00:00:00.000Z";
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const received = yield* Queue.unbounded<OrchestrationShellStreamItem>();
      const shellFetches: Array<string> = [];
      let quietTitle = "Quiet";

      const threadEvent = (sequence: number, threadId: ThreadId): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-dedupe-${sequence}`),
          aggregateKind: "thread",
          aggregateId: threadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "thread.turn-diff-completed",
          payload: {} as never,
        }) satisfies OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(liveEvents)),
          },
          projectionSnapshotQuery: {
            getThreadShellById: (threadId) =>
              Effect.sync(() => {
                shellFetches.push(threadId);

                return Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    title: threadId === quietThreadId ? quietTitle : "Other",
                  }),
                );
              }),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const upsertedIds = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              requestCompletionMarker: true,
            }).pipe(Stream.runForEach((item) => Queue.offer(received, item))),
          ).pipe(Effect.forkScoped);

          const takeUpsert = Effect.gen(function* () {
            while (true) {
              const item = yield* Queue.take(received);

              if (item.kind === "thread-upserted") {
                return `${item.thread.id}:${item.thread.title}@${item.sequence}`;
              }
            }
          });

          const waitForSynchronized = Effect.gen(function* () {
            while ((yield* Queue.take(received)).kind !== "synchronized") {}
          });

          yield* waitForSynchronized;
          yield* PubSub.publish(liveEvents, threadEvent(1, quietThreadId));
          const first = yield* takeUpsert;
          // Same shell again: refetched, then dropped. The other thread's
          // upsert must be the next item the client sees.
          yield* PubSub.publish(liveEvents, threadEvent(2, quietThreadId));
          yield* PubSub.publish(liveEvents, threadEvent(3, otherThreadId));
          const second = yield* takeUpsert;
          // A real change is still sent.
          quietTitle = "Quiet renamed";
          yield* PubSub.publish(liveEvents, threadEvent(4, quietThreadId));
          const third = yield* takeUpsert;
          // An unchanged shell is re-sent once the client's cursor would lag
          // 500 events behind, so reconnects stay inside the replay window.
          yield* PubSub.publish(liveEvents, threadEvent(504, quietThreadId));
          const fourth = yield* takeUpsert;

          return [first, second, third, fourth];
        }),
      );

      assert.deepEqual(upsertedIds, [
        `${quietThreadId}:Quiet@1`,
        `${otherThreadId}:Other@3`,
        `${quietThreadId}:Quiet renamed@4`,
        `${quietThreadId}:Quiet renamed@504`,
      ]);
      assert.equal(shellFetches.filter((id) => id === quietThreadId).length, 4);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("subscribeShell coalescing still emits a removal for a deleted thread", () =>
    Effect.gen(function* () {
      const goneThreadId = ThreadId.make("thread-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeThreadEvent = (
        sequence: number,
        type: "thread.deleted" | "thread.message-sent",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
          aggregateKind: "thread",
          aggregateId: goneThreadId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload: type === "thread.deleted" ? { threadId: goneThreadId, deletedAt: now } : {},
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            // A thread.deleted followed, within the same coalescing window, by a
            // later refetchable event for the same thread. The later event wins
            // coalescing; its shell refetch returns none (the row is gone), which
            // must still surface a removal rather than be swallowed.
            readEvents: () =>
              Stream.fromIterable([
                makeThreadEvent(1, "thread.deleted"),
                makeThreadEvent(2, "thread.message-sent"),
              ]),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () => Effect.succeed(Option.none()),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-removed");
      assert.equal(first?.kind === "thread-removed" ? first.threadId : null, goneThreadId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell retries a transient shell projection refetch failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-transient-refetch");
      const now = "2026-01-01T00:00:00.000Z";
      let attempts = 0;

      const event: OrchestrationEvent = {
        sequence: 1,
        eventId: EventId.make("event-transient-refetch"),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.message-sent",
        payload: {} as never,
      };

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(1),
            readEvents: () => Stream.make(event),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.suspend(() => {
                attempts += 1;

                return attempts === 1
                  ? Effect.fail(
                      new PersistenceSqlError({
                        operation: "test.shell-refetch",
                        detail: "transient failure",
                      }),
                    )
                  : Effect.succeed(
                      Option.some(makeDefaultOrchestrationThreadShell({ id: threadId })),
                    );
              }),
            getThreadRuntimeContext: () => Effect.die("unused"),
            getTurnStartMessage: () => Effect.die("unused"),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "thread-upserted");
      assert.equal(first?.kind === "thread-upserted" ? first.thread.id : null, threadId);
      assert.equal(attempts, 2);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalescing still removes a project after a trailing update", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-gone");
      const now = "2026-01-01T00:00:00.000Z";

      const makeProjectEvent = (
        sequence: number,
        type: "project.deleted" | "project.meta-updated",
      ): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-project-${sequence}`),
          aggregateKind: "project",
          aggregateId: projectId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type,
          payload:
            type === "project.deleted"
              ? { projectId, deletedAt: now }
              : { projectId, title: "Still deleted", updatedAt: now },
        }) as OrchestrationEvent;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: () =>
              Stream.fromIterable([
                makeProjectEvent(1, "project.deleted"),
                makeProjectEvent(2, "project.meta-updated"),
              ]),
          },
          projectionSnapshotQuery: {
            getProjectShellById: () => Effect.succeed(Option.none()),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(1),
            Stream.runCollect,
          ),
        ),
      );

      const [first] = Array.from(items);
      assert.equal(first?.kind, "project-removed");
      assert.equal(first?.kind === "project-removed" ? first.projectId : null, projectId);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
