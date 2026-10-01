import { EnvironmentId } from "@akeru/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as EnvironmentRegistry from "./registry.ts";
import * as EnvironmentSupervisor from "./supervisor.ts";
import { TARGET, makeHarness, awaitConnectionState } from "./registry.test-support.ts";

describe("EnvironmentRegistry", () => {
  it.effect("exposes the current RPC generation to late query subscribers", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );

        const generation = yield* registry
          .runStream(
            TARGET.environmentId,
            Stream.unwrap(
              EnvironmentSupervisor.EnvironmentSupervisor.pipe(
                Effect.map((supervisor) =>
                  Stream.concat(
                    Stream.fromEffect(SubscriptionRef.get(supervisor.state)),
                    SubscriptionRef.changes(supervisor.state),
                  ).pipe(
                    Stream.filterMap((state) =>
                      state.phase === "connected"
                        ? Result.succeed(state.generation)
                        : Result.failVoid,
                    ),
                    Stream.changes,
                  ),
                ),
              ),
            ),
          )
          .pipe(Stream.runHead, Effect.map(Option.getOrThrow));

        expect(generation).toBe(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves a disconnected environment alone when a retry asks only if desired", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        yield* registry.run(
          TARGET.environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.flatMap((supervisor) => supervisor.disconnect),
          ),
        );
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "available" && !state.desired,
        );

        yield* registry.retryNow(TARGET.environmentId, { onlyIfDesired: true });
        expect((yield* registry.state(TARGET.environmentId)).desired).toBe(false);

        yield* registry.retryNow(TARGET.environmentId);
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected" && state.desired,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps a disconnect that lands before a conditional retry reads the state", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([TARGET]);
      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.start;
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "connected",
        );
        // The published state still says desired while the disconnect's intent is already false.
        yield* registry.run(
          TARGET.environmentId,
          EnvironmentSupervisor.EnvironmentSupervisor.pipe(
            Effect.flatMap((supervisor) => supervisor.disconnect),
          ),
        );
        yield* registry.retryNow(TARGET.environmentId, { onlyIfDesired: true });
        yield* awaitConnectionState(
          registry,
          TARGET.environmentId,
          (state) => state.phase === "available" && !state.desired,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ignores retry signals for environments that are no longer registered", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness([]);

      yield* Effect.gen(function* () {
        const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
        yield* registry.retryNow(EnvironmentId.make("removed-environment"));
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
