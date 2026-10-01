import {
  AkeruWorkerId,
  type AkeruDelegationAccessGrant,
  type AkeruToolId,
  type AkeruToolInputSchemas,
  type AkeruWorkerPhase,
  type AkeruWorkerStatus,
  type ThreadId,
  type TurnId,
} from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

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

export function workerInstructions(input: (typeof AkeruToolInputSchemas.Task)["Type"]): string {
  return [
    "You are a temporary worker started by a bot for one bounded subtask.",
    `Task: ${input.task}`,
    ...(input.expectedResult ? [`Expected result: ${input.expectedResult}`] : []),
    "Do only this task. End with a concise final result, or a concrete blocker.",
  ].join("\n");
}

export function workerTitle(task: string): string {
  const firstLine = task.split("\n", 1)[0]!.trim();

  return `Worker: ${firstLine.length > 60 ? `${firstLine.slice(0, 57)}...` : firstLine}`;
}

export interface WorkerEntry {
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

export const childThreadOf = (phase: AkeruWorkerPhase): ThreadId | null => phase.childThreadId;
