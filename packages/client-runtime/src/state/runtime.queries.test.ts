import { describe, expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Latch from "effect/Latch";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { ConnectionTransientError } from "../connection/model.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import { executeAtomQuery } from "./runtime.ts";
import {
  QUERY_ENVIRONMENT,
  QUERY_RPC_SESSION,
  TestQueryError,
  OFFLINE_QUERY_FAILURE,
  BLOCKED_QUERY_FAILURE,
  queryConnectionState,
  makeEnvironmentQueryHarness,
  mountEnvironmentQuery,
} from "./runtime.test-support.ts";

describe("environment query lifecycle", () => {
  it.effect(
    "retries an interrupted query without exposing a failure during session replacement",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const firstStarted = Latch.makeUnsafe();
          const failFirst = Latch.makeUnsafe();
          const firstSettled = Latch.makeUnsafe();

          const unavailable = new EnvironmentRpcUnavailableError({
            environmentId: QUERY_ENVIRONMENT.environmentId,
            message: "Query environment is not connected.",
          });

          let executions = 0;

          const execute = Effect.suspend(() => {
            executions += 1;

            if (executions > 1) {
              return Effect.succeed("recovered");
            }

            firstStarted.openUnsafe();

            return failFirst.await.pipe(
              Effect.andThen(Effect.fail(unavailable)),
              Effect.ensuring(
                Effect.sync(() => {
                  firstSettled.openUnsafe();
                }),
              ),
            );
          });

          const harness = yield* makeEnvironmentQueryHarness(execute);
          const registry = AtomRegistry.make();
          const observed: Array<AsyncResult.AsyncResult<string, unknown>> = [];

          const unsubscribe = registry.subscribe(
            harness.atom,
            (result) => {
              observed.push(result);
            },
            { immediate: true },
          );

          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              unsubscribe();
              registry.dispose();
            }),
          );

          yield* firstStarted.await;
          yield* SubscriptionRef.set(harness.supervisorSession, Option.none());
          yield* Effect.yieldNow;
          failFirst.openUnsafe();
          yield* firstSettled.await;
          yield* Effect.yieldNow;

          expect(observed.some(AsyncResult.isFailure)).toBe(false);

          yield* SubscriptionRef.set(
            harness.supervisorState,
            queryConnectionState({ phase: "connecting", stage: "preparing" }),
          );
          yield* Effect.yieldNow;
          yield* SubscriptionRef.set(
            harness.supervisorState,
            queryConnectionState({
              phase: "backoff",
              stage: null,
              lastFailure: new ConnectionTransientError({
                reason: "transport",
                detail: "Relay session is reconnecting.",
              }),
              retryAt: 1,
            }),
          );
          yield* Effect.yieldNow;

          yield* SubscriptionRef.set(harness.supervisorSession, Option.some(QUERY_RPC_SESSION));
          yield* SubscriptionRef.set(
            harness.supervisorState,
            queryConnectionState({ generation: 2 }),
          );
          expect(
            yield* AtomRegistry.getResult(registry, harness.atom, {
              suspendOnWaiting: true,
            }),
          ).toBe("recovered");
        }),
      ),
  );

  it.effect.each([
    {
      condition: "after a manual disconnect",
      state: queryConnectionState({
        desired: false,
        phase: "available",
        stage: null,
        attempt: 0,
      }),
      expectedFailure: null,
    },
    {
      condition: "while the environment is offline",
      state: queryConnectionState({
        network: "offline",
        phase: "offline",
        stage: null,
        lastFailure: OFFLINE_QUERY_FAILURE,
      }),
      expectedFailure: OFFLINE_QUERY_FAILURE,
    },
    {
      condition: "when connection recovery is blocked",
      state: queryConnectionState({
        phase: "blocked",
        stage: null,
        lastFailure: BLOCKED_QUERY_FAILURE,
      }),
      expectedFailure: BLOCKED_QUERY_FAILURE,
    },
  ] as const)("settles as unavailable $condition", ({ state, expectedFailure }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeEnvironmentQueryHarness(Effect.succeed("connected"));
        const registry = yield* mountEnvironmentQuery(harness.atom);

        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("connected");

        yield* SubscriptionRef.set(harness.supervisorState, state);
        yield* Effect.yieldNow;

        const result = registry.get(harness.atom);
        expect(AsyncResult.isFailure(result)).toBe(true);
        expect(result.waiting).toBe(false);

        if (AsyncResult.isFailure(result) && expectedFailure !== null) {
          expect(Cause.squash(result.cause)).toBe(expectedFailure);
        }
      }),
    ),
  );

  it.effect("keeps a genuine query failure settled while reconnecting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expectedFailure = new TestQueryError({ message: "Query failed." });
        const firstStarted = Latch.makeUnsafe();
        const failFirst = Latch.makeUnsafe();
        const refreshStarted = Latch.makeUnsafe();
        const finishRefresh = Latch.makeUnsafe();
        let executions = 0;

        const execute = Effect.suspend(() => {
          executions += 1;

          if (executions === 1) {
            firstStarted.openUnsafe();

            return failFirst.await.pipe(Effect.andThen(Effect.fail(expectedFailure)));
          }

          refreshStarted.openUnsafe();

          return finishRefresh.await.pipe(Effect.as("recovered"));
        });

        const harness = yield* makeEnvironmentQueryHarness(execute);
        const registry = yield* mountEnvironmentQuery(harness.atom);

        yield* firstStarted.await;
        failFirst.openUnsafe();

        const initial = yield* AtomRegistry.getResult(registry, harness.atom, {
          suspendOnWaiting: true,
        }).pipe(Effect.exit);

        expect(Exit.isFailure(initial)).toBe(true);

        if (Exit.isFailure(initial)) {
          expect(Cause.squash(initial.cause)).toBe(expectedFailure);
        }

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ phase: "connecting", stage: "opening" }),
        );
        yield* Effect.yieldNow;

        const refreshing = registry.get(harness.atom);
        expect(AsyncResult.isFailure(refreshing)).toBe(true);
        expect(refreshing.waiting).toBe(true);

        if (AsyncResult.isFailure(refreshing)) {
          expect(Cause.squash(refreshing.cause)).toBe(expectedFailure);
        }

        yield* SubscriptionRef.set(
          harness.supervisorState,
          queryConnectionState({ generation: 2 }),
        );
        yield* refreshStarted.await;
        finishRefresh.openUnsafe();
        expect(
          yield* AtomRegistry.getResult(registry, harness.atom, {
            suspendOnWaiting: true,
          }),
        ).toBe("recovered");
      }),
    ),
  );
});

describe("executeAtomQuery", () => {
  it("keeps concurrent query results correlated to their atoms", async () => {
    const firstLatch = Latch.makeUnsafe();
    const secondLatch = Latch.makeUnsafe();
    const firstAtom = Atom.make(firstLatch.await.pipe(Effect.as("first")));
    const secondAtom = Atom.make(secondLatch.await.pipe(Effect.as("second")));
    const registry = AtomRegistry.make();

    const firstResult = executeAtomQuery(registry, firstAtom);
    const secondResult = executeAtomQuery(registry, secondAtom);

    secondLatch.openUnsafe();
    firstLatch.openUnsafe();

    const [first, second] = await Promise.all([firstResult, secondResult]);
    expect(first._tag).toBe("Success");
    expect(second._tag).toBe("Success");

    if (first._tag === "Success" && second._tag === "Success") {
      expect(first.value).toBe("first");
      expect(second.value).toBe("second");
    }

    registry.dispose();
  });
});
