import type {
  AkeruDelegationRecord,
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

/**
 * A dispatched run points at the chat whose work settles it: the owner chat for
 * a turn, or the helper's chat for scheduled bot work. A refused start blocks the
 * run. `canceled` means the run ended before it started, and any work it began
 * has been canceled.
 */
export type RoutineDispatchResult =
  | { readonly threadRef: ThreadId }
  | { readonly failure: RoutineDependencyFailure }
  | { readonly canceled: true };

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
  readonly recordCanceled: (run: RoutineRun, completedAt: string) => Effect.Effect<void>;
  /** Cancels the scheduled bot work a run started, if it is still open. */
  readonly cancelDelegatedRun: (run: RoutineRun) => Effect.Effect<void>;
  /** The persisted scheduled bot work whose child chat is `threadRef`, if any. */
  readonly findDelegatedRunDelegation: (
    threadRef: string,
  ) => Effect.Effect<AkeruDelegationRecord | null>;
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
