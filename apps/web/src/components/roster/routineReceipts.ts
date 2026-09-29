import type { Routine, RoutineReceiptSource, RoutineRun, ThreadId } from "@t3tools/contracts";

export interface RoutineReceipt {
  readonly id: string;
  readonly createdAt: string;
  readonly text: string;
  readonly tone: "info" | "success" | "error";
}

function withDetail(summary: string, detail: string | undefined): string {
  const trimmed = detail?.trim();
  return trimmed ? `${summary}: ${trimmed}` : summary;
}

export function deriveRoutineReceipts(
  threadId: ThreadId,
  routines: ReadonlyArray<Routine | RoutineReceiptSource>,
  runs: ReadonlyArray<RoutineRun>,
): RoutineReceipt[] {
  const threadRoutines = routines.filter((routine) => routine.targetThreadId === threadId);
  const byRoutineId = new Map(threadRoutines.map((routine) => [routine.id, routine]));
  const receipts: RoutineReceipt[] = [];

  for (const routine of threadRoutines) {
    receipts.push({
      id: `routine-created:${routine.id}`,
      createdAt: routine.createdAt,
      text: `Routine "${routine.job}" was created`,
      tone: "info",
    });
  }

  for (const run of runs) {
    const routine = byRoutineId.get(run.routineId);
    if (!routine) continue;
    if (run.startedAt !== null) {
      receipts.push({
        id: `routine-run-started:${run.id}`,
        createdAt: run.startedAt,
        text: `"${routine.job}" started a run`,
        tone: "info",
      });
    }
    switch (run.status) {
      case "queued":
      case "waiting-for-approval":
        // Not started yet; the panel shows pending runs, the chat waits for real work.
        break;
      case "running":
        break;
      case "canceled":
        receipts.push({
          id: `routine-run-finished:${run.id}`,
          createdAt: run.completedAt ?? run.updatedAt,
          text: `"${routine.job}" was canceled`,
          tone: "info",
        });
        break;
      case "failed":
      case "blocked":
        receipts.push({
          id: `routine-run-finished:${run.id}`,
          createdAt: run.completedAt ?? run.updatedAt,
          text: withDetail(`"${routine.job}" failed`, run.failure?.message),
          tone: "error",
        });
        break;
      case "completed":
        receipts.push({
          id: `routine-run-finished:${run.id}`,
          createdAt: run.completedAt ?? run.updatedAt,
          text: withDetail(`"${routine.job}" finished`, run.result?.summary),
          tone: "success",
        });
        break;
    }
  }

  return receipts.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}
