import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  CACHED_SNAPSHOT_SEQUENCE,
  BASE_THREAD,
  awaitThreadState,
  makeHarness,
  snapshot,
  titleUpdated,
} from "./threads-sync.test-support.ts";

describe("EnvironmentThreads", () => {
  it.effect("publishes a burst of events delivered together as one state change", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* Queue.offer(harness.inputs, [
        titleUpdated("First", CACHED_SNAPSHOT_SEQUENCE + 1),
        titleUpdated("Second", CACHED_SNAPSHOT_SEQUENCE + 2),
        // A replayed sequence inside the batch is still ignored.
        titleUpdated("Replayed", CACHED_SNAPSHOT_SEQUENCE + 2),
        titleUpdated("Third", CACHED_SNAPSHOT_SEQUENCE + 3),
      ]);

      const published = yield* awaitThreadState(
        harness.observed,
        (value) => Option.isSome(value.data) && value.data.value.title !== BASE_THREAD.title,
      );

      // The first state carrying any event already carries all of them.
      expect(Option.getOrThrow(published.data).title).toBe("Third");

      // The resume cursor covers the whole batch.
      yield* harness.replaceSession;

      for (let attempt = 0; attempt < 100; attempt += 1) {
        if ((yield* Ref.get(harness.subscriptionCount)) >= 2) break;
        yield* Effect.yieldNow;
      }

      expect(yield* Ref.get(harness.lastSubscribeAfterSequence)).toBe(CACHED_SNAPSHOT_SEQUENCE + 3);
    }),
  );

  it.effect("does not overwrite a live snapshot when the supervisor becomes ready", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ cached: BASE_THREAD });
      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connecting",
        stage: "synchronizing",
        attempt: 1,
        generation: 0,
        lastFailure: null,
        retryAt: null,
      });
      yield* Queue.offer(harness.inputs, snapshot(BASE_THREAD));
      yield* awaitThreadState(harness.observed, (value) => value.status === "live");

      yield* SubscriptionRef.set(harness.supervisorState, {
        desired: true,
        network: "online",
        phase: "connected",
        stage: null,
        attempt: 1,
        generation: 1,
        lastFailure: null,
        retryAt: null,
      });

      for (let index = 0; index < 10; index += 1) {
        yield* Effect.yieldNow;
      }

      expect((yield* Ref.get(harness.latest)).status).toBe("live");
    }),
  );
});
