import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { PersistenceSqlError } from "../persistence/Errors.ts";
import type { RoutineId, RoutineRun, RoutineRunId, RoutineRunTrigger } from "./types.ts";

export interface RoutineRuntimeShape {
  readonly runDue: Effect.Effect<void, never>;
  readonly runNow: (
    routineId: RoutineId,
    runId: RoutineRunId,
    trigger: Extract<RoutineRunTrigger, "dry-run" | "manual">,
  ) => Effect.Effect<RoutineRun | null, PersistenceSqlError>;
  readonly recover: Effect.Effect<void, never>;
  readonly start: Effect.Effect<void, never, Scope.Scope>;
}

export class RoutineRuntime extends Context.Service<RoutineRuntime, RoutineRuntimeShape>()(
  "akeru-bot/routines/Runtime/RoutineRuntime",
) {}
