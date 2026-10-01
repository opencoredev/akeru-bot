// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type AkeruDelegationRecord,
  BotId,
  DelegationId,
  EventId,
  MessageId,
  type OrchestrationEvent,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { toShellDelegation } from "./orchestration/ShellDelegations.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";
import {
  makeDefaultOrchestrationReadModel,
  defaultThreadId,
  makeDefaultOrchestrationThreadShell,
  makeLiveToolActivityEvent,
} from "./serverTestFixtures.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("marks an empty shell catch-up replay as synchronized when requested", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            readEvents: () => Stream.empty,
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const firstItem = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(Stream.runHead),
        ),
      );

      assert.deepEqual(Option.getOrThrow(firstItem), { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("subscribeShell keeps sparse replay below the captured head", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();
      const now = "2026-01-01T00:00:00.000Z";
      const replayProjectId = ProjectId.make("project-replayed");
      const liveProjectId = ProjectId.make("project-live");

      const projectDeleted = (sequence: number, projectId: ProjectId): OrchestrationEvent => ({
        sequence,
        eventId: EventId.make(`event-project-deleted-${sequence}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.deleted",
        payload: { projectId, deletedAt: now },
      });

      const replayed = projectDeleted(1, replayProjectId);
      const newer = projectDeleted(6, liveProjectId);
      let replayHead: number | undefined;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(5),
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            readEvents: (_afterSequence, _limit, toSequenceInclusive) => {
              replayHead = toSequenceInclusive;

              return Stream.fromEffect(PubSub.publish(liveEvents, newer)).pipe(
                Stream.flatMap(() =>
                  Stream.fromIterable(
                    [replayed, newer].filter(
                      (event) =>
                        toSequenceInclusive === undefined || event.sequence <= toSequenceInclusive,
                    ),
                  ),
                ),
              );
            },
          },
          projectionSnapshotQuery: {
            getEventReplayStats: () => Effect.succeed({ eventCount: 1, payloadBytes: 100 }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            afterSequence: 0,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.deepEqual(
        items.map((item) => ("sequence" in item ? item.sequence : item.kind)),
        [1, 6, "synchronized"],
      );
      assert.equal(replayHead, 5);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("maps delegation lifecycle events into shell upserts", () =>
    Effect.gen(function* () {
      const now = "2026-08-31T00:00:00.000Z";

      const record = (delegationId: DelegationId): AkeruDelegationRecord => ({
        delegationId,
        parentDelegationId: null,
        parentBotId: BotId.make("bot-parent"),
        childBotId: BotId.make("bot-child"),
        parentThreadId: ThreadId.make("thread-parent"),
        parentTurnId: TurnId.make("turn-parent"),
        ancestorBotIds: [BotId.make("bot-parent")],
        depth: 1,
        task: "Compare the release options.",
        expectedResult: "A short comparison.",
        deadline: null,
        access: {
          allowedToolIds: ["Read"],
          memoryScopes: [],
          sandbox: "local",
          runtimeMode: "approval-required",
          hasUserComputer: false,
          enabledMcpServerIds: [],
          disabledMcpServerIds: [],
          approvalCeiling: "none",
        },
        phase: { _tag: "Queued" },
        billedBotId: BotId.make("bot-child"),
        keep: false,
        anchorMessageId: null,
        retryOfDelegationId: null,
        trigger: "bot" as const,
        createdAt: now,
        updatedAt: now,
      });

      const created = record(DelegationId.make("delegation-created"));

      const updated: AkeruDelegationRecord = {
        ...record(DelegationId.make("delegation-updated")),
        phase: {
          _tag: "Completed",
          childThreadId: ThreadId.make("thread-child"),
          childTurnId: null,
          startedAt: now,
          completedAt: now,
          result: {
            summary: "y".repeat(10_000),
            childThreadId: ThreadId.make("thread-child"),
            childTurnId: null,
          },
          acknowledgedAt: null,
        },
      };

      const events = [
        {
          sequence: 1,
          eventId: EventId.make("event-delegation-created"),
          aggregateKind: "delegation",
          aggregateId: created.delegationId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "delegation.created",
          payload: { delegation: created },
        } satisfies Extract<OrchestrationEvent, { type: "delegation.created" }>,
        {
          sequence: 2,
          eventId: EventId.make("event-delegation-updated"),
          aggregateKind: "delegation",
          aggregateId: updated.delegationId,
          occurredAt: now,
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "delegation.updated",
          payload: { delegation: updated },
        } satisfies Extract<OrchestrationEvent, { type: "delegation.updated" }>,
      ];

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            latestSequence: Effect.succeed(2),
            readEvents: () => Stream.fromIterable(events),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({ afterSequence: 0 }).pipe(
            Stream.take(2),
            Stream.runCollect,
          ),
        ),
      );

      // Streamed upserts carry the same capped result text as the shell snapshot.
      assert.deepEqual(Array.from(items), [
        { kind: "delegation-upserted", sequence: 1, delegation: created },
        { kind: "delegation-upserted", sequence: 2, delegation: toShellDelegation(updated) },
      ]);
      const streamedUpdate = Array.from(items)[1];
      assert.isTrue(
        streamedUpdate?.kind === "delegation-upserted" &&
          Predicate.isTagged(streamedUpdate.delegation.phase, "Completed") &&
          streamedUpdate.delegation.phase.result.summary.length < 10_000,
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("marks a socket thread snapshot as synchronized when requested", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.succeed(Option.some({ snapshotSequence: 1, thread })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.deepEqual(items[1], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("buffers shell events published while the fallback snapshot loads", () =>
    Effect.gen(function* () {
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      const deletedEvent = {
        sequence: 2,
        eventId: EventId.make("event-shell-thread-deleted"),
        aggregateKind: "thread",
        aggregateId: defaultThreadId,
        occurredAt: "2026-01-01T00:00:01.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.deleted",
        payload: {
          threadId: defaultThreadId,
          deletedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(liveEvents)),
          },
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, deletedEvent);

                return {
                  snapshotSequence: 1,
                  bots: [],
                  groups: [],
                  delegations: [],
                  projects: [],
                  threads: [makeDefaultOrchestrationThreadShell()],
                  updatedAt: "2026-01-01T00:00:00.000Z",
                };
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeShell]({
            requestCompletionMarker: true,
          }).pipe(Stream.take(3), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "thread-removed");
      assert.deepEqual(items[2], { kind: "synchronized" });
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );

  it.effect("buffers thread events published while the initial snapshot loads", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      const messageEvent = {
        sequence: 2,
        eventId: EventId.make("event-message"),
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
          messageId: MessageId.make("message-1"),
          role: "user",
          text: "First message",
          turnId: null,
          streaming: false,
          createdAt: "2026-01-01T00:00:01.000Z",
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      } satisfies Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(liveEvents)),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* PubSub.publish(liveEvents, messageEvent);

                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
            requestCompletionMarker: true,
          }).pipe(
            Stream.takeUntil((item) => item.kind === "synchronized"),
            Stream.runCollect,
          ),
        ),
      );

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 2);
      assert.equal(items[2]?.kind, "synchronized");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("coalesces buffered live tool updates before websocket delivery", () =>
    Effect.gen(function* () {
      const thread = makeDefaultOrchestrationReadModel().threads[0]!;
      const liveEvents = yield* PubSub.unbounded<OrchestrationEvent>();

      yield* buildAppUnderTest({
        layers: {
          orchestrationEngine: {
            streamDomainEvents: Stream.fromPubSub(liveEvents),
            subscribeDomainEvents: Effect.succeed(Stream.fromPubSub(liveEvents)),
          },
          projectionSnapshotQuery: {
            getThreadDetailSnapshot: () =>
              Effect.gen(function* () {
                yield* Effect.sleep("25 millis");
                yield* PubSub.publishAll(liveEvents, [
                  makeLiveToolActivityEvent(2),
                  makeLiveToolActivityEvent(3),
                  makeLiveToolActivityEvent(4),
                ]);

                return Option.some({ snapshotSequence: 1, thread });
              }),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const items = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.subscribeThread]({
            threadId: defaultThreadId,
          }).pipe(Stream.take(2), Stream.runCollect),
        ),
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(items[0]?.kind, "snapshot");
      assert.equal(items[1]?.kind, "event");
      assert.equal(items[1]?.kind === "event" ? items[1].event.sequence : null, 4);
    }).pipe(Effect.provide(NodeHttpServer.layerTest), TestClock.withLive),
  );
});
