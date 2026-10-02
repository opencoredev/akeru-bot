import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ThreadId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { makeDefaultOrchestrationThreadShell } from "./serverTestFixtures.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("subscribeShell sends a fresh snapshot instead of replaying a large gap", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      const snapshotThreadId = ThreadId.make("thread-from-snapshot");
      const now = "2026-01-01T00:00:00.000Z";

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            // Head is far ahead of the client's afterSequence (gap > 1000).
            latestSequence: Effect.succeed(100_000),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;

                return {
                  sequence: 1,
                  eventId: EventId.make("event-should-not-be-read"),
                  aggregateKind: "thread",
                  aggregateId: snapshotThreadId,
                  occurredAt: now,
                  commandId: null,
                  causationEventId: null,
                  correlationId: null,
                  metadata: {},
                  type: "thread.created",
                  payload: {} as never,
                } satisfies OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 100_000,
                bots: [],
                groups: [],
                delegations: [],
                projects: [],
                threads: [makeDefaultOrchestrationThreadShell({ id: snapshotThreadId })],
                updatedAt: now,
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 5,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const [first, second] = Array.from(items);
      // Large gap => fresh snapshot, and the unbounded replay is never started.
      assert.equal(first?.kind, "snapshot");

      if (first?.kind === "snapshot") {
        assert.equal(first.snapshot.threads[0]?.id, snapshotThreadId);
      }

      assert.equal(second?.kind, "synchronized");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell replaces a cursor ahead of the authoritative head", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;

                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                bots: [],
                groups: [],
                delegations: [],
                projects: [],
                threads: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 10 }).pipe(
            Stream.runHead,
          ),
        ),
      );

      assert.equal(Option.getOrThrow(first).kind, "snapshot");
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell coalesces a per-thread burst without stalling other threads", () =>
    Effect.gen(function* () {
      const busyThreadId = ThreadId.make("thread-busy");
      const newThreadId = ThreadId.make("thread-new");
      const now = "2026-01-01T00:00:00.000Z";
      const shellFetches: Array<string> = [];
      let replayLimit: number | undefined;

      const messageEvent = (sequence: number): OrchestrationEvent =>
        ({
          sequence,
          eventId: EventId.make(`event-${sequence}`),
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
        eventId: EventId.make("event-created"),
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
            latestSequence: Effect.succeed(50),
            // A burst of message-sent deltas for the busy thread, plus one
            // thread.created for a different thread, all within one batch.
            readEvents: (_afterSequence, limit) => {
              replayLimit = limit;

              return Stream.fromIterable([
                ...Array.from({ length: 20 }, (_unused, index) => messageEvent(index + 1)),
                createdEvent,
              ]);
            },
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
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      );

      const collected = Array.from(items);

      const upsertedIds = collected.flatMap((item) =>
        item.kind === "thread-upserted" ? [item.thread.id] : [],
      );

      // Both threads surface, and the busy thread's 20-event burst collapses to
      // a single shell refetch (not 20). The new thread is not stuck behind it.
      assert.include(upsertedIds, busyThreadId);
      assert.include(upsertedIds, newThreadId);
      assert.equal(collected[2]?.kind, "synchronized");
      assert.equal(shellFetches.filter((id) => id === busyThreadId).length, 1);
      assert.equal(replayLimit, 50);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
