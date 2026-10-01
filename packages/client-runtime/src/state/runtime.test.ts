import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId } from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Latch from "effect/Latch";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { ConnectionTransientError } from "../connection/model.ts";
import {
  environmentRpcKey,
  executeAtomCommand,
  isAtomCommandInterrupted,
  mapAtomCommandResult,
  runAtomCommand,
  settleAsyncResult,
  settlePromise,
  squashAtomCommandFailure,
} from "./runtime.ts";
import {
  queryConnectionState,
  makeEnvironmentQueryHarness,
  mountEnvironmentQuery,
} from "./runtime.test-support.ts";

describe("settleAsyncResult", () => {
  it("preserves successful values and typed failures", async () => {
    const success = await settleAsyncResult(() => Promise.resolve(Exit.succeed("done")));
    expect(AsyncResult.isSuccess(success)).toBe(true);
    if (AsyncResult.isSuccess(success)) {
      expect(success.value).toBe("done");
    }

    const expectedFailure = new Error("request failed");
    const failure = await settleAsyncResult(() => Promise.resolve(Exit.fail(expectedFailure)));
    expect(AsyncResult.isFailure(failure)).toBe(true);
    if (AsyncResult.isFailure(failure)) {
      expect(Cause.hasDies(failure.cause)).toBe(false);
      expect(Cause.squash(failure.cause)).toBe(expectedFailure);
    }
  });

  it("encodes thrown and rejected promises as defects", async () => {
    const thrownDefect = new Error("thrown defect");
    const thrown = await settleAsyncResult<void, never>(() => {
      throw thrownDefect;
    });
    expect(AsyncResult.isFailure(thrown)).toBe(true);
    if (AsyncResult.isFailure(thrown)) {
      expect(Cause.hasDies(thrown.cause)).toBe(true);
      expect(Cause.squash(thrown.cause)).toBe(thrownDefect);
    }

    const rejectedDefect = new Error("rejected defect");
    const rejected = await settleAsyncResult<void, never>(() => Promise.reject(rejectedDefect));
    expect(AsyncResult.isFailure(rejected)).toBe(true);
    if (AsyncResult.isFailure(rejected)) {
      expect(Cause.hasDies(rejected.cause)).toBe(true);
      expect(Cause.squash(rejected.cause)).toBe(rejectedDefect);
    }
  });
});

describe("atom command result helpers", () => {
  it("maps successful command values", () => {
    const result = mapAtomCommandResult(AsyncResult.success(2), (value) => value * 3);

    expect(result._tag).toBe("Success");
    if (result._tag === "Success") {
      expect(result.value).toBe(6);
    }
  });

  it("preserves failures while mapping", () => {
    const result = mapAtomCommandResult(
      AsyncResult.failure<number, string>(Cause.fail("nope")),
      (value) => value * 3,
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.squash(result.cause)).toBe("nope");
    }
  });

  it("distinguishes interruption from other failures", () => {
    const interrupted = AsyncResult.failure(Cause.interrupt(1));
    const failed = AsyncResult.failure(Cause.fail("nope"));

    expect(isAtomCommandInterrupted(interrupted)).toBe(true);
    expect(isAtomCommandInterrupted(failed)).toBe(false);
    expect(squashAtomCommandFailure(failed)).toBe("nope");
  });

  it("settles raw promise boundaries as successes or defects", async () => {
    const success = await settlePromise(() => Promise.resolve("done"));
    expect(success._tag).toBe("Success");

    const defect = new Error("raw promise rejected");
    const failure = await settlePromise(() => Promise.reject(defect));
    expect(failure._tag).toBe("Failure");
    if (failure._tag === "Failure") {
      expect(Cause.hasDies(failure.cause)).toBe(true);
      expect(Cause.squash(failure.cause)).toBe(defect);
    }
  });

  it("reports expected failures and defects through separate policies", async () => {
    const warnings: string[] = [];
    const errors: string[] = [];
    const reporter = {
      warn: (message: string) => {
        warnings.push(message);
      },
      error: (message: string) => {
        errors.push(message);
      },
    };

    await executeAtomCommand(() => Promise.resolve(Exit.fail("nope")), { label: "save" }, reporter);
    await executeAtomCommand(
      () => Promise.resolve(Exit.fail("ignored")),
      { label: "quiet save", reportFailure: false },
      reporter,
    );
    await executeAtomCommand(
      () => Promise.reject(new Error("defect")),
      { label: "quiet save", reportFailure: false },
      reporter,
    );
    await executeAtomCommand(
      () => Promise.resolve(Exit.interrupt(1)),
      { label: "interrupted" },
      reporter,
    );

    expect(warnings).toEqual(["[atom-command] save failed"]);
    expect(errors).toEqual(["[atom-command] quiet save defected"]);
  });
});

describe("environmentRpcKey", () => {
  it("isolates subscription state by environment and cwd", () => {
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: { cwd: "/repo/original" },
    };
    const nextTarget = {
      environmentId,
      input: { cwd: "/repo/next" },
    };

    expect(environmentRpcKey(originalTarget)).not.toBe(environmentRpcKey(nextTarget));
    expect(environmentRpcKey(originalTarget)).toBe(environmentRpcKey({ ...originalTarget }));
    expect(
      environmentRpcKey({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(environmentRpcKey(originalTarget));
  });
});

describe("environment query lifecycle", () => {
  it.effect("retains the last successful value while reconnecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const refreshStarted = Latch.makeUnsafe();
        const finishRefresh = Latch.makeUnsafe();
        let executions = 0;
        const execute = Effect.suspend(() => {
          executions += 1;
          if (executions === 1) {
            return Effect.succeed("cached");
          }
          refreshStarted.openUnsafe();
          return finishRefresh.await.pipe(Effect.as("updated"));
        });
        const harness = yield* makeEnvironmentQueryHarness(execute);
        const registry = yield* mountEnvironmentQuery(harness.atom);

        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("cached");

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ phase: "connecting", stage: "opening" }),
        );
        yield* Effect.yieldNow;
        expect(registry.get(harness.atom)).toMatchObject({
          _tag: "Success",
          value: "cached",
          waiting: true,
        });

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({
            phase: "backoff",
            stage: null,
            lastFailure: new ConnectionTransientError({
              reason: "transport",
              detail: "Retrying.",
            }),
            retryAt: 1,
          }),
        );
        yield* Effect.yieldNow;
        expect(registry.get(harness.atom)).toMatchObject({
          _tag: "Success",
          value: "cached",
          waiting: true,
        });

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
        yield* refreshStarted.await;
        expect(registry.get(harness.atom)).toMatchObject({
          _tag: "Success",
          value: "cached",
          waiting: true,
        });

        finishRefresh.openUnsafe();
        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("updated");
      }),
    ),
  );
});

describe("Atom.fn mutation semantics", () => {
  it.effect(
    "allows concurrent effects to finish but does not correlate results to individual writes",
    () =>
      Effect.gen(function* () {
        const firstLatch = Latch.makeUnsafe();
        const secondLatch = Latch.makeUnsafe();
        const mutation = Atom.fn<never, "first" | "second", "first" | "second">(
          (id: "first" | "second") =>
            (id === "first" ? firstLatch : secondLatch).await.pipe(Effect.as(id)),
          { concurrent: true },
        );
        const registry = AtomRegistry.make();
        const unmount = registry.mount(mutation);

        registry.set(mutation, "first");
        const firstResult = yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }).pipe(Effect.forkChild({ startImmediately: true }));
        registry.set(mutation, "second");
        const secondResult = yield* AtomRegistry.getResult(registry, mutation, {
          suspendOnWaiting: true,
        }).pipe(Effect.forkChild({ startImmediately: true }));

        secondLatch.openUnsafe();
        yield* Effect.yieldNow;

        const stillWaiting = registry.get(mutation);
        expect(stillWaiting.waiting).toBe(true);

        firstLatch.openUnsafe();

        expect(yield* Fiber.join(firstResult)).toBe("first");
        expect(yield* Fiber.join(secondResult)).toBe("first");

        unmount();
        registry.dispose();
      }),
  );
});

describe("runtime command runner", () => {
  it("encodes custom command rejections as defects", async () => {
    const defect = new Error("custom command rejected");
    const registry = AtomRegistry.make();
    const result = await runAtomCommand(
      registry,
      {
        label: "test.rejected-command",
        run: () => Promise.reject(defect),
      },
      undefined,
      { reportDefect: false },
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(Cause.hasDies(result.cause)).toBe(true);
      expect(Cause.squash(result.cause)).toBe(defect);
    }
    registry.dispose();
  });
});
