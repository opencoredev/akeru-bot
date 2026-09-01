import { RoutineRunId, type OrchestrationEvent } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { RoutineRepository, type RoutineClaim } from "./Repository.ts";
import { RoutineRuntime, type RoutineRuntimeShape } from "./Runtime.ts";
import { latestScheduledFor, nextScheduledFor } from "./schedule.ts";
import {
  RoutineRuntimeAdapter,
  type Routine,
  type RoutineDependencyFailure,
  type RoutineRun,
  type RoutineRunTrigger,
} from "./types.ts";

const approvalFailure: RoutineDependencyFailure = {
  kind: "approval",
  reason: "The approved procedure version is not current.",
  nextAction: "Review and approve the current procedure, then resume the routine.",
};

const makeRun = (routine: Routine, claim: RoutineClaim): RoutineRun => {
  const base = {
    id: claim.runId,
    routineId: claim.routineId,
    procedureVersion: routine.procedureVersion,
    status: "queued" as const,
    threadRef: null,
    result: null,
    failure: null,
    usageRef: null,
    startedAt: null,
    completedAt: null,
    createdAt: claim.claimedAt,
    updatedAt: claim.claimedAt,
  };
  if (claim.scheduledFor === null) {
    return { ...base, trigger: claim.trigger, scheduledFor: null };
  }
  return { ...base, trigger: claim.trigger, scheduledFor: claim.scheduledFor };
};

const makeRunId = (routineId: string, scheduledFor: string) =>
  RoutineRunId.make(`routine:${routineId}:${scheduledFor}`);

const make = Effect.gen(function* () {
  const repository = yield* RoutineRepository;
  const adapter = yield* RoutineRuntimeAdapter;
  const engine = yield* Effect.serviceOption(OrchestrationEngineService);

  const block = Effect.fn("RoutineRuntime.block")(function* (
    routine: Routine,
    run: RoutineRun,
    failure: RoutineDependencyFailure,
  ) {
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    yield* adapter.recordBlocked(run, failure);
    yield* adapter.openFailureIncident(routine, failure);
    yield* repository.markBlocked(run.id, failure.reason, completedAt);
  });

  const execute = Effect.fn("RoutineRuntime.execute")(function* (
    routine: Routine,
    claim: RoutineClaim,
  ) {
    const run = makeRun(routine, claim);
    yield* adapter.recordQueued(run);

    const failure =
      claim.trigger !== "dry-run" && routine.approvalVersion !== routine.procedureVersion
        ? approvalFailure
        : yield* adapter.checkDependencies(routine);
    if (failure !== null) {
      yield* block(routine, run, failure);
      return run;
    }

    const dispatched = yield* adapter.dispatchTurn(routine, run);
    yield* repository.markDispatched(run.id, dispatched.threadRef);
    return { ...run, status: "running" as const, ...dispatched };
  });

  const claimAndExecute = Effect.fn("RoutineRuntime.claimAndExecute")(function* (
    routine: Routine,
    trigger: Extract<RoutineRunTrigger, "scheduled" | "missed">,
    scheduledFor: string,
    claimedAt: string,
  ) {
    if (yield* adapter.isTargetBusy(routine)) return null;
    const claim = {
      runId: makeRunId(routine.id, scheduledFor),
      routineId: routine.id,
      trigger,
      scheduledFor,
      claimedAt,
    } satisfies RoutineClaim;
    if (!(yield* repository.claim(claim))) return null;
    return yield* execute(routine, claim);
  });

  const runDue = Effect.gen(function* () {
    const nowEpochMillis = yield* Clock.currentTimeMillis;
    const now = DateTime.formatIso(yield* DateTime.now);
    const routines = yield* repository.listEnabled;
    for (const routine of routines) {
      if (routine.nextRunAt === null || Date.parse(routine.nextRunAt) > nowEpochMillis) continue;
      const scheduledFor = latestScheduledFor(routine.schedule, routine.timezone, nowEpochMillis);
      const trigger = scheduledFor === routine.nextRunAt ? "scheduled" : "missed";
      yield* claimAndExecute(routine, trigger, scheduledFor, now);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("routine scheduler tick failed", { cause })),
  );

  const runNow: RoutineRuntimeShape["runNow"] = (routineId, runId, trigger) =>
    Effect.gen(function* () {
      const routine = yield* repository.getById(routineId);
      if (routine === null || routine.lifecycle === "deleted") return null;
      if (yield* adapter.isTargetBusy(routine)) return null;
      const now = DateTime.formatIso(yield* DateTime.now);
      const claim = {
        runId,
        routineId,
        trigger,
        scheduledFor: null,
        claimedAt: now,
      } satisfies RoutineClaim;
      if (!(yield* repository.claim(claim))) return null;
      return yield* execute(routine, claim);
    });

  const settleRunForEvent = Effect.fn("RoutineRuntime.settleRunForEvent")(function* (
    event: OrchestrationEvent,
  ) {
    if (event.type === "routine.deleted") {
      yield* adapter.resolveFailureIncident(event.payload.routine.id);
      return;
    }
    if (event.type !== "thread.turn-diff-completed" && event.type !== "thread.session-set") return;
    if (
      event.type === "thread.session-set" &&
      event.payload.session.status !== "error" &&
      event.payload.session.status !== "interrupted" &&
      event.payload.session.status !== "stopped"
    )
      return;
    const threadRef = event.payload.threadId;
    const run = yield* repository.getActiveRunByThreadRef(threadRef);
    if (run === null) return;
    const routine = yield* repository.getById(run.routineId);
    if (routine === null) return;
    const completedAt =
      event.type === "thread.turn-diff-completed"
        ? event.payload.completedAt
        : event.payload.session.updatedAt;
    if (event.type === "thread.turn-diff-completed" && event.payload.status === "ready") {
      const nextRunAt = routine.enabled
        ? nextScheduledFor(routine.schedule, routine.timezone, Date.parse(completedAt))
        : null;
      yield* adapter.recordCompleted(run, nextRunAt, "Routine completed.", completedAt);
      yield* repository.markSettled(run.id, "completed", completedAt);
      return;
    }
    const failure = {
      kind: "execution",
      reason:
        event.type === "thread.turn-diff-completed"
          ? `Routine checkpoint ended with status '${event.payload.status}'.`
          : (event.payload.session.lastError ??
            `Routine session ended with status '${event.payload.session.status}'.`),
      nextAction: "Review the routine thread, then resume the routine.",
    } satisfies RoutineDependencyFailure;
    yield* adapter.recordFailed(run, failure, completedAt);
    yield* adapter.openFailureIncident(routine, failure);
    yield* repository.markBlocked(run.id, failure.reason, completedAt);
  });

  const recover = Effect.gen(function* () {
    for (const routine of yield* repository.listAll) {
      if (routine.lifecycle === "deleted") yield* adapter.resolveFailureIncident(routine.id);
    }
    for (const claim of yield* repository.listRecoverable) {
      const routine = yield* repository.getById(claim.routineId);
      if (routine === null || routine.lifecycle === "deleted") {
        yield* repository.markBlocked(
          claim.runId,
          "The routine no longer exists.",
          DateTime.formatIso(yield* DateTime.now),
        );
        continue;
      }
      if (
        claim.status === "dispatched" &&
        claim.terminalState !== null &&
        claim.terminalState !== undefined
      ) {
        const run = (yield* repository.listRuns(claim.routineId)).find(
          (candidate) => candidate.id === claim.runId,
        );
        if (run !== undefined) {
          const completedAt = claim.terminalAt ?? DateTime.formatIso(yield* DateTime.now);
          if (claim.terminalState === "completed") {
            const nextRunAt = routine.enabled
              ? nextScheduledFor(routine.schedule, routine.timezone, Date.parse(completedAt))
              : null;
            yield* adapter.recordCompleted(run, nextRunAt, "Routine completed.", completedAt);
            yield* repository.markSettled(run.id, "completed", completedAt);
          } else {
            const failure = {
              kind: "execution",
              reason: `Routine thread ended with state '${claim.terminalState}'.`,
              nextAction: "Review the routine thread, then resume the routine.",
            } satisfies RoutineDependencyFailure;
            yield* adapter.recordFailed(run, failure, completedAt);
            yield* adapter.openFailureIncident(routine, failure);
            yield* repository.markBlocked(run.id, failure.reason, completedAt);
          }
          continue;
        }
      }
      if (claim.status === "dispatched") continue;
      yield* execute(routine, claim);
    }
  }).pipe(
    Effect.catchCause((cause) => Effect.logError("routine scheduler recovery failed", { cause })),
  );

  const start = Effect.gen(function* () {
    if (Option.isSome(engine)) {
      yield* Effect.forkScoped(
        engine.value.streamDomainEvents.pipe(
          Stream.runForEach((event) =>
            settleRunForEvent(event).pipe(
              Effect.catchCause((cause) =>
                Effect.logError("routine run settlement failed", { cause }),
              ),
            ),
          ),
        ),
      );
    }
    yield* recover;
    yield* runDue;
    yield* Effect.forkScoped(
      recover.pipe(Effect.andThen(runDue), Effect.repeat(Schedule.spaced("1 minute"))),
    );
  });

  return { runDue, runNow, recover, start } satisfies RoutineRuntimeShape;
});

export const RoutineRuntimeLive = Layer.effect(RoutineRuntime, make);
