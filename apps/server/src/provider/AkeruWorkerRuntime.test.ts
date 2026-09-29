import { assert, it } from "@effect/vitest";
import {
  AKERU_TOOL_CATALOG,
  AKERU_WORKER_TIMEOUT_MS,
  type AkeruDelegationAccessGrant,
  type AkeruWorkerId,
  type AkeruWorkerStatus,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  AkeruWorkerError,
  type AkeruWorkerParent,
  type AkeruWorkerPort,
  makeAkeruWorkerRuntime,
} from "./AkeruWorkerRuntime.ts";

const access: AkeruDelegationAccessGrant = {
  allowedToolIds: AKERU_TOOL_CATALOG.map((tool) => tool.id),
  memoryScopes: ["private", "bot"],
  sandbox: null,
  runtimeMode: "full-access",
  hasUserComputer: true,
  enabledMcpServerIds: [],
  disabledMcpServerIds: [],
  approvalCeiling: "secrets",
};

const parent: AkeruWorkerParent = {
  threadId: ThreadId.make("parent-thread"),
  turnId: TurnId.make("parent-turn"),
  depth: 0,
  access,
};

/**
 * A fake orchestration port. `turns` receives each child turn as it starts.
 * `failTurns` makes every turn dispatch fail.
 */
const makeHarnessWith = (options?: {
  readonly failTurns?: boolean;
  /** Holds child creation until the deferred completes. */
  readonly createGate?: Deferred.Deferred<void>;
}) =>
  Effect.gen(function* () {
    const turns = yield* Queue.unbounded<{
      readonly childThreadId: ThreadId;
      readonly text: string;
    }>();
    const interrupted: ThreadId[] = [];
    const discarded: ThreadId[] = [];
    let created = 0;
    let ids = 0;
    const port: AkeruWorkerPort = {
      createChild: () =>
        (options?.createGate ? Deferred.await(options.createGate) : Effect.void).pipe(
          Effect.andThen(Effect.sync(() => ThreadId.make(`child-${++created}`))),
        ),
      messageChild: (childThreadId, text) =>
        options?.failTurns
          ? Effect.fail(new AkeruWorkerError({ reason: "start_failed", detail: "rejected" }))
          : Effect.asVoid(Queue.offer(turns, { childThreadId, text })),
      interruptChild: (childThreadId) => Effect.sync(() => void interrupted.push(childThreadId)),
      discardChild: (childThreadId) => Effect.sync(() => void discarded.push(childThreadId)),
    };
    const runtime = yield* makeAkeruWorkerRuntime(port, { makeId: () => String(++ids) });
    return { runtime, turns, interrupted, discarded };
  });
const makeHarness = makeHarnessWith();

const phaseOf = (status: AkeruWorkerStatus) => status.phase._tag;

it.effect("returns the worker result and runs the child with a narrowed grant", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns } = yield* makeHarness;
      const spawned = yield* Effect.forkChild(
        runtime.spawn(parent, { task: "Summarize the README", expectedResult: "Three bullets" }),
      );
      const turn = yield* Queue.take(turns);
      assert.include(turn.text, "Task: Summarize the README");
      assert.include(turn.text, "Expected result: Three bullets");

      const childAccess = runtime.accessForThread(turn.childThreadId);
      assert.isDefined(childAccess);
      assert.deepStrictEqual(childAccess!.memoryScopes, []);
      assert.strictEqual(childAccess!.approvalCeiling, "none");
      // A null sandbox stays without a workspace; top-level callers pass `local` explicitly.
      assert.strictEqual(childAccess!.sandbox, null);
      assert.isFalse(childAccess!.hasUserComputer);
      assert.notInclude(childAccess!.allowedToolIds, "Task");
      assert.notInclude(childAccess!.allowedToolIds, "SendToAgent");
      assert.notInclude(childAccess!.allowedToolIds, "request_box_help");
      assert.notInclude(childAccess!.allowedToolIds, "ReactToMessage");
      assert.include(childAccess!.allowedToolIds, "Read");
      assert.strictEqual(runtime.depthForThread(turn.childThreadId), 1);
      assert.strictEqual(runtime.depthForThread(parent.threadId), 0);
      // A worker chat left over from before a restart still counts as a worker.
      assert.strictEqual(runtime.depthForThread(ThreadId.make("worker-thread-orphaned")), 1);

      yield* runtime.childTurnFinished(turn.childThreadId, {
        state: "completed",
        summary: "  done  ",
      });
      const status = yield* Fiber.join(spawned);
      assert.strictEqual(status.workerId, "worker-1");
      assert.deepInclude(status.phase, {
        _tag: "Completed",
        childThreadId: turn.childThreadId,
        result: "done",
      });
    }),
  ),
);

it.effect("reports a failed child turn as Failed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns } = yield* makeHarness;
      const running = yield* runtime.spawn(parent, { task: "Break", background: true });
      const turn = yield* Queue.take(turns);
      yield* runtime.childTurnFinished(turn.childThreadId, { state: "failed", error: "boom" });
      const status = yield* runtime.check(parent, { workerId: running.workerId, wait: true });
      assert.deepInclude(status.phase, {
        _tag: "Failed",
        failureCode: "worker_failed",
        message: "boom",
      });
    }),
  ),
);

it.effect("discards the hidden child when its first turn cannot start", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, discarded } = yield* makeHarnessWith({ failTurns: true });
      const status = yield* runtime.spawn(parent, { task: "Never starts" });
      assert.deepInclude(status.phase, {
        _tag: "Failed",
        childThreadId: ThreadId.make("child-1"),
        failureCode: "internal",
        message: "rejected",
      });
      assert.deepStrictEqual(discarded, [ThreadId.make("child-1")]);
      assert.isUndefined(runtime.accessForThread(ThreadId.make("child-1")));
    }),
  ),
);

it.effect("refuses to start workers from a worker", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime } = yield* makeHarness;
      const error = yield* Effect.flip(
        runtime.spawn({ ...parent, depth: 1 }, { task: "Nested", background: true }),
      );
      assert.strictEqual(error.reason, "depth_limit");
      assert.strictEqual(error.message, "Temporary workers cannot start other workers.");
    }),
  ),
);

it.effect("limits running workers per turn and frees a slot when one stops", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime } = yield* makeHarness;
      const first = yield* runtime.spawn(parent, { task: "One", background: true });
      yield* runtime.spawn(parent, { task: "Two", background: true });
      yield* runtime.spawn(parent, { task: "Three", background: true });
      const error = yield* Effect.flip(runtime.spawn(parent, { task: "Four", background: true }));
      assert.strictEqual(error.reason, "concurrency_limit");
      assert.include(error.message, "3 running workers");

      const otherParent = { ...parent, threadId: ThreadId.make("other-thread") };
      yield* runtime.spawn(otherParent, { task: "Elsewhere", background: true });

      yield* runtime.stop(parent, { workerId: first.workerId });
      const fourth = yield* runtime.spawn(parent, { task: "Four", background: true });
      assert.strictEqual(phaseOf(fourth), "Running");
    }),
  ),
);

it.effect("sends follow-ups and completes after the last open turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns } = yield* makeHarness;
      const running = yield* runtime.spawn(parent, { task: "Draft", background: true });
      const first = yield* Queue.take(turns);

      const messaged = yield* runtime.message(parent, {
        workerId: running.workerId,
        message: "Also add a title",
      });
      assert.strictEqual(phaseOf(messaged), "Running");
      const followUp = yield* Queue.take(turns);
      assert.deepStrictEqual(followUp, {
        childThreadId: first.childThreadId,
        text: "Also add a title",
      });

      yield* runtime.childTurnFinished(first.childThreadId, {
        state: "completed",
        summary: "draft",
      });
      const between = yield* runtime.check(parent, { workerId: running.workerId });
      assert.strictEqual(phaseOf(between), "Running");

      yield* runtime.childTurnFinished(first.childThreadId, {
        state: "completed",
        summary: "draft with title",
      });
      const done = yield* runtime.check(parent, { workerId: running.workerId, wait: true });
      assert.deepInclude(done.phase, { _tag: "Completed", result: "draft with title" });

      const error = yield* Effect.flip(
        runtime.message(parent, { workerId: running.workerId, message: "More" }),
      );
      assert.strictEqual(error.reason, "not_running");
    }),
  ),
);

it.effect("stops a worker, interrupts its child, and reports Canceled", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns, interrupted } = yield* makeHarness;
      const running = yield* runtime.spawn(parent, { task: "Long job", background: true });
      const turn = yield* Queue.take(turns);

      const stopped = yield* runtime.stop(parent, { workerId: running.workerId });
      assert.deepInclude(stopped.phase, { _tag: "Canceled", canceledBy: "stop" });
      assert.deepStrictEqual(interrupted, [turn.childThreadId]);

      const checked = yield* runtime.check(parent, { workerId: running.workerId });
      assert.deepInclude(checked.phase, { _tag: "Canceled", canceledBy: "stop" });

      // A late child result cannot resurrect a canceled worker.
      yield* runtime.childTurnFinished(turn.childThreadId, { state: "completed", summary: "x" });
      const again = yield* runtime.stop(parent, { workerId: running.workerId });
      assert.strictEqual(phaseOf(again), "Canceled");
      assert.deepStrictEqual(interrupted, [turn.childThreadId]);
    }),
  ),
);

it.effect("cancels every running worker when the parent turn ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns, interrupted } = yield* makeHarness;
      const background = yield* runtime.spawn(parent, { task: "Background", background: true });
      const foreground = yield* Effect.forkChild(runtime.spawn(parent, { task: "Foreground" }));
      const firstTurn = yield* Queue.take(turns);
      const secondTurn = yield* Queue.take(turns);

      yield* runtime.parentTurnEnded(parent.threadId);

      const waited = yield* Fiber.join(foreground);
      assert.deepInclude(waited.phase, { _tag: "Canceled", canceledBy: "parent-turn-ended" });
      const checked = yield* runtime.check(parent, { workerId: background.workerId });
      assert.deepInclude(checked.phase, { _tag: "Canceled", canceledBy: "parent-turn-ended" });
      assert.sameMembers(interrupted, [firstTurn.childThreadId, secondTurn.childThreadId]);
    }),
  ),
);

it.effect("fails a worker that outlives its deadline", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns, interrupted } = yield* makeHarness;
      const running = yield* runtime.spawn(parent, { task: "Slow", background: true });
      const turn = yield* Queue.take(turns);
      yield* TestClock.adjust(Duration.millis(AKERU_WORKER_TIMEOUT_MS));
      const status = yield* runtime.check(parent, { workerId: running.workerId, wait: true });
      assert.deepInclude(status.phase, { _tag: "Failed", failureCode: "timeout" });
      assert.deepStrictEqual(interrupted, [turn.childThreadId]);
    }),
  ).pipe(Effect.provide(TestClock.layer())),
);

it.effect("hides workers from other chats", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime } = yield* makeHarness;
      const running = yield* runtime.spawn(parent, { task: "Mine", background: true });
      const error = yield* Effect.flip(
        runtime.check(
          { threadId: ThreadId.make("other-thread") },
          { workerId: running.workerId as AkeruWorkerId },
        ),
      );
      assert.strictEqual(error.reason, "not_found");
    }),
  ),
);

it.effect("discards the child of a worker stopped while the child was created", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const createGate = yield* Deferred.make<void>();
      const { runtime, turns, discarded } = yield* makeHarnessWith({ createGate });
      const running = yield* runtime.spawn(parent, { task: "Early stop", background: true });
      const stopping = yield* Effect.forkChild(
        runtime.stop(parent, { workerId: running.workerId }),
      );
      yield* Effect.yieldNow;
      yield* Deferred.succeed(createGate, undefined);
      const stopped = yield* Fiber.join(stopping);
      assert.strictEqual(phaseOf(stopped), "Canceled");
      assert.deepStrictEqual(discarded, [ThreadId.make("child-1")]);
      assert.strictEqual(yield* Queue.size(turns), 0);
    }),
  ),
);

it.effect("keeps workers of a newer turn when an earlier turn ends", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns } = yield* makeHarness;
      const running = yield* runtime.spawn(
        { ...parent, turnId: TurnId.make("next-turn") },
        { task: "Next turn work", background: true },
      );
      yield* Queue.take(turns);
      yield* runtime.parentTurnEnded(parent.threadId, parent.turnId);
      const checked = yield* runtime.check(parent, { workerId: running.workerId });
      assert.strictEqual(phaseOf(checked), "Running");
    }),
  ),
);

it.effect("lets a queued follow-up answer after an earlier turn fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns } = yield* makeHarness;
      const running = yield* runtime.spawn(parent, { task: "Retry", background: true });
      const first = yield* Queue.take(turns);
      yield* runtime.message(parent, { workerId: running.workerId, message: "Try again" });
      yield* Queue.take(turns);
      yield* runtime.childTurnFinished(first.childThreadId, { state: "failed", error: "boom" });
      const between = yield* runtime.check(parent, { workerId: running.workerId });
      assert.strictEqual(phaseOf(between), "Running");
      yield* runtime.childTurnFinished(first.childThreadId, {
        state: "completed",
        summary: "fixed",
      });
      const done = yield* runtime.check(parent, { workerId: running.workerId, wait: true });
      assert.deepInclude(done.phase, { _tag: "Completed", result: "fixed" });
    }),
  ),
);

it.effect("keeps the worker grant on a child after its parent session is released", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { runtime, turns } = yield* makeHarness;
      yield* runtime.spawn(parent, { task: "Released", background: true });
      const turn = yield* Queue.take(turns);
      yield* runtime.releaseThread(parent.threadId);
      assert.strictEqual(runtime.accessForThread(turn.childThreadId)?.approvalCeiling, "none");
      assert.strictEqual(runtime.depthForThread(turn.childThreadId), 1);
    }),
  ),
);
