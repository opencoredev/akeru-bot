import {
  type AkeruDelegationRecord,
  BotId,
  DelegationId,
  EventId,
  type OrchestrationEvent,
  ProjectId,
  RoutineId,
  ThreadId,
  TurnId,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  RoutineRepository,
  type RoutineClaim,
  type RoutineRepositoryShape,
} from "../Repository.ts";
import { RoutineRuntimeLive } from "../RuntimeLive.ts";
import {
  RoutineRuntimeAdapter,
  type Routine,
  type RoutineDependencyFailure,
  type RoutineDispatchResult,
  type RoutineRun,
  type RoutineRuntimeAdapterShape,
} from "../types.ts";

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
  delegateToBotId: null,
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
  options: {
    readonly dispatched?: RoutineDispatchResult;
    readonly signals?: Queue.Queue<string>;
    readonly delegation?: AkeruDelegationRecord;
  } = {},
) => {
  const claims = new Map<string, RoutineClaim>();
  const dispatchedRuns: RoutineRun[] = [];
  const log: string[] = [];
  const summaries: string[] = [];
  const settledStatuses: string[] = [];
  const events = {
    push: (event: string) => {
      log.push(event);
      if (options.signals) Queue.offerUnsafe(options.signals, event);
      return log.length;
    },
  };
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
    listThreadRuns: () => Effect.succeed({ runs: [], nextCursor: null }),
    listAllRuns: Effect.sync(() => dispatchedRuns),
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
    markDispatched: (runId, threadRef) =>
      Effect.sync(() => {
        dispatchedRuns.push({
          id: runId,
          routineId: value.id,
          procedureVersion: value.procedureVersion,
          trigger: "manual",
          scheduledFor: null,
          status: "running",
          result: null,
          failure: null,
          usageRef: null,
          threadRef: ThreadId.make(threadRef),
          startedAt: "2026-08-31T20:00:00.000Z",
          completedAt: null,
          createdAt: "2026-08-31T20:00:00.000Z",
          updatedAt: "2026-08-31T20:00:00.000Z",
        });
        events.push("dispatched");
      }),
    markBlocked: () => Effect.sync(() => events.push("claim-blocked")),
    markSettled: (_runId, status) =>
      Effect.sync(() => {
        settledStatuses.push(status);
        events.push("claim-settled");
      }),
    listRecoverable: Effect.succeed(recoverable),
  } satisfies RoutineRepositoryShape);
  const adapter = RoutineRuntimeAdapter.of({
    isTargetBusy: () => Effect.succeed(targetBusy),
    checkDependencies: () => Effect.succeed(dependencyFailure),
    recordQueued: () => Effect.sync(() => events.push("queued")),
    recordBlocked: () => Effect.sync(() => events.push("run-blocked")),
    recordCompleted: (_run, _nextRunAt, summary) =>
      Effect.sync(() => {
        summaries.push(summary);
        events.push("completed");
      }),
    recordFailed: () => Effect.void,
    recordCanceled: () => Effect.sync(() => events.push("run-canceled")),
    cancelDelegatedRun: (run) =>
      Effect.sync(() => events.push(`delegation-canceled:${run.threadRef}`)),
    findDelegatedRunDelegation: () => Effect.succeed(options.delegation ?? null),
    openFailureIncident: () => Effect.sync(() => events.push("incident")),
    resolveFailureIncident: (routineId) =>
      Effect.sync(() => events.push(`incident-resolved:${routineId}`)),
    dispatchTurn: () =>
      Effect.sync(() => {
        events.push("turn");
        return options.dispatched ?? { threadRef: ThreadId.make("thread-1") };
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
          readThreadEvents: () => Stream.empty,
          getThreadReplayStats: () => Effect.die("unused thread replay stats"),
          streamDomainEvents: domainEvents,
          subscribeDomainEvents: Effect.succeed(domainEvents),
          latestSequence: Effect.succeed(0),
        }),
      ),
    ),
  );
  return { events: log, summaries, settledStatuses, layer };
};

const helperThreadId = ThreadId.make("thread-helper");

const scheduledDelegation = (phase: AkeruDelegationRecord["phase"]): AkeruDelegationRecord => ({
  delegationId: DelegationId.make("delegation-scheduled"),
  parentDelegationId: null,
  parentBotId: BotId.make("bot-1"),
  childBotId: BotId.make("bot-helper"),
  parentThreadId: ThreadId.make("thread-1"),
  parentTurnId: TurnId.make("scheduled-turn"),
  ancestorBotIds: [],
  depth: 0,
  task: "Prepare the morning research brief.",
  expectedResult: "A short summary.",
  deadline: null,
  access: {
    allowedToolIds: [],
    memoryScopes: [],
    sandbox: "local",
    runtimeMode: "approval-required",
    hasUserComputer: false,
    enabledMcpServerIds: [],
    disabledMcpServerIds: [],
    approvalCeiling: "secrets",
  },
  phase,
  billedBotId: BotId.make("bot-helper"),
  keep: false,
  anchorMessageId: null,
  retryOfDelegationId: null,
  trigger: "scheduled",
  createdAt: "2026-08-31T20:00:00.000Z",
  updatedAt: "2026-08-31T20:00:00.000Z",
});

const eventBase = (id: string, aggregateKind: "delegation" | "routine", aggregateId: string) => ({
  sequence: 1,
  eventId: EventId.make(id),
  aggregateKind,
  aggregateId,
  occurredAt: "2026-08-31T20:05:00.000Z",
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
});

const delegationUpdated = (phase: AkeruDelegationRecord["phase"]) =>
  ({
    ...eventBase("event-delegation-updated", "delegation", "delegation-scheduled"),
    type: "delegation.updated",
    payload: { delegation: scheduledDelegation(phase) },
  }) as OrchestrationEvent;

const finishedPhase = {
  childThreadId: helperThreadId,
  childTurnId: TurnId.make("turn-helper"),
  startedAt: "2026-08-31T20:00:00.000Z",
  completedAt: "2026-08-31T20:05:00.000Z",
};

const startDelegatedRoutine = (
  signals: Queue.Queue<string>,
  domain: Queue.Queue<OrchestrationEvent>,
) => {
  const value = routine({ delegateToBotId: BotId.make("bot-helper") });
  return {
    value,
    test: harness(value, [], null, false, Stream.fromQueue(domain), null, {
      dispatched: { threadRef: helperThreadId },
      signals,
    }),
  };
};

const takeUntil = (signals: Queue.Queue<string>, expected: string) =>
  Effect.gen(function* () {
    while ((yield* Queue.take(signals)) !== expected) {
      // Earlier signals belong to steps the test already asserted.
    }
  });
export {
  routine,
  harness,
  helperThreadId,
  scheduledDelegation,
  eventBase,
  delegationUpdated,
  finishedPhase,
  startDelegatedRoutine,
  takeUntil,
};
