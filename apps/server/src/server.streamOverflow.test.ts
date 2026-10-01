// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  MessageId,
  type OrchestrationShellStreamItem,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  TurnId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import {
  defaultThreadId,
  makeLiveToolActivityEvent,
  makeDefaultOrchestrationThreadShell,
  makeDefaultOrchestrationReadModel,
  defaultProjectId,
} from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  jsonRequestBody,
  getWsServerUrl,
  createWsRpcClient,
  withFirstWsAckHeld,
  withWsRpcClient,
} from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect(
    "stops an overflowing thread producer without an ACK and replays the missing events",
    () =>
      Effect.gen(function* () {
        const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
        const attached = yield* Deferred.make<void>();
        const detached = yield* Deferred.make<void>();
        const ackHeld = yield* Deferred.make<void>();
        const releaseAck = yield* Deferred.make<void>();
        const firstApplied = yield* Deferred.make<void>();
        const replayStarted = yield* Deferred.make<void>();
        const replayCalls: Array<{ afterSequence: number; headSequence: number }> = [];
        let headSequence = 0;
        let snapshotCalls = 0;

        const message = (sequence: number, text: string) =>
          ({
            sequence,
            eventId: EventId.make(`slow-thread-${sequence}`),
            aggregateKind: "thread",
            aggregateId: defaultThreadId,
            occurredAt: "2026-01-01T00:00:01.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.message-sent",
            payload: {
              threadId: defaultThreadId,
              messageId: MessageId.make(`slow-message-${sequence}`),
              role: "assistant",
              text,
              turnId: TurnId.make("turn-edit"),
              streaming: false,
              createdAt: "2026-01-01T00:00:01.000Z",
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
          }) satisfies OrchestrationEvent;

        const events = [
          message(1, "a".repeat(4 * 1024 * 1024)),
          message(2, "b".repeat(4 * 1024 * 1024)),
          makeLiveToolActivityEvent(3, "tool.completed"),
          message(4, "Finished"),
        ] as const;

        yield* buildAppUnderTest({
          layers: {
            orchestrationEngine: {
              latestSequence: Effect.sync(() => headSequence),
              streamDomainEvents: Stream.unwrap(
                Effect.gen(function* () {
                  const subscription = yield* PubSub.subscribe(liveEvents);
                  yield* Deferred.succeed(attached, undefined);

                  return Stream.fromSubscription(subscription);
                }),
              ).pipe(Stream.ensuring(Deferred.succeed(detached, undefined))),
              readThreadEvents: ({ fromSequenceExclusive, toSequenceInclusive }) => {
                replayCalls.push({
                  afterSequence: fromSequenceExclusive,
                  headSequence: toSequenceInclusive,
                });

                const range = events.filter(
                  (event) =>
                    event.sequence > fromSequenceExclusive && event.sequence <= toSequenceInclusive,
                );

                return Stream.concat(
                  Stream.fromEffect(Deferred.succeed(replayStarted, undefined)).pipe(Stream.drain),
                  Stream.fromIterable(range),
                );
              },
              getThreadReplayStats: ({ fromSequenceExclusive, toSequenceInclusive }) => {
                const range = events.filter(
                  (event) =>
                    event.sequence > fromSequenceExclusive && event.sequence <= toSequenceInclusive,
                );

                return Effect.succeed({
                  eventCount: range.length,
                  payloadBytes: range.reduce(
                    (bytes, event) => bytes + Buffer.byteLength(jsonRequestBody(event.payload)),
                    0,
                  ),
                  hasCreateEvent: false,
                });
              },
            },
            projectionSnapshotQuery: {
              getThreadDetailSnapshot: () =>
                Effect.sync(() => {
                  snapshotCalls += 1;

                  return Option.none();
                }),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");
        yield* createWsRpcClient.pipe(
          Effect.flatMap((client) =>
            Effect.gen(function* () {
              let cursor = 0;
              const received: number[] = [];

              const attempt = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                afterSequence: cursor,
              }).pipe(
                Stream.tap((item) => {
                  if (item.kind !== "event") return Effect.void;
                  cursor = item.event.sequence;
                  received.push(cursor);

                  return Deferred.succeed(firstApplied, undefined);
                }),
                Stream.runDrain,
                Effect.result,
                Effect.forkScoped,
              );

              yield* Deferred.await(attached);
              yield* Deferred.await(replayStarted);
              headSequence = 1;
              yield* PubSub.publish(liveEvents, events[0]!);
              yield* Deferred.await(ackHeld);
              yield* Deferred.await(firstApplied);
              headSequence = 4;
              yield* PubSub.publishAll(liveEvents, events.slice(1));

              // This must finish while the server is still waiting for the first
              // batch's ACK. A failed output queue alone would leave PubSub live.
              yield* Deferred.await(detached);
              assert.equal(yield* PubSub.size(liveEvents), 0);
              assert.deepEqual(received, [1]);
              yield* Deferred.succeed(releaseAck, undefined);
              const result = yield* Fiber.join(attempt);
              assertTrue(Predicate.isTagged(result, "Failure"));
              assert.equal(result.failure._tag, "OrchestrationGetSnapshotError");

              const recovered = yield* client[ORCHESTRATION_WS_METHODS.subscribeThread]({
                threadId: defaultThreadId,
                afterSequence: cursor,
                requestCompletionMarker: true,
              }).pipe(
                Stream.takeUntil((item) => item.kind === "synchronized"),
                Stream.runCollect,
              );

              assert.deepEqual(
                recovered.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
                [2, 3, 4, "synchronized"],
              );
              const first = recovered[0];
              assertTrue(first?.kind === "event" && first.event.type === "thread.message-sent");
              assert.equal(first.event.payload.text, events[1]!.payload.text);
              const completed = recovered[1];
              assertTrue(
                completed?.kind === "event" && completed.event.type === "thread.activity-appended",
              );
              assert.equal(completed.event.payload.activity.kind, "tool.completed");
              assert.deepEqual(replayCalls, [
                { afterSequence: 0, headSequence: 0 },
                { afterSequence: 1, headSequence: 4 },
              ]);
              assert.equal(snapshotCalls, 0);
            }),
          ),
          Effect.provide(withFirstWsAckHeld(wsUrl, ackHeld, releaseAck)),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("stops an overflowing shell producer without an ACK and recovers deleted entries", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const detached = yield* Deferred.make<void>();
      const ackHeld = yield* Deferred.make<void>();
      const releaseAck = yield* Deferred.make<void>();
      let headSequence = 1;
      let snapshotCalls = 0;
      let replayCalls = 0;
      const thread = makeDefaultOrchestrationThreadShell();
      const project = makeDefaultOrchestrationReadModel().projects[0]!;

      const events: OrchestrationEvent[] = Array.from({ length: 1_001 }, (_, index) =>
        makeLiveToolActivityEvent(index + 2, "tool.completed"),
      );

      events.push(
        {
          ...events[0]!,
          sequence: 1_003,
          type: "thread.archived",
          payload: {
            threadId: defaultThreadId,
            archivedAt: "2026-01-01T00:00:02.000Z",
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
        },
        {
          ...events[0]!,
          sequence: 1_004,
          aggregateKind: "project",
          aggregateId: defaultProjectId,
          type: "project.deleted",
          payload: { projectId: defaultProjectId, deletedAt: "2026-01-01T00:00:02.000Z" },
        },
      );
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.sync(() => headSequence),
            streamDomainEvents: Stream.fromPubSub(liveEvents).pipe(
              Stream.ensuring(Deferred.succeed(detached, undefined)),
            ),
            readEvents: () => {
              replayCalls += 1;

              return Stream.empty;
            },
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.sync(() => {
                snapshotCalls += 1;

                return {
                  snapshotSequence: headSequence,
                  bots: [],
                  groups: [],
                  delegations: [],
                  projects: headSequence === 1 ? [project] : [],
                  threads: headSequence === 1 ? [thread] : [],
                  updatedAt: "2026-01-01T00:00:02.000Z",
                };
              }),
          },
        },
      });
      const wsUrl = yield* getWsServerUrl("/ws");
      yield* createWsRpcClient.pipe(
        Effect.flatMap((client) =>
          Effect.gen(function* () {
            const received: OrchestrationShellStreamItem[] = [];

            const attempt = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({}).pipe(
              Stream.tap((item) => Effect.sync(() => received.push(item))),
              Stream.runDrain,
              Effect.result,
              Effect.forkScoped,
            );

            yield* Deferred.await(ackHeld);
            headSequence = 1_004;
            yield* PubSub.publishAll(liveEvents, events);
            yield* Deferred.await(detached);
            assert.equal(yield* PubSub.size(liveEvents), 0);
            yield* Deferred.succeed(releaseAck, undefined);
            const result = yield* Fiber.join(attempt);
            assertTrue(Predicate.isTagged(result, "Failure"));
            assert.equal(result.failure._tag, "OrchestrationGetSnapshotError");
            assert.equal(received.length, 1);
            const initial = received[0];
            assertTrue(initial?.kind === "snapshot");
            assert.equal(initial.snapshot.threads.length, 1);

            const recovered = yield* client[ORCHESTRATION_WS_METHODS.subscribeShell]({
              afterSequence: initial.snapshot.snapshotSequence,
              requestCompletionMarker: true,
            }).pipe(
              Stream.takeUntil((item) => item.kind === "synchronized"),
              Stream.runCollect,
            );

            const snapshot = recovered[0];
            assertTrue(snapshot?.kind === "snapshot");
            assert.equal(snapshot.snapshot.snapshotSequence, 1_004);
            assert.deepEqual(snapshot.snapshot.projects, []);
            assert.deepEqual(snapshot.snapshot.threads, []);
            assert.deepEqual(recovered[1], { kind: "synchronized" });
            assert.equal(snapshotCalls, 2);
            assert.equal(replayCalls, 0);
          }),
        ),
        Effect.provide(withFirstWsAckHeld(wsUrl, ackHeld, releaseAck)),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscriptions snapshot instead of decoding an oversized replay range", () =>
    Effect.gen(function* () {
      let readEventsCalls = 0;
      let replayStatsCalls = 0;
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const shell = makeDefaultOrchestrationThreadShell({ id: thread.id });

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            getThreadReplayStats: () =>
              Effect.sync(() => {
                replayStatsCalls += 1;

                return {
                  eventCount: 5,
                  payloadBytes: 8 * 1024 * 1024 + 1,
                  hasCreateEvent: false,
                };
              }),
            readThreadEvents: () => {
              readEventsCalls += 1;

              return Stream.empty;
            },
            readEvents: () =>
              Stream.sync(() => {
                readEventsCalls += 1;

                return {} as OrchestrationEvent;
              }),
          },
          projectionSnapshotQuery: {
            getEventReplayStats: () =>
              Effect.sync(() => {
                replayStatsCalls += 1;

                return { eventCount: 5, payloadBytes: 8 * 1024 * 1024 + 1 };
              }),
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 5, thread })),
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 5,
                bots: [],
                groups: [],
                delegations: [],
                projects: [],
                threads: [shell],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const threadItems = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: thread.id,
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      const shellItems = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(threadItems[0]?.kind, "snapshot");
      assert.equal(threadItems[1]?.kind, "synchronized");
      assert.equal(shellItems[0]?.kind, "snapshot");
      assert.equal(shellItems[1]?.kind, "synchronized");
      assert.equal(replayStatsCalls, 2);
      assert.equal(readEventsCalls, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
