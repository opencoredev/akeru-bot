import {
  routine,
  harness,
  helperThreadId,
  scheduledDelegation,
  eventBase,
  delegationUpdated,
  finishedPhase,
  startDelegatedRoutine,
  takeUntil,
} from "./testUtils/runtimeLive.ts";
import { BotId, type OrchestrationEvent, RoutineRunId, TurnId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { RoutineRuntime } from "./Runtime.ts";

it.effect("resolves stale incidents for routines deleted before restart", () => {
  const value = routine({ enabled: false, lifecycle: "deleted", nextRunAt: null });
  const test = harness(value);

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, [`incident-resolved:${value.id}`]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("settles a dispatched run from durable terminal state after restart", () => {
  const value = routine();

  const test = harness(value, [
    {
      runId: RoutineRunId.make("run-1"),
      routineId: value.id,
      trigger: "scheduled",
      scheduledFor: "2026-08-31T13:00:00.000Z",
      claimedAt: "2026-08-31T13:00:00.000Z",
      status: "dispatched",
      threadRef: "thread-1",
      terminalState: "completed",
      terminalAt: "2026-08-31T13:05:00.000Z",
    },
  ]);

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, ["completed", "claim-settled"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("leaves an in-flight dispatched run attached after restart", () => {
  const value = routine();

  const test = harness(value, [
    {
      runId: RoutineRunId.make("run-in-flight"),
      routineId: value.id,
      trigger: "manual",
      scheduledFor: null,
      claimedAt: "2026-08-31T13:00:00.000Z",
      status: "dispatched",
      threadRef: "thread-1",
      terminalState: null,
      terminalAt: null,
    },
  ]);

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, []);
  }).pipe(Effect.provide(test.layer));
});

it.effect("blocks a stopped delegated session whose delegation is still running", () => {
  const value = routine({ delegateToBotId: BotId.make("bot-helper") });

  const test = harness(
    value,
    [
      {
        runId: RoutineRunId.make("run-delegated-stopped"),
        routineId: value.id,
        trigger: "scheduled",
        scheduledFor: "2026-08-31T13:00:00.000Z",
        claimedAt: "2026-08-31T13:00:00.000Z",
        status: "dispatched",
        threadRef: "thread-helper",
        terminalState: null,
        terminalAt: null,
        sessionState: "stopped",
        sessionUpdatedAt: "2026-08-31T13:01:00.000Z",
      },
    ],
    null,
    false,
    Stream.empty,
    null,
    {
      delegation: scheduledDelegation({
        _tag: "Running",
        childThreadId: helperThreadId,
        childTurnId: TurnId.make("turn-helper"),
        startedAt: "2026-08-31T13:00:00.000Z",
        progress: null,
      }),
    },
  );

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, ["incident", "claim-blocked"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("does not restart a claim whose projected run is already blocked", () => {
  const value = routine({ enabled: false, lifecycle: "blocked", nextRunAt: null });

  const test = harness(
    value,
    [
      {
        runId: RoutineRunId.make("run-blocked-before-claim-update"),
        routineId: value.id,
        trigger: "scheduled",
        scheduledFor: "2026-08-31T13:00:00.000Z",
        claimedAt: "2026-08-31T13:00:00.000Z",
        status: "claimed",
        threadRef: null,
        terminalState: null,
        terminalAt: null,
      },
    ],
    null,
    false,
    Stream.empty,
    "blocked",
  );

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, ["claim-blocked"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect(
  "settles a routine from its scheduled bot work, and pausing leaves that work running",
  () =>
    Effect.gen(function* () {
      const signals = yield* Queue.unbounded<string>();
      const domain = yield* Queue.unbounded<OrchestrationEvent>();
      const { value, test } = startDelegatedRoutine(signals, domain);
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
          const runtime = yield* RoutineRuntime;
          yield* runtime.start;
          yield* takeUntil(signals, "dispatched");
          yield* Queue.offer(domain, {
            ...eventBase("event-routine-paused", "routine", value.id),
            type: "routine.paused",
            payload: {
              routine: { ...value, enabled: false, lifecycle: "paused", nextRunAt: null },
            },
          } as OrchestrationEvent);
          yield* Queue.offer(
            domain,
            delegationUpdated({
              _tag: "Completed",
              ...finishedPhase,
              result: {
                summary: "The brief is ready.",
                childThreadId: helperThreadId,
                childTurnId: TurnId.make("turn-helper"),
              },
              acknowledgedAt: null,
            }),
          );
          yield* takeUntil(signals, "claim-settled");
        }).pipe(Effect.provide(test.layer)),
      );
      assert.deepEqual(test.events, [
        "claimed:missed:2026-08-31T13:00:00.000Z",
        "queued",
        "turn",
        "dispatched",
        "completed",
        "claim-settled",
      ]);
      assert.deepEqual(test.summaries, ["The brief is ready."]);
    }),
);

it.effect("cancels scheduled bot work with its run and cancels the run with its work", () =>
  Effect.gen(function* () {
    const signals = yield* Queue.unbounded<string>();
    const domain = yield* Queue.unbounded<OrchestrationEvent>();
    const { value, test } = startDelegatedRoutine(signals, domain);
    yield* Effect.scoped(
      Effect.gen(function* () {
        yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
        const runtime = yield* RoutineRuntime;
        yield* runtime.start;
        yield* takeUntil(signals, "dispatched");
        yield* Queue.offer(domain, {
          ...eventBase("event-run-canceled", "routine", value.id),
          type: "routine.run-canceled",
          payload: {
            routine: value,
            run: {
              id: RoutineRunId.make("run-canceled"),
              routineId: value.id,
              procedureVersion: value.procedureVersion,
              trigger: "manual",
              scheduledFor: null,
              status: "canceled",
              result: null,
              failure: null,
              usageRef: null,
              threadRef: helperThreadId,
              startedAt: "2026-08-31T20:00:00.000Z",
              completedAt: "2026-08-31T20:05:00.000Z",
              createdAt: "2026-08-31T20:00:00.000Z",
              updatedAt: "2026-08-31T20:05:00.000Z",
            },
          },
        } as OrchestrationEvent);
        yield* takeUntil(signals, `delegation-canceled:${helperThreadId}`);
        yield* Queue.offer(
          domain,
          delegationUpdated({ _tag: "Canceled", ...finishedPhase, canceledBy: "user" }),
        );
        yield* takeUntil(signals, "claim-settled");
      }).pipe(Effect.provide(test.layer)),
    );
    assert.deepEqual(test.events.slice(4), [
      "claim-settled",
      `delegation-canceled:${helperThreadId}`,
      "run-canceled",
      "claim-settled",
    ]);
    // The claim agrees with the canceled run instead of reporting a failure.
    assert.deepEqual(test.settledStatuses, ["canceled", "canceled"]);
  }),
);

it.effect("settles the claim of a run canceled while its bot work started", () => {
  const test = harness(
    routine({ delegateToBotId: BotId.make("bot-helper") }),
    [],
    null,
    false,
    Stream.empty,
    null,
    { dispatched: { canceled: true } },
  );

  return Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-08-31T20:00:00.000Z"));
    const runtime = yield* RoutineRuntime;
    yield* runtime.runDue;
    assert.deepEqual(test.events, [
      "claimed:missed:2026-08-31T13:00:00.000Z",
      "queued",
      "turn",
      "claim-settled",
    ]);
    assert.deepEqual(test.settledStatuses, ["canceled"]);
  }).pipe(Effect.provide(test.layer));
});
