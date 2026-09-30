import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import {
  AKERU_CHILD_WAIT_DEFAULT_TIMEOUT,
  AKERU_ROUTINE_REVIEW_TIMEOUT,
  makePendingWaiters,
  PendingWaiterClosedError,
  PendingWaiterExistsError,
  PendingWaiterTimeoutError,
} from "./PendingWaiters.ts";

const childOptions = (timeout: Duration.Input) => ({
  timeout,
  timeoutMessage: "The delegation deadline expired.",
});

const waitForOpen = (waiters: { readonly get: (key: string) => unknown }, key: string) =>
  Effect.gen(function* () {
    // The waiter registers synchronously once the forked fiber starts running.
    yield* Effect.yieldNow;
    assert.isDefined(waiters.get(key), `waiter '${key}' did not open`);
  });

describe("PendingWaiters", () => {
  describe("child waiters", () => {
    it.effect("resolves with the child's outcome", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<null, string>("stopped");
        const fiber = yield* waiters
          .wait("child", null, childOptions(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT))
          .pipe(Effect.forkChild);
        yield* waitForOpen(waiters, "child");
        assert.isTrue(waiters.resolve("child", "done"));
        assert.strictEqual(yield* Fiber.join(fiber), "done");
        assert.isUndefined(waiters.get("child"));
        assert.isFalse(waiters.resolve("child", "again"));
      }).pipe(Effect.scoped),
    );

    it.effect("rejects with the caller's error", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<null, string, Error>("stopped");
        const fiber = yield* waiters
          .wait("child", null, childOptions(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT))
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "child");
        const error = new Error("child failed");
        assert.isTrue(waiters.reject("child", error));
        assert.strictEqual(yield* Fiber.join(fiber), error);
        assert.isUndefined(waiters.get("child"));
      }).pipe(Effect.scoped),
    );

    it.effect("times out at the deadline", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<null, string>("stopped");
        const fiber = yield* waiters
          .wait("child", null, childOptions(Duration.minutes(10)))
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "child");
        yield* TestClock.adjust(10 * 60_000 - 1);
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust(1);
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, PendingWaiterTimeoutError);
        assert.strictEqual(error.message, "The delegation deadline expired.");
        assert.isUndefined(waiters.get("child"));
      }).pipe(Effect.scoped),
    );

    it.effect("fails at once when the deadline has already passed", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<null, string>("stopped");
        const error = yield* waiters
          .wait("child", null, childOptions(Duration.millis(-5)))
          .pipe(Effect.flip);
        assert.instanceOf(error, PendingWaiterTimeoutError);
        assert.isUndefined(waiters.get("child"));
      }).pipe(Effect.scoped),
    );

    it.effect("times out after the bounded default when there is no deadline", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<null, string>("stopped");
        const fiber = yield* waiters
          .wait("child", null, {
            timeout: AKERU_CHILD_WAIT_DEFAULT_TIMEOUT,
            timeoutMessage: "The bot did not report back within 4 hours.",
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "child");
        yield* TestClock.adjust(4 * 3_600_000 - 1);
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust(1);
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, PendingWaiterTimeoutError);
        assert.strictEqual(error.message, "The bot did not report back within 4 hours.");
      }).pipe(Effect.scoped),
    );

    it.effect("rejects a second waiter for the same child", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<null, string>("stopped");
        const first = yield* waiters
          .wait("child", null, childOptions(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT))
          .pipe(Effect.forkChild);
        yield* waitForOpen(waiters, "child");
        const error = yield* waiters
          .wait("child", null, {
            ...childOptions(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT),
            existsMessage: "Delegation waiter already exists for 'child'.",
          })
          .pipe(Effect.flip);
        assert.instanceOf(error, PendingWaiterExistsError);
        assert.strictEqual(error.message, "Delegation waiter already exists for 'child'.");
        waiters.resolve("child", "done");
        assert.strictEqual(yield* Fiber.join(first), "done");
      }).pipe(Effect.scoped),
    );

    it.effect("fails outstanding waiters when the scope closes", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const waiters = yield* makePendingWaiters<null, string>(
          "The agent controller stopped.",
        ).pipe(Scope.provide(scope));
        const fiber = yield* waiters
          .wait("child", null, childOptions(AKERU_CHILD_WAIT_DEFAULT_TIMEOUT))
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "child");
        yield* Scope.close(scope, Exit.void);
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, PendingWaiterClosedError);
        assert.strictEqual(error.message, "The agent controller stopped.");
        assert.isUndefined(waiters.get("child"));
      }),
    );
  });

  describe("routine requests", () => {
    const meta = { threadId: "thread-1", timezone: "UTC" };
    const reviewOptions = {
      timeout: AKERU_ROUTINE_REVIEW_TIMEOUT,
      timeoutMessage: "The routine review expired without a response.",
    };

    it.effect("opens the review, exposes its metadata, and resolves", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        );
        let opened = 0;
        const fiber = yield* waiters
          .wait("routine-1", meta, { ...reviewOptions, onOpen: () => opened++ })
          .pipe(Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        assert.strictEqual(opened, 1);
        assert.deepStrictEqual(waiters.get("routine-1"), meta);
        assert.deepStrictEqual(waiters.entries(), [["routine-1", meta]]);
        assert.isTrue(waiters.resolve("routine-1", { status: "cancelled" }));
        assert.deepStrictEqual(yield* Fiber.join(fiber), { status: "cancelled" });
        assert.deepStrictEqual(waiters.entries(), []);
      }).pipe(Effect.scoped),
    );

    it.effect("rejects when the turn ends first", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        );
        const fiber = yield* waiters
          .wait("routine-1", meta, reviewOptions)
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        assert.isTrue(waiters.reject("routine-1", new Error("The routine review ended.")));
        const error = yield* Fiber.join(fiber);
        assert.strictEqual(error.message, "The routine review ended.");
      }).pipe(Effect.scoped),
    );

    it.effect("times out after the review limit", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        );
        const fiber = yield* waiters
          .wait("routine-1", meta, reviewOptions)
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        yield* TestClock.adjust(3_600_000 - 1);
        assert.isUndefined(fiber.pollUnsafe());
        yield* TestClock.adjust(1);
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, PendingWaiterTimeoutError);
        assert.strictEqual(error.message, "The routine review expired without a response.");
        assert.isUndefined(waiters.get("routine-1"));
      }).pipe(Effect.scoped),
    );

    it.effect("keeps a review answered before the limit open while creation runs", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        );
        const fiber = yield* waiters.wait("routine-1", meta, reviewOptions).pipe(Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        yield* TestClock.adjust(3_600_000 - 1_000);
        assert.deepStrictEqual(waiters.claim("routine-1"), meta);
        assert.isUndefined(waiters.claim("routine-1"));
        assert.isUndefined(waiters.get("routine-1"));
        assert.deepStrictEqual(waiters.entries(), []);
        // Creation is slow enough to cross the review limit.
        yield* TestClock.adjust(Duration.minutes(5));
        assert.isUndefined(fiber.pollUnsafe());
        assert.isTrue(waiters.resolve("routine-1", { status: "created" }));
        assert.deepStrictEqual(yield* Fiber.join(fiber), { status: "created" });
      }).pipe(Effect.scoped),
    );

    it.effect("reports a claimed review's creation failure", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        );
        const fiber = yield* waiters
          .wait("routine-1", meta, reviewOptions)
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        assert.isDefined(waiters.claim("routine-1"));
        assert.isTrue(waiters.reject("routine-1", new Error("Routine limit reached.")));
        const error = yield* Fiber.join(fiber);
        assert.strictEqual(error.message, "Routine limit reached.");
      }).pipe(Effect.scoped),
    );

    it.effect("refuses to claim a review that already expired", () =>
      Effect.gen(function* () {
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        );
        const fiber = yield* waiters
          .wait("routine-1", meta, reviewOptions)
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        yield* TestClock.adjust(AKERU_ROUTINE_REVIEW_TIMEOUT);
        assert.isUndefined(waiters.claim("routine-1"));
        assert.instanceOf(yield* Fiber.join(fiber), PendingWaiterTimeoutError);
      }).pipe(Effect.scoped),
    );

    it.effect("fails a claimed review when the scope closes", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "stopped",
        ).pipe(Scope.provide(scope));
        const fiber = yield* waiters
          .wait("routine-1", meta, reviewOptions)
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        assert.isDefined(waiters.claim("routine-1"));
        yield* Scope.close(scope, Exit.void);
        assert.instanceOf(yield* Fiber.join(fiber), PendingWaiterClosedError);
      }),
    );

    it.effect("fails an open review when the scope closes", () =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const waiters = yield* makePendingWaiters<typeof meta, { readonly status: string }, Error>(
          "The agent controller stopped before the routine review finished.",
        ).pipe(Scope.provide(scope));
        const fiber = yield* waiters
          .wait("routine-1", meta, reviewOptions)
          .pipe(Effect.flip, Effect.forkChild);
        yield* waitForOpen(waiters, "routine-1");
        yield* Scope.close(scope, Exit.void);
        const error = yield* Fiber.join(fiber);
        assert.instanceOf(error, PendingWaiterClosedError);
        assert.deepStrictEqual(waiters.entries(), []);
      }),
    );
  });
});
