import type { Routine, RoutineReceiptSource } from "@akeru/contracts";

/** Keep deleted routine labels in chat without sending their full definitions. */
export function toRoutineReceiptSource(routine: Routine): RoutineReceiptSource {
  return {
    id: routine.id,
    targetThreadId: routine.targetThreadId,
    job: routine.job,
    createdAt: routine.createdAt,
  };
}

export function deletedRoutineReceiptSources(
  routines: ReadonlyArray<Routine>,
): RoutineReceiptSource[] {
  return routines.filter((routine) => routine.deletedAt !== null).map(toRoutineReceiptSource);
}
