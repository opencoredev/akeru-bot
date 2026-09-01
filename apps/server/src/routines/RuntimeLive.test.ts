import {
  BotId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  RoutineId,
  RoutineRunId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { RoutineRepository, type RoutineClaim, type RoutineRepositoryShape } from "./Repository.ts";
import { RoutineRuntime } from "./Runtime.ts";
import { findBlockingDependencyIncident } from "./RuntimeAdapterLive.ts";
import { RoutineRuntimeLive } from "./RuntimeLive.ts";
import {
  RoutineRuntimeAdapter,
  type Routine,
  type RoutineDependencyFailure,
  type RoutineRun,
  type RoutineRuntimeAdapterShape,
} from "./types.ts";

const routine = (overrides: Partial<Routine> = {}): Routine => ({
  id: RoutineId.make("routine-1"),
  botId: BotId.make("bot-1"),
  targetThreadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  job: "Morning research",
  procedure: "Prepare the morning research brief.",
  procedureVersion: 2,
  approvalVersion: 2,
  schedule: { kind: "daily", time: "09:00" },
  timezone: "America/New_York",
  skillAssignmentIds: [],
  connectorDependencies: [],
  sandbox: "local",
  approvalPolicy: "approval-required",
  enabled: true,
  lifecycle: "enabled",
  nextRunAt: "2026-08-28T13:00:00.000Z",
  lastRunAt: null,
  latestResult: null,
  latestFailure: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  deletedAt: null,
  ...overrides,
});

const harness = (
  value: Routine,
  recoverable: ReadonlyArray<RoutineClaim> = [],
  dependencyFailure: RoutineDependencyFailure | null = null,
  targetBusy = false,
  domainEvents: Stream.Stream<OrchestrationEvent> = Stream.empty,
  projectedStatus: RoutineRun["status"] | null = null,
) => {
  const claims = new Map<string, RoutineClaim>();
  const events: string[] = [];
  const repository = RoutineRepository.of({
    listAll: Effect.succeed([value]),
    listEnabled: Effect.succeed([value]),
    getById: () => Effect.succeed(value),
    listRuns: () =>
      Effect.succeed(
        recoverable.map((claim) => ({
          id: claim.runId,
          routineId: claim.routineId,
          procedureVersion: value.procedureVersion,
          trigger:
            claim.trigger === "manual" || claim.trigger === "dry-run" ? "manual" : claim.trigger,
          scheduledFor:
            claim.trigger === "manual" || claim.trigger === "dry-run" ? null : claim.scheduledFor,
          status: projectedStatus ?? ("running" as const),
          result: null,
          failure: null,
          usageRef: null,
          threadRef: ThreadId.make("thread-1"),
          startedAt: claim.claimedAt,
          completedAt: null,
          createdAt: claim.claimedAt,
          updatedAt: claim.claimedAt,
        })) as never,
      ),
    listAllRuns: Effect.succeed([]),
    getActiveRunByThreadRef: () => Effect.succeed(null),
    listSkillAssignments: Effect.succeed([]),
    claim: (claim) =>
      Effect.sync(() => {
        const key =
          claim.scheduledFor === null ? claim.runId : `${claim.routineId}:${claim.scheduledFor}`;
        if (claims.has(key)) return false;
        claims.set(key, claim);
        events.push(`claimed:${claim.trigger}:${claim.scheduledFor}`);
        return true;
      }),
    markDispatched: () => Effect.sync(() => events.push("dispatched")),
    markBlocked: () => Effect.sync(() => events.push("claim-blocked")),
    markSettled: () => Effect.sync(() => events.push("claim-settled")),
    listRecoverable: Effect.succeed(recoverable),
  } satisfies RoutineRepositoryShape);
  const adapter = RoutineRuntimeAdapter.of({
    isTargetBusy: () => Effect.succeed(targetBusy),
    checkDependencies: () => Effect.succeed(dependencyFailure),
    recordQueued: () => Effect.sync(() => events.push("queued")),
    recordBlocked: () => Effect.sync(() => events.push("run-blocked")),
    recordCompleted: () => Effect.sync(() => events.push("completed")),
    recordFailed: () => Effect.void,
    openFailureIncident: () => Effect.sync(() => events.push("incident")),
    resolveFailureIncident: (routineId) =>
      Effect.sync(() => events.push(`incident-resolved:${routineId}`)),
    dispatchTurn: () =>
      Effect.sync(() => {
        events.push("turn");
        return { threadRef: ThreadId.make("thread-1") };
      }),
  } satisfies RoutineRuntimeAdapterShape);
  const layer = RoutineRuntimeLive.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(RoutineRepository, repository),
        Layer.succeed(RoutineRuntimeAdapter, adapter),
        Layer.succeed(OrchestrationEngineService, {
          dispatch: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          streamDomainEvents: domainEvents,
          latestSequence: Effect.succeed(0),
        }),
      ),
    ),
  );
  return { events, layer };
};

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

it.effect("resolves stale incidents for routines deleted before restart", () => {
  const value = routine({ enabled: false, lifecycle: "deleted", nextRunAt: null });
  const test = harness(value);

  return Effect.gen(function* () {
    const runtime = yield* RoutineRuntime;
    yield* runtime.recover;
    assert.deepEqual(test.events, [`incident-resolved:${value.id}`]);
  }).pipe(Effect.provide(test.layer));
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
