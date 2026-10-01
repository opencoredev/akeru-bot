import { routine, harness } from "./testUtils/runtimeLive.ts";
import { BotId, EventId, type OrchestrationEvent, RoutineId, RoutineRunId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RoutineRuntime } from "./Runtime.ts";
import { findBlockingDependencyIncident } from "./RuntimeAdapterLive.ts";

it.effect("resolves a routine incident when the routine is deleted", () => {
  const value = routine();

  const deleted = {
    sequence: 1,
    eventId: EventId.make("event-routine-deleted"),
    aggregateKind: "routine",
    aggregateId: value.id,
    occurredAt: "2026-08-01T00:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "routine.deleted",
    payload: {
      routine: {
        ...value,
        enabled: false,
        lifecycle: "deleted",
        nextRunAt: null,
        deletedAt: "2026-08-01T00:00:00.000Z",
      },
    },
  } satisfies Extract<OrchestrationEvent, { type: "routine.deleted" }>;

  const test = harness(value, [], null, false, Stream.make(deleted));

  return Effect.scoped(
    Effect.gen(function* () {
      yield* TestClock.setTime(Date.parse("2026-08-01T00:00:00.000Z"));
      const runtime = yield* RoutineRuntime;
      yield* runtime.start;
      yield* Effect.yieldNow;
      assert(test.events.includes(`incident-resolved:${value.id}`));
    }),
  ).pipe(Effect.provide(test.layer));
});

it("finds open connector and browser incidents for the routine bot", () => {
  const item = {
    id: "incident-1",
    incidentKey: "connector:gmail:bot-1",
    kind: "oauth-expired" as const,
    status: "open" as const,
    botId: BotId.make("bot-1"),
    botName: "Inbox bot",
    taskOrRoutine: "Gmail access",
    lastFailure: "OAuth expired.",
    nextAction: "Reconnect Gmail.",
    firstSeenAt: "2026-08-31T12:00:00.000Z",
    lastSeenAt: "2026-08-31T12:00:00.000Z",
    occurrenceCount: 1,
  };

  assert.strictEqual(findBlockingDependencyIncident([item], BotId.make("bot-1"), ["gmail"]), item);
  assert.strictEqual(
    findBlockingDependencyIncident([item], BotId.make("bot-1"), ["slack"]),
    undefined,
  );
  assert.strictEqual(
    findBlockingDependencyIncident([item], BotId.make("bot-2"), ["gmail"]),
    undefined,
  );
  assert.strictEqual(
    findBlockingDependencyIncident([{ ...item, status: "resolved" }], BotId.make("bot-1"), [
      "gmail",
    ]),
    undefined,
  );
});

it.effect("coalesces missed slots and claims each slot once", () => {
  const test = harness(routine());

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
    const runtime = yield* RoutineRuntime;
    yield* runtime.runDue;
    yield* runtime.runDue;
    assert.deepEqual(test.events, [
      "claimed:missed:2026-08-31T13:00:00.000Z",
      "queued",
      "turn",
      "dispatched",
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("defers a due run while its target chat is busy", () => {
  const test = harness(routine(), [], null, true);

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
    const runtime = yield* RoutineRuntime;
    yield* runtime.runDue;
    assert.deepEqual(test.events, []);
  }).pipe(Effect.provide(test.layer));
});

it.effect("blocks a dispatched run whose session stopped before a turn", () => {
  const value = routine();

  const test = harness(value, [
    {
      runId: RoutineRunId.make("run-stopped"),
      routineId: value.id,
      trigger: "manual",
      scheduledFor: null,
      claimedAt: "2026-08-31T13:00:00.000Z",
      status: "dispatched",
      threadRef: "thread-1",
      terminalState: null,
      terminalAt: null,
      sessionState: "stopped",
      sessionUpdatedAt: "2026-08-31T13:01:00.000Z",
    },
  ]);

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, ["incident", "claim-blocked"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("validates dry runs without dispatching a provider turn", () => {
  const test = harness(routine());

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.runNow(RoutineId.make("routine-1"), RoutineRunId.make("manual-1"), "manual");
    yield* runtime.runNow(RoutineId.make("routine-1"), RoutineRunId.make("dry-1"), "dry-run");
    assert.deepEqual(test.events, [
      "claimed:manual:null",
      "queued",
      "turn",
      "dispatched",
      "claimed:dry-run:null",
      "queued",
      "completed",
      "claim-settled",
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("blocks an unapproved routine and opens one incident", () => {
  const test = harness(routine({ approvalVersion: 1 }));

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
    const runtime = yield* RoutineRuntime;
    yield* runtime.runDue;
    yield* runtime.runDue;
    assert.deepEqual(test.events, [
      "claimed:missed:2026-08-31T13:00:00.000Z",
      "queued",
      "run-blocked",
      "incident",
      "claim-blocked",
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("blocks a broken connector without retrying the same slot", () => {
  const test = harness(routine(), [], {
    kind: "connector",
    reason: "Required connector 'gmail' is unavailable.",
    nextAction: "Reconnect the connector, then resume the routine.",
  });

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
    const runtime = yield* RoutineRuntime;
    yield* runtime.runDue;
    yield* runtime.runDue;
    assert.deepEqual(test.events, [
      "claimed:missed:2026-08-31T13:00:00.000Z",
      "queued",
      "run-blocked",
      "incident",
      "claim-blocked",
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("blocks a run whose bot work could not start", () => {
  const test = harness(
    routine({ delegateToBotId: BotId.make("bot-helper") }),
    [],
    null,
    false,
    Stream.empty,
    null,
    {
      dispatched: {
        failure: {
          kind: "execution",
          reason: "Claude bots cannot take bot work yet.",
          nextAction: "Check the helper bot, then resume the routine.",
        },
      },
    },
  );

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
    const runtime = yield* RoutineRuntime;
    yield* runtime.runDue;
    assert.deepEqual(test.events, [
      "claimed:missed:2026-08-31T13:00:00.000Z",
      "queued",
      "turn",
      "run-blocked",
      "incident",
      "claim-blocked",
    ]);
  }).pipe(Effect.provide(test.layer));
});
