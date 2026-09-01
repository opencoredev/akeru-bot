import type {
  Routine,
  RoutineId,
  RoutineFailureKind,
  RoutineRun,
  RoutineRunId,
  RoutineRunTrigger,
  RoutineSchedule,
  RoutineWeekday,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export type {
  Routine,
  RoutineId,
  RoutineRun,
  RoutineRunId,
  RoutineRunTrigger,
  RoutineSchedule,
  RoutineWeekday,
};

export interface RoutineDependencyFailure {
  readonly kind: RoutineFailureKind;
  readonly reason: string;
  readonly nextAction: string;
}

export interface RoutineDispatchResult {
  readonly threadRef: ThreadId;
}

export interface RoutineRuntimeAdapterShape {
  readonly isTargetBusy: (routine: Routine) => Effect.Effect<boolean>;
  readonly checkDependencies: (routine: Routine) => Effect.Effect<RoutineDependencyFailure | null>;
  readonly recordQueued: (run: RoutineRun) => Effect.Effect<void>;
  readonly recordBlocked: (
    run: RoutineRun,
    failure: RoutineDependencyFailure,
  ) => Effect.Effect<void>;
  readonly recordCompleted: (
    run: RoutineRun,
    nextRunAt: string | null,
    summary: string,
    completedAt: string,
  ) => Effect.Effect<void>;
  readonly recordFailed: (
    run: RoutineRun,
    failure: RoutineDependencyFailure,
    completedAt: string,
  ) => Effect.Effect<void>;
  readonly openFailureIncident: (
    routine: Routine,
    failure: RoutineDependencyFailure,
  ) => Effect.Effect<void, never>;
  readonly resolveFailureIncident: (routineId: RoutineId) => Effect.Effect<void, never>;
  readonly dispatchTurn: (
    routine: Routine,
    run: RoutineRun,
  ) => Effect.Effect<RoutineDispatchResult>;
}

export class RoutineRuntimeAdapter extends Context.Service<
  RoutineRuntimeAdapter,
  RoutineRuntimeAdapterShape
>()("akeru-bot/routines/types/RoutineRuntimeAdapter") {}
