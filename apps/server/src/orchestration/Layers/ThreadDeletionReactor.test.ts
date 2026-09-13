import { it as effectIt } from "@effect/vitest";
import { EventId, ThreadId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { AgentController } from "../../provider/Services/AgentController.ts";
import { ServerActivation } from "../../serverActivation.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

describe("ThreadDeletionReactor.start", () => {
  effectIt.effect(
    "queues delete/recreate published while parked and drains cleanup after activation",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-deletion-parked-recreate");
        const stoppedThreadIds: ThreadId[] = [];
        const closedThreadIds: ThreadId[] = [];
        const activation = yield* Deferred.make<void>();
        const eventPubSub = yield* PubSub.unbounded<OrchestrationEvent>();
        let latestSequence = 0;

        const publish = (event: OrchestrationEvent) =>
          Effect.sync(() => {
            latestSequence = event.sequence;
          }).pipe(Effect.andThen(PubSub.publish(eventPubSub, event)));

        const engine: OrchestrationEngineService["Service"] = {
          readEvents: () => Stream.die("unused"),
          dispatch: () => Effect.die("unused"),
          get streamDomainEvents() {
            return Stream.die(
              "ThreadDeletionReactor.start should subscribe before parking",
            ) as Stream.Stream<OrchestrationEvent>;
          },
          subscribeDomainEvents: PubSub.subscribe(eventPubSub).pipe(
            Effect.map(Stream.fromSubscription),
          ),
          latestSequence: Effect.sync(() => latestSequence),
        };

        yield* Effect.gen(function* () {
          const reactor = yield* ThreadDeletionReactor;
          yield* reactor.start();

          yield* publish({
            sequence: 1,
            eventId: EventId.make("event-parked-deleted"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-01-01T00:00:01.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.deleted",
            payload: {
              threadId,
              deletedAt: "2026-01-01T00:00:01.000Z",
            },
          });
          yield* publish({
            sequence: 2,
            eventId: EventId.make("event-parked-created"),
            aggregateKind: "thread",
            aggregateId: threadId,
            occurredAt: "2026-01-01T00:00:02.000Z",
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "thread.created",
            payload: {} as never,
          });

          expect(stoppedThreadIds).toEqual([]);
          expect(closedThreadIds).toEqual([]);

          yield* Deferred.succeed(activation, undefined);
          yield* reactor.drainThrough(2);

          expect(stoppedThreadIds).toEqual([threadId]);
          expect(closedThreadIds).toEqual([threadId]);
        }).pipe(
          Effect.provideService(ServerActivation, Deferred.await(activation)),
          Effect.provide(
            ThreadDeletionReactorLive.pipe(
              Layer.provide(Layer.succeed(OrchestrationEngineService, engine)),
              Layer.provide(
                Layer.mock(AgentController)({
                  stopSession: (input) =>
                    Effect.sync(() => {
                      stoppedThreadIds.push(input.threadId);
                    }),
                }),
              ),
              Layer.provide(
                Layer.mock(TerminalManager.TerminalManager)({
                  close: (input) =>
                    Effect.sync(() => {
                      closedThreadIds.push(ThreadId.make(input.threadId));
                    }),
                }),
              ),
            ),
          ),
        );
      }).pipe(Effect.scoped),
  );
});
