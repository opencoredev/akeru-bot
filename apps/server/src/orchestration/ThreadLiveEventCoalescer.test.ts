import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  OrchestrationEvent,
  type OrchestrationThreadActivity,
} from "@akeru/contracts";
import { it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { assert, describe, expect } from "vite-plus/test";

import {
  coalesceLiveStreamingMessageEvents,
  coalesceLiveToolUpdatedEvents,
  threadLiveEventCoalescer,
} from "./ThreadLiveEventCoalescer.ts";

const threadId = ThreadId.make("thread-coalescer-test");

const turnId = TurnId.make("turn-coalescer-test");

const encodeEvent = Schema.encodeSync(Schema.fromJsonString(OrchestrationEvent));

function makeToolActivity(
  sequence: number,
  options: {
    readonly kind?: "tool.updated" | "tool.completed";
    readonly toolCallId?: string;
    readonly turnId?: TurnId;
  } = {},
): OrchestrationEvent {
  const {
    kind = "tool.updated",
    toolCallId = "call-edit",
    turnId: activityTurnId = turnId,
  } = options;

  const activity: OrchestrationThreadActivity = {
    id: EventId.make(`activity-${sequence}`),
    tone: "tool",
    kind,
    summary: "Editing app.ts",
    payload: {
      itemType: "file_change",
      title: "Editing app.ts",
      data: toolCallId ? { toolCallId } : {},
    },
    turnId: activityTurnId,
    createdAt: "2026-01-01T00:00:01.000Z",
  };

  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-01-01T00:00:01.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.activity-appended",
    payload: { threadId, activity },
  };
}

function makeMessage(
  sequence: number,
  text = "Still working",
  options: {
    readonly messageId?: MessageId;
    readonly streaming?: boolean;
    readonly createdAt?: string;
    readonly updatedAt?: string;
  } = {},
): OrchestrationEvent {
  const createdAt = options.createdAt ?? "2026-01-01T00:00:02.000Z";

  return {
    sequence,
    eventId: EventId.make(`event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: createdAt,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: options.messageId ?? MessageId.make(`message-${sequence}`),
      role: "assistant",
      text,
      turnId,
      streaming: options.streaming === true,
      createdAt,
      updatedAt: options.updatedAt ?? createdAt,
    },
  };
}

describe("ThreadLiveEventCoalescer", () => {
  it("coalesces only calls with a stable toolCallId", () => {
    const events = [
      makeToolActivity(1, { toolCallId: "call-a" }),
      makeToolActivity(2, { toolCallId: "call-b" }),
      makeToolActivity(3, { toolCallId: "call-a" }),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3]);
  });

  it("preserves parallel same-label calls without a stable toolCallId", () => {
    const events = [
      makeToolActivity(1, { toolCallId: "" }),
      makeToolActivity(2, { toolCallId: "" }),
      makeToolActivity(3, { kind: "tool.completed", toolCallId: "" }),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2, 3]);
  });

  it("does not coalesce stable tool calls across turns", () => {
    const events = [
      makeToolActivity(1, { turnId: TurnId.make("turn-old") }),
      makeToolActivity(2, { turnId: TurnId.make("turn-new") }),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([1, 2]);
  });

  it("flushes a stable update run before a completion boundary", () => {
    const events = [
      makeToolActivity(1),
      makeToolActivity(2),
      makeToolActivity(3, { kind: "tool.completed" }),
      makeToolActivity(4),
    ];

    expect(coalesceLiveToolUpdatedEvents(events).map((event) => event.sequence)).toEqual([2, 3, 4]);
  });

  it("concatenates streaming message deltas for the same message id", () => {
    const messageId = MessageId.make("message-stream");

    const events = [
      makeMessage(1, "Hello", { messageId, streaming: true, createdAt: "2026-01-01T00:00:01.000Z" }),
      makeMessage(2, ", ", {
        messageId,
        streaming: true,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:02.000Z",
      }),
      makeMessage(3, "world", {
        messageId,
        streaming: true,
        createdAt: "2026-01-01T00:00:01.000Z",
        updatedAt: "2026-01-01T00:00:03.000Z",
      }),
      makeMessage(4, "Done.", { messageId, streaming: false }),
    ];

    const coalesced = coalesceLiveStreamingMessageEvents(events);
    expect(coalesced).toHaveLength(2);
    expect(coalesced[0]?.sequence).toBe(3);
    assert(coalesced[0]?.type === "thread.message-sent");
    expect(coalesced[0].payload.text).toBe("Hello, world");
    expect(coalesced[0].payload.createdAt).toBe("2026-01-01T00:00:01.000Z");
    expect(coalesced[0].payload.updatedAt).toBe("2026-01-01T00:00:03.000Z");
    expect(coalesced[1]?.sequence).toBe(4);
  });

  it("keeps streaming deltas for different message ids distinct", () => {
    const events = [
      makeMessage(1, "A", { messageId: MessageId.make("msg-a"), streaming: true }),
      makeMessage(2, "B", { messageId: MessageId.make("msg-b"), streaming: true }),
      makeMessage(3, "a", { messageId: MessageId.make("msg-a"), streaming: true }),
    ];

    const coalesced = coalesceLiveStreamingMessageEvents(events);
    expect(coalesced.map((event) => event.sequence)).toEqual([3, 2]);
    assert(coalesced[0]?.type === "thread.message-sent");
    expect(coalesced[0].payload.text).toBe("Aa");
    assert(coalesced[1]?.type === "thread.message-sent");
    expect(coalesced[1].payload.text).toBe("B");
  });

  it.effect("flushes pending tool updates as soon as an unrelated event arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* threadLiveEventCoalescer({ coalesceWindow: "500 millis" });
        const startedAt = yield* Clock.currentTimeMillis;
        yield* Effect.forEach(
          Array.from({ length: 10 }, (_, index) => index + 2),
          (sequence) => coalescer.offer({ kind: "event", event: makeToolActivity(sequence) }),
          { discard: true },
        );
        yield* coalescer.offer({ kind: "event", event: makeMessage(12) });

        expect(yield* Clock.currentTimeMillis).toBe(startedAt);
        expect(
          (yield* coalescer.stream.pipe(Stream.take(2), Stream.runCollect)).map((item) =>
            item.kind === "event" ? item.event.sequence : item.kind,
          ),
        ).toEqual([11, 12]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("coalesces streaming message deltas inside the hold window", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* threadLiveEventCoalescer({ coalesceWindow: "50 millis" });
        const messageId = MessageId.make("message-live");
        yield* coalescer.offer({
          kind: "event",
          event: makeMessage(1, "Hel", { messageId, streaming: true }),
        });
        yield* coalescer.offer({
          kind: "event",
          event: makeMessage(2, "lo", {
            messageId,
            streaming: true,
            updatedAt: "2026-01-01T00:00:03.000Z",
          }),
        });
        yield* TestClock.adjust("50 millis");
        const items = yield* coalescer.stream.pipe(Stream.take(1), Stream.runCollect);
        expect(items).toHaveLength(1);
        const item = items[0];
        assert(item?.kind === "event");
        assert(item.event.type === "thread.message-sent");
        expect(item.event.sequence).toBe(2);
        expect(item.event.payload.text).toBe("Hello");
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("flushes pending tool updates as soon as a synchronization marker arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* threadLiveEventCoalescer({ coalesceWindow: "500 millis" });
        const startedAt = yield* Clock.currentTimeMillis;
        yield* coalescer.offer({ kind: "event", event: makeToolActivity(2) });
        yield* coalescer.offer({ kind: "event", event: makeToolActivity(3) });
        yield* coalescer.offer({ kind: "synchronized" });

        expect(yield* Clock.currentTimeMillis).toBe(startedAt);
        expect(
          (yield* coalescer.stream.pipe(Stream.take(2), Stream.runCollect)).map((item) =>
            item.kind === "event" ? item.event.sequence : item.kind,
          ),
        ).toEqual([3, "synchronized"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("fails and clears pending updates when their serialized payload fills the budget", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = makeToolActivity(1);

        const coalescer = yield* threadLiveEventCoalescer({
          coalesceWindow: "500 millis",
          maxSerializedBytes: Buffer.byteLength(encodeEvent(first)),
        });

        yield* coalescer.offer({ kind: "event", event: first });
        expect(yield* coalescer.usage).toEqual({
          retainedItems: 1,
          retainedSerializedBytes: Buffer.byteLength(encodeEvent(first)),
        });

        const overflow = yield* coalescer
          .offer({ kind: "event", event: makeToolActivity(2) })
          .pipe(Effect.result);

        expect(overflow._tag).toBe("Failure");
        yield* coalescer.closed;
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
        const marker = yield* coalescer.offer({ kind: "synchronized" }).pipe(Effect.result);
        expect(marker._tag).toBe("Failure");
        const delivered = yield* coalescer.stream.pipe(Stream.runCollect, Effect.result);
        expect(delivered._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("keeps the flush timer alive when an offer's shorter scope closes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* threadLiveEventCoalescer({ coalesceWindow: "50 millis" });
        yield* Effect.scoped(coalescer.offer({ kind: "event", event: makeToolActivity(1) }));
        yield* TestClock.adjust("50 millis");
        const items = yield* coalescer.stream.pipe(Stream.take(1), Stream.runCollect);
        expect(
          items.map((item) => (item.kind === "event" ? item.event.sequence : item.kind)),
        ).toEqual([1]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("keeps an unacknowledged batch charged and clears later events on overflow", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const coalescer = yield* threadLiveEventCoalescer({ maxItems: 3 });
        const first = makeMessage(1, "é".repeat(1_024));
        yield* coalescer.offer({ kind: "event", event: first });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const pull = yield* Stream.toPull(coalescer.stream);
            const batch = yield* pull;
            expect(
              batch.map((item) => (item.kind === "event" ? item.event.sequence : null)),
            ).toEqual([1]);
            yield* coalescer.offer({ kind: "event", event: makeMessage(2) });
            yield* coalescer.offer({ kind: "event", event: makeToolActivity(3) });
            expect((yield* coalescer.usage).retainedItems).toBe(3);

            const overflow = yield* coalescer
              .offer({ kind: "event", event: makeToolActivity(4, { kind: "tool.completed" }) })
              .pipe(Effect.result);

            expect(overflow._tag).toBe("Failure");
            // Do not pull or acknowledge the batch. Cleanup must still finish.
            yield* coalescer.closed;
            expect(yield* coalescer.usage).toEqual({
              retainedItems: 1,
              retainedSerializedBytes: Buffer.byteLength(encodeEvent(first)),
            });
          }),
        );
        expect(yield* coalescer.usage).toEqual({ retainedItems: 0, retainedSerializedBytes: 0 });
      }),
    ),
  );
});
