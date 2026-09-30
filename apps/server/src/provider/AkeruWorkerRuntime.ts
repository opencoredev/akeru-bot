// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  AKERU_WORKER_MAX_CONCURRENCY,
  AKERU_WORKER_MAX_DEPTH,
  AKERU_WORKER_TIMEOUT_MS,
  AkeruWorkerId,
  type AkeruDelegationAccessGrant,
  type AkeruToolId,
  type AkeruToolInputSchemas,
  type AkeruWorkerPhase,
  type AkeruWorkerStatus,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

export class AkeruWorkerError extends Schema.TaggedErrorClass<AkeruWorkerError>()(
  "AkeruWorkerError",
  {
    reason: Schema.Literals([
      "depth_limit",
      "concurrency_limit",
      "not_found",
      "not_running",
      "start_failed",
    ]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

/** The bot turn that calls Task. Worker threads report depth 1. */
export interface AkeruWorkerParent {
  readonly threadId: ThreadId;
  readonly turnId: TurnId;
  readonly depth: number;
  readonly access: AkeruDelegationAccessGrant;
}

export interface AkeruWorkerChildSpec {
  readonly parentThreadId: ThreadId;
  readonly workerId: AkeruWorkerId;
  readonly title: string;
}

export interface AkeruWorkerChildOutcome {
  readonly state: "completed" | "failed";
  readonly summary?: string;
  readonly error?: string;
}

/**
 * Orchestration side effects. `createChild` only creates the hidden thread; the
 * runtime registers it before `messageChild` starts a turn, so the child
 * session always starts with the worker grant. `discardChild` removes a child
 * whose first turn never started, so no orphaned hidden thread remains.
 */
export interface AkeruWorkerPort {
  readonly createChild: (spec: AkeruWorkerChildSpec) => Effect.Effect<ThreadId, AkeruWorkerError>;
  readonly messageChild: (
    childThreadId: ThreadId,
    text: string,
  ) => Effect.Effect<void, AkeruWorkerError>;
  readonly interruptChild: (childThreadId: ThreadId) => Effect.Effect<void>;
  readonly discardChild: (childThreadId: ThreadId) => Effect.Effect<void>;
}

export interface AkeruWorkerRuntimeOptions {
  readonly maxDepth?: number;
  readonly maxConcurrency?: number;
  readonly timeout?: Duration.Duration;
  readonly makeId?: () => string;
}

/**
 * Tools a worker never receives. Workers do bounded work for one turn, so they
 * cannot start workers, delegate to bots, reach the user, or change bot and
 * channel state.
 */
export const AKERU_WORKER_EXCLUDED_TOOL_IDS: ReadonlySet<AkeruToolId> = new Set([
  "Task",
  "CheckSubagent",
  "MessageSubagent",
  "StopSubagent",
  "CreateAgent",
  "CheckAgent",
  "MessageAgent",
  "StopAgent",
  "SendToAgent",
  "CreateChannel",
  "UpdateChannel",
  "SendToUser",
  "request_box_help",
  "ReactToMessage",
  "UpdateBotProfile",
]);

/**
 * A worker runs in a hidden thread where nobody can answer an approval prompt.
 * The `none` ceiling makes approval-gated tools fail fast instead of waiting,
 * and without the user's computer the ExternalShell tools drop out.
 * The worker keeps the parent's sandbox. Callers pass a top-level bot's local
 * workspace as an explicit `local` sandbox, because a null sandbox on a
 * delegated grant means no workspace at all.
 */
/** Worker chats use this id prefix, so they stay recognizable after a server restart. */
export const WORKER_THREAD_ID_PREFIX = "worker-thread-";

export const isWorkerThreadId = (threadId: ThreadId): boolean =>
  String(threadId).startsWith(WORKER_THREAD_ID_PREFIX);

export function workerAccess(parent: AkeruDelegationAccessGrant): AkeruDelegationAccessGrant {
  return {
    ...parent,
    allowedToolIds: parent.allowedToolIds.filter(
      (toolId) => !AKERU_WORKER_EXCLUDED_TOOL_IDS.has(toolId),
    ),
    memoryScopes: [],
    hasUserComputer: false,
    approvalCeiling: "none",
  };
}

function workerInstructions(input: (typeof AkeruToolInputSchemas.Task)["Type"]): string {
  return [
    "You are a temporary worker started by a bot for one bounded subtask.",
    `Task: ${input.task}`,
    ...(input.expectedResult ? [`Expected result: ${input.expectedResult}`] : []),
    "Do only this task. End with a concise final result, or a concrete blocker.",
  ].join("\n");
}

function workerTitle(task: string): string {
  const firstLine = task.split("\n", 1)[0]!.trim();
  return `Worker: ${firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine}`;
}

interface WorkerEntry {
  readonly workerId: AkeruWorkerId;
  readonly parentThreadId: ThreadId;
  readonly parentTurnId: TurnId;
  readonly task: string;
  readonly phase: Ref.Ref<AkeruWorkerPhase>;
  readonly done: Deferred.Deferred<AkeruWorkerStatus>;
  readonly outcomes: Queue.Queue<AkeruWorkerChildOutcome>;
  /** Child turns dispatched but not yet finished: the first task plus each follow-up. */
  readonly openTurns: Ref.Ref<number>;
  readonly access: AkeruDelegationAccessGrant;
  fiber: Fiber.Fiber<void> | undefined;
}

const childThreadOf = (phase: AkeruWorkerPhase): ThreadId | null => phase.childThreadId;

export const makeAkeruWorkerRuntime = Effect.fn("makeAkeruWorkerRuntime")(function* (
  port: AkeruWorkerPort,
  options?: AkeruWorkerRuntimeOptions,
) {
  const scope: Scope.Scope = yield* Effect.scope;
  const maxDepth = options?.maxDepth ?? AKERU_WORKER_MAX_DEPTH;
  const maxConcurrency = options?.maxConcurrency ?? AKERU_WORKER_MAX_CONCURRENCY;
  const timeout = options?.timeout ?? Duration.millis(AKERU_WORKER_TIMEOUT_MS);
  const makeId = options?.makeId ?? (() => NodeCrypto.randomUUID());
  /** Serializes every phase transition, so stop, completion, and follow-ups never race. */
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const workers = new Map<AkeruWorkerId, WorkerEntry>();
  const byChildThread = new Map<ThreadId, WorkerEntry>();
  /** Worker grants by child thread. They outlive pruned workers, so a resumed child keeps them. */
  const childAccess = new Map<ThreadId, AkeruDelegationAccessGrant>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const statusOf = (entry: WorkerEntry) =>
    Effect.map(
      Ref.get(entry.phase),
      (phase): AkeruWorkerStatus => ({ workerId: entry.workerId, task: entry.task, phase }),
    );

  /** Moves a Running worker to a terminal phase once. Returns false when it already ended. */
  const settleUnlocked = (
    entry: WorkerEntry,
    terminal: (
      running: Extract<AkeruWorkerPhase, { _tag: "Running" }>,
      completedAt: string,
    ) => AkeruWorkerPhase | undefined,
  ) =>
    Effect.gen(function* () {
      const current = yield* Ref.get(entry.phase);
      if (current._tag !== "Running") return false;
      const next = terminal(current, yield* nowIso);
      if (!next) return false;
      yield* Ref.set(entry.phase, next);
      yield* Deferred.succeed(entry.done, yield* statusOf(entry));
      return true;
    });

  const cancel = (entry: WorkerEntry, canceledBy: "stop" | "parent-turn-ended") =>
    Effect.gen(function* () {
      const canceled = yield* locked(
        settleUnlocked(entry, (running, completedAt) => ({
          _tag: "Canceled",
          childThreadId: running.childThreadId,
          startedAt: running.startedAt,
          completedAt,
          canceledBy,
        })),
      );
      // Interrupting outside the lock lets the fiber finish its own cleanup. A
      // child still being created cannot be interrupted yet, so stop does not
      // wait there; the fiber discards that child once creation returns.
      if (canceled && entry.fiber) {
        const interrupt = Fiber.interrupt(entry.fiber);
        if (childThreadOf(yield* Ref.get(entry.phase)) === null) {
          yield* Effect.forkIn(interrupt, scope);
        } else {
          yield* interrupt;
        }
      }
      return yield* statusOf(entry);
    });

  const failWith = (
    entry: WorkerEntry,
    failureCode: "timeout" | "worker_failed" | "internal",
    message: string,
  ) =>
    locked(
      settleUnlocked(entry, (running, completedAt) => ({
        _tag: "Failed",
        childThreadId: running.childThreadId,
        startedAt: running.startedAt,
        completedAt,
        failureCode,
        message,
      })),
    );

  /** Waits for child turns until none remain open, then records the last result. */
  const awaitOutcomes = (entry: WorkerEntry) =>
    Effect.gen(function* () {
      while (true) {
        const outcome = yield* Queue.take(entry.outcomes);
        const finished = yield* locked(
          Effect.gen(function* () {
            const open = yield* Ref.updateAndGet(entry.openTurns, (count) =>
              Math.max(0, count - 1),
            );
            // A queued follow-up can still answer, so only the last open turn decides.
            if (open > 0) return false;
            if (outcome.state === "failed") {
              return yield* settleUnlocked(entry, (running, completedAt) => ({
                _tag: "Failed",
                childThreadId: running.childThreadId,
                startedAt: running.startedAt,
                completedAt,
                failureCode: "worker_failed",
                message: outcome.error?.trim() || "The worker turn failed.",
              }));
            }
            return yield* settleUnlocked(entry, (running, completedAt) =>
              running.childThreadId === null
                ? undefined
                : {
                    _tag: "Completed",
                    childThreadId: running.childThreadId,
                    startedAt: running.startedAt,
                    completedAt,
                    result: outcome.summary?.trim() || "The worker finished without a text result.",
                  },
            );
          }),
        );
        if (finished || (yield* Deferred.isDone(entry.done))) return;
      }
    });

  const runWorker = (entry: WorkerEntry, input: (typeof AkeruToolInputSchemas.Task)["Type"]) =>
    Effect.gen(function* () {
      // A half-created child would be unreachable by stop, so creation and
      // attachment finish together. A worker stopped meanwhile discards its child.
      const { childThreadId, attached } = yield* Effect.gen(function* () {
        const childThreadId = yield* port.createChild({
          parentThreadId: entry.parentThreadId,
          workerId: entry.workerId,
          title: workerTitle(input.task),
        });
        const attached = yield* locked(
          Effect.gen(function* () {
            const phase = yield* Ref.get(entry.phase);
            if (phase._tag !== "Running") return false;
            yield* Ref.set(entry.phase, { ...phase, childThreadId });
            byChildThread.set(childThreadId, entry);
            childAccess.set(childThreadId, entry.access);
            return true;
          }),
        );
        if (!attached) yield* port.discardChild(childThreadId);
        return { childThreadId, attached };
      }).pipe(Effect.uninterruptible);
      // Stopped while the child was being created: no turn ever starts there.
      if (!attached) return;
      yield* port.messageChild(childThreadId, workerInstructions(input)).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            byChildThread.delete(childThreadId);
            childAccess.delete(childThreadId);
          }).pipe(Effect.andThen(port.discardChild(childThreadId))),
        ),
        Effect.andThen(awaitOutcomes(entry)),
        Effect.onInterrupt(() => port.interruptChild(childThreadId)),
      );
    }).pipe(
      Effect.timeoutOption(timeout),
      Effect.flatMap((result) =>
        Option.isSome(result)
          ? Effect.void
          : failWith(
              entry,
              "timeout",
              `The worker did not finish within ${Duration.format(timeout)}.`,
            ),
      ),
      Effect.catch((error: AkeruWorkerError) => failWith(entry, "internal", error.detail)),
      Effect.asVoid,
    );

  const ownedWorker = (parentThreadId: ThreadId, workerId: AkeruWorkerId) => {
    const entry = workers.get(workerId);
    return entry && entry.parentThreadId === parentThreadId
      ? Effect.succeed(entry)
      : Effect.fail(
          new AkeruWorkerError({
            reason: "not_found",
            detail: `Worker '${workerId}' was not started by this chat.`,
          }),
        );
  };

  const runningCount = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      let count = 0;
      for (const entry of workers.values()) {
        if (entry.parentThreadId !== parentThreadId) continue;
        if ((yield* Ref.get(entry.phase))._tag === "Running") count += 1;
      }
      return count;
    });

  /**
   * Forgets settled workers from the parent's earlier turns, so a long chat keeps only the
   * current turn's workers. Their child threads keep the worker grant.
   */
  const pruneEarlierTurns = (parent: AkeruWorkerParent) =>
    Effect.gen(function* () {
      for (const [workerId, entry] of workers) {
        if (entry.parentThreadId !== parent.threadId || entry.parentTurnId === parent.turnId) {
          continue;
        }
        const phase = yield* Ref.get(entry.phase);
        if (phase._tag === "Running") continue;
        workers.delete(workerId);
        const childThreadId = childThreadOf(phase);
        if (childThreadId !== null) byChildThread.delete(childThreadId);
      }
    });

  const spawn = Effect.fn("AkeruWorkerRuntime.spawn")(function* (
    parent: AkeruWorkerParent,
    input: (typeof AkeruToolInputSchemas.Task)["Type"],
  ) {
    if (parent.depth >= maxDepth) {
      return yield* new AkeruWorkerError({
        reason: "depth_limit",
        detail: "Temporary workers cannot start other workers.",
      });
    }
    const entry = yield* locked(
      Effect.gen(function* () {
        yield* pruneEarlierTurns(parent);
        if ((yield* runningCount(parent.threadId)) >= maxConcurrency) {
          return yield* new AkeruWorkerError({
            reason: "concurrency_limit",
            detail: `This turn already has ${maxConcurrency} running workers. Check or stop one before starting another.`,
          });
        }
        const entry: WorkerEntry = {
          workerId: AkeruWorkerId.make(`worker-${makeId()}`),
          parentThreadId: parent.threadId,
          parentTurnId: parent.turnId,
          task: input.task,
          phase: yield* Ref.make<AkeruWorkerPhase>({
            _tag: "Running",
            childThreadId: null,
            startedAt: yield* nowIso,
          }),
          done: yield* Deferred.make<AkeruWorkerStatus>(),
          outcomes: yield* Queue.unbounded<AkeruWorkerChildOutcome>(),
          openTurns: yield* Ref.make(1),
          access: workerAccess(parent.access),
          fiber: undefined,
        };
        workers.set(entry.workerId, entry);
        // Forked under the lock so stop always sees the fiber.
        entry.fiber = yield* Effect.forkIn(runWorker(entry, input), scope);
        return entry;
      }),
    );
    return input.background ? yield* statusOf(entry) : yield* Deferred.await(entry.done);
  });

  const check = Effect.fn("AkeruWorkerRuntime.check")(function* (
    parent: Pick<AkeruWorkerParent, "threadId">,
    input: (typeof AkeruToolInputSchemas.CheckSubagent)["Type"],
  ) {
    const entry = yield* ownedWorker(parent.threadId, input.workerId);
    return input.wait ? yield* Deferred.await(entry.done) : yield* statusOf(entry);
  });

  const message = Effect.fn("AkeruWorkerRuntime.message")(function* (
    parent: Pick<AkeruWorkerParent, "threadId">,
    input: (typeof AkeruToolInputSchemas.MessageSubagent)["Type"],
  ) {
    const entry = yield* ownedWorker(parent.threadId, input.workerId);
    yield* locked(
      Effect.gen(function* () {
        const phase = yield* Ref.get(entry.phase);
        const childThreadId = childThreadOf(phase);
        if (phase._tag !== "Running" || childThreadId === null) {
          return yield* new AkeruWorkerError({
            reason: "not_running",
            detail:
              phase._tag === "Running"
                ? `Worker '${entry.workerId}' is still starting. Try again shortly.`
                : `Worker '${entry.workerId}' is ${phase._tag} and cannot take follow-ups.`,
          });
        }
        yield* Ref.update(entry.openTurns, (count) => count + 1);
        yield* port
          .messageChild(childThreadId, input.message)
          .pipe(Effect.tapError(() => Ref.update(entry.openTurns, (count) => count - 1)));
      }),
    );
    return yield* statusOf(entry);
  });

  const stop = Effect.fn("AkeruWorkerRuntime.stop")(function* (
    parent: Pick<AkeruWorkerParent, "threadId">,
    input: (typeof AkeruToolInputSchemas.StopSubagent)["Type"],
  ) {
    return yield* cancel(yield* ownedWorker(parent.threadId, input.workerId), "stop");
  });

  /** Feeds a finished child turn to its worker. Other threads are ignored. */
  const childTurnFinished = (childThreadId: ThreadId, outcome: AkeruWorkerChildOutcome) =>
    Effect.suspend(() => {
      const entry = byChildThread.get(childThreadId);
      return entry ? Effect.asVoid(Queue.offer(entry.outcomes, outcome)) : Effect.void;
    });

  /**
   * Cancels every running worker owned by a parent turn that ended or was interrupted.
   * Without a turn id it cancels every worker of the thread.
   */
  const parentTurnEnded = (parentThreadId: ThreadId, parentTurnId?: TurnId) =>
    Effect.suspend(() =>
      Effect.forEach(
        [...workers.values()].filter(
          (entry) =>
            entry.parentThreadId === parentThreadId &&
            (parentTurnId === undefined || entry.parentTurnId === parentTurnId),
        ),
        (entry) => cancel(entry, "parent-turn-ended"),
        { discard: true },
      ),
    );

  /**
   * Forgets finished workers of a thread whose session stopped. Their child
   * threads keep the worker grant, so a resumed child never gains the default one.
   */
  const releaseThread = (parentThreadId: ThreadId) =>
    Effect.gen(function* () {
      yield* parentTurnEnded(parentThreadId);
      for (const [workerId, entry] of workers) {
        if (entry.parentThreadId !== parentThreadId) continue;
        workers.delete(workerId);
        const childThreadId = childThreadOf(yield* Ref.get(entry.phase));
        if (childThreadId !== null) byChildThread.delete(childThreadId);
      }
    });

  return {
    spawn,
    check,
    message,
    stop,
    childTurnFinished,
    parentTurnEnded,
    releaseThread,
    /** The worker grant when the thread belongs to a worker. */
    accessForThread: (threadId: ThreadId): AkeruDelegationAccessGrant | undefined =>
      childAccess.get(threadId),
    /** 1 for worker threads, including ones a restart orphaned, 0 for bot turns. */
    depthForThread: (threadId: ThreadId): number =>
      childAccess.has(threadId) || isWorkerThreadId(threadId) ? 1 : 0,
  };
});

export type AkeruWorkerRuntime = Effect.Success<ReturnType<typeof makeAkeruWorkerRuntime>>;
