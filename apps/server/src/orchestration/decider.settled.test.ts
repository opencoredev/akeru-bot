import {
  CommandId,
  EventId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@akeru/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";
import {
  makeReadModel,
  SETTLED_AT,
  NOW,
  createSession,
} from "./test-support/SettledDeciderFixtures.ts";

it.layer(NodeServices.layer)("settled thread decider", (it) => {
  it.effect("settles awake threads without a redundant wake and re-emits idempotently", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null),
      });
      const events = Array.isArray(event) ? event : [event];
      expect(events).toHaveLength(1);
      expect(events[0]?.type).toBe("thread.settled");
      if (events[0]?.type === "thread.settled") {
        expect(events[0].payload.settledAt).toBe(events[0].payload.updatedAt);
      }

      // Already settled: the engine rejects zero-event commands, so idempotency
      // is by re-emission — preserving the original settledAt.
      const reEmit = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel("settled"),
      });
      const reEmitEvents = Array.isArray(reEmit) ? reEmit : [reEmit];
      expect(reEmitEvents).toHaveLength(1);
      expect(reEmitEvents[0]?.type).toBe("thread.settled");
      if (reEmitEvents[0]?.type === "thread.settled") {
        expect(reEmitEvents[0].payload.settledAt).toBe(SETTLED_AT);
        // updatedAt must NOT rewind to the historical settledAt: sorting and
        // relative-time labels key on it.
        expect(reEmitEvents[0].payload.updatedAt).not.toBe(SETTLED_AT);
      }
    }),
  );

  it.effect("settling a snoozed thread also wakes it", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-snoozed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [], {
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual(["thread.settled", "thread.unsnoozed"]);
      const settled = events.find((entry) => entry.type === "thread.settled");
      const unsnoozed = events.find((entry) => entry.type === "thread.unsnoozed");
      if (settled?.type === "thread.settled" && unsnoozed?.type === "thread.unsnoozed") {
        expect(unsnoozed.payload.reason).toBe("user");
        expect(unsnoozed.payload.updatedAt).toBe(settled.payload.updatedAt);
      }
    }),
  );

  it.effect("repeated settle repairs legacy settled and snoozed state", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-snoozed-again"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel("settled", null, null, [], [], {
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual(["thread.settled", "thread.unsnoozed"]);
      const settled = events.find((entry) => entry.type === "thread.settled");
      const unsnoozed = events.find((entry) => entry.type === "thread.unsnoozed");
      if (settled?.type === "thread.settled" && unsnoozed?.type === "thread.unsnoozed") {
        expect(settled.payload.settledAt).toBe(SETTLED_AT);
        expect(settled.payload.updatedAt).toBe(NOW);
        expect(unsnoozed.payload.updatedAt).not.toBe(NOW);
      }
    }),
  );

  it.effect("settling a pinned and snoozed thread clears the pin and snooze", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pinned-snoozed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [], {
          pinnedAt: SETTLED_AT,
          snoozedUntil: "1970-01-02T09:00:00.000Z",
        }),
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((entry) => entry.type)).toEqual([
        "thread.settled",
        "thread.unpinned",
        "thread.unsnoozed",
      ]);
    }),
  );

  it.effect("rejects settling a thread with a live session", () =>
    Effect.gen(function* () {
      for (const status of ["starting", "running"] as const) {
        const error = yield* decideOrchestrationCommand({
          command: {
            type: "thread.settle",
            commandId: CommandId.make(`cmd-settle-live-${status}`),
            threadId: ThreadId.make("thread-1"),
          },
          readModel: makeReadModel(null, null, createSession(status)),
        }).pipe(Effect.flip);
        expect(error._tag).toBe("OrchestrationCommandInvariantError");
      }
      // Stopped/error sessions are settleable — only live work is protected.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stopped"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, createSession("stopped")),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects settling a thread with an open approval or user-input request", () =>
    Effect.gen(function* () {
      const requestActivity = (kind: string, requestId: string, at: string) =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId },
          turnId: null,
          createdAt: at,
        }) as OrchestrationThread["activities"][number];

      // Open approval request: settle rejected.
      const openError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(openError._tag).toBe("OrchestrationCommandInvariantError");

      // Same request later resolved: settleable again.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-resolved"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("approval.requested", "req-1", NOW),
          requestActivity("approval.resolved", "req-1", NOW),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // Open user-input request: also rejected.
      const inputError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-pending-input"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          requestActivity("user-input.requested", "req-2", NOW),
        ]),
      }).pipe(Effect.flip);
      expect(inputError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("clears an open request when its respond failure marks it stale", () =>
    Effect.gen(function* () {
      const activity = (
        kind: string,
        requestId: string,
        payload: Record<string, unknown>,
      ): OrchestrationThread["activities"][number] =>
        ({
          id: EventId.make(`activity-${requestId}-${kind}`),
          tone: "approval" as const,
          kind,
          summary: kind,
          payload: { requestId, ...payload },
          turnId: null,
          createdAt: NOW,
        }) as OrchestrationThread["activities"][number];

      // Stale-failure detail clears the request — mirrors the projection's
      // pending accounting, which is what the client's canSettle sees.
      const settled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-stale-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-1", {}),
          activity("provider.approval.respond.failed", "req-1", {
            detail: "Unknown pending approval request req-1",
          }),
          activity("user-input.requested", "req-2", {}),
          activity("provider.user-input.respond.failed", "req-2", {
            detail: "stale pending user-input request req-2",
          }),
        ]),
      });
      const settledEvents = Array.isArray(settled) ? settled : [settled];
      expect(settledEvents[0]?.type).toBe("thread.settled");

      // A non-stale respond failure (transient provider error) keeps the
      // request open: the user can retry, so it is still blocked-on-you.
      const stillOpen = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-transient-failed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [
          activity("approval.requested", "req-3", {}),
          activity("provider.approval.respond.failed", "req-3", {
            detail: "provider connection reset",
          }),
        ]),
      }).pipe(Effect.flip);
      expect(stillOpen._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("bounds the queued-turn grace window against client clock skew", () =>
    Effect.gen(function* () {
      const userMessage = (createdAt: string): OrchestrationThread["messages"][number] => ({
        id: MessageId.make("message-queued"),
        role: "user",
        text: "Continue",
        turnId: null,
        streaming: false,
        createdAt,
        updatedAt: createdAt,
      });

      // The decider's clock is the Effect test clock, pinned to the epoch:
      // timestamps here are relative to 1970-01-01T00:00:00.000Z.

      // Within the grace window: genuinely queued, settle rejected.
      const queuedError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-queued"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1969-12-31T23:59:30.000Z")]),
      }).pipe(Effect.flip);
      expect(queuedError._tag).toBe("OrchestrationCommandInvariantError");

      // Message timestamp far in the FUTURE (client clock ahead of server):
      // a negative age must not read as queued forever — past the grace
      // bound in either direction the thread is settleable.
      const skewed = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-skewed"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, null, null, [], [userMessage("1970-01-01T01:00:00.000Z")]),
      });
      const skewedEvents = Array.isArray(skewed) ? skewed : [skewed];
      expect(skewedEvents[0]?.type).toBe("thread.settled");
    }),
  );

  it.effect("rejects settling and unsettling archived threads", () =>
    Effect.gen(function* () {
      const settleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.settle",
          commandId: CommandId.make("cmd-settle-archived"),
          threadId: ThreadId.make("thread-1"),
        },
        readModel: makeReadModel(null, NOW),
      }).pipe(Effect.flip);
      expect(settleError._tag).toBe("OrchestrationCommandInvariantError");

      const unsettleError = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-archived"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled", NOW),
      }).pipe(Effect.flip);
      expect(unsettleError._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );

  it.effect("maps unsettle reasons to overrides and re-emits idempotently", () =>
    Effect.gen(function* () {
      const userEvent = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("settled"),
      });
      const userEvents = Array.isArray(userEvent) ? userEvent : [userEvent];
      expect(userEvents).toHaveLength(1);
      expect(userEvents[0]?.type).toBe("thread.unsettled");
      if (userEvents[0]?.type === "thread.unsettled") {
        expect(userEvents[0].payload.reason).toBe("user");
      }

      // Re-dispatching against the already-reached state re-emits rather than
      // producing zero events (the engine rejects empty commands).
      const userAgain = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-user-again"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel: makeReadModel("active"),
      });
      const userAgainEvents = Array.isArray(userAgain) ? userAgain : [userAgain];
      expect(userAgainEvents).toHaveLength(1);
      expect(userAgainEvents[0]?.type).toBe("thread.unsettled");
    }),
  );

  // Command-to-projection: an accepted un-settle must land as the re-entry
  // stamp clients sort by (max of createdAt and unsettledAt, see
  // activeThreadAnchorTimestampMs in client-runtime), so the thread surfaces
  // above threads created after it. The projector tests feed events directly;
  // this one proves the decider actually emits what they consume.
  it.effect("an accepted un-settle re-anchors the thread for the active list", () =>
    Effect.gen(function* () {
      const readModel = makeReadModel("settled");
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("cmd-unsettle-anchor"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        readModel,
      });
      const events = Array.isArray(result) ? result : [result];
      const unsettled = events[0]!;
      expect(unsettled.type).toBe("thread.unsettled");

      const projected = yield* projectEvent(readModel, {
        ...unsettled,
        sequence: readModel.snapshotSequence + 1,
      } as OrchestrationEvent);
      const thread = projected.threads[0]!;
      expect(thread.settledOverride).toBe("active");
      // The stamp is the decider's accept time: every thread created before
      // the un-settle anchors below it.
      expect(thread.unsettledAt).toBe(unsettled.occurredAt);
      if (unsettled.type === "thread.unsettled") {
        expect(thread.unsettledAt).toBe(unsettled.payload.updatedAt);
      }
    }),
  );
});
