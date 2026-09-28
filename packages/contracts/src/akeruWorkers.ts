import * as Schema from "effect/Schema";

import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Workers run at depth 1 under a bot turn and cannot start workers of their own. */
export const AKERU_WORKER_MAX_DEPTH = 1;
/** Running workers one bot turn may own at the same time. */
export const AKERU_WORKER_MAX_CONCURRENCY = 3;
/** A worker that has not produced a result by this deadline fails with `timeout`. */
export const AKERU_WORKER_TIMEOUT_MS = 10 * 60 * 1000;
export const AKERU_WORKER_TASK_MAX_CHARS = 16_000;

export const AkeruWorkerId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruWorkerId"));
export type AkeruWorkerId = typeof AkeruWorkerId.Type;

const WorkerText = TrimmedNonEmptyString.check(Schema.isMaxLength(AKERU_WORKER_TASK_MAX_CHARS));

export const AkeruWorkerTaskInput = Schema.Struct({
  task: WorkerText,
  expectedResult: Schema.optional(WorkerText),
  /** Return immediately with a Running status instead of waiting for the result. */
  background: Schema.optional(Schema.Boolean),
});
export const AkeruWorkerCheckInput = Schema.Struct({
  workerId: AkeruWorkerId,
  /** Wait until the worker reaches a terminal state. */
  wait: Schema.optional(Schema.Boolean),
});
export const AkeruWorkerMessageInput = Schema.Struct({
  workerId: AkeruWorkerId,
  message: WorkerText,
});
export const AkeruWorkerStopInput = Schema.Struct({ workerId: AkeruWorkerId });

export const AkeruWorkerFailureCode = Schema.Literals(["timeout", "worker_failed", "internal"]);
export type AkeruWorkerFailureCode = typeof AkeruWorkerFailureCode.Type;

export const AkeruWorkerPhase = Schema.TaggedUnion({
  Running: {
    childThreadId: Schema.NullOr(ThreadId),
    startedAt: IsoDateTime,
  },
  Completed: {
    childThreadId: ThreadId,
    startedAt: IsoDateTime,
    completedAt: IsoDateTime,
    result: TrimmedNonEmptyString,
  },
  Failed: {
    childThreadId: Schema.NullOr(ThreadId),
    startedAt: IsoDateTime,
    completedAt: IsoDateTime,
    failureCode: AkeruWorkerFailureCode,
    message: TrimmedNonEmptyString,
  },
  Canceled: {
    childThreadId: Schema.NullOr(ThreadId),
    startedAt: IsoDateTime,
    completedAt: IsoDateTime,
    canceledBy: Schema.Literals(["stop", "parent-turn-ended"]),
  },
});
export type AkeruWorkerPhase = typeof AkeruWorkerPhase.Type;

/** Result of Task, CheckSubagent, MessageSubagent, and StopSubagent. */
export const AkeruWorkerStatus = Schema.Struct({
  workerId: AkeruWorkerId,
  task: TrimmedNonEmptyString,
  phase: AkeruWorkerPhase,
});
export type AkeruWorkerStatus = typeof AkeruWorkerStatus.Type;

export const isAkeruWorkerTerminal = (phase: AkeruWorkerPhase): boolean => phase._tag !== "Running";
