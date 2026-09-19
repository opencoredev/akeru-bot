import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import { makeKeyedDrainableWorker } from "./ProviderCommandReactor.ts";

describe("makeKeyedDrainableWorker", () => {
  it.live("runs independent keys while preserving same-thread start, stop, and restart FIFO", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedA1 = yield* Deferred.make<void>();
        const releaseA1 = yield* Deferred.make<void>();
        const startedB1 = yield* Deferred.make<void>();
        const processed: string[] = [];
        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          concurrency: 2,
          process: (item) =>
            Effect.gen(function* () {
              if (item === "start") {
                yield* Deferred.succeed(startedA1, undefined).pipe(Effect.orDie);
                yield* Deferred.await(releaseA1);
              }
              if (item === "approval") {
                processed.push(item);
                yield* Deferred.succeed(startedB1, undefined).pipe(Effect.orDie);
                return;
              }
              processed.push(item);
            }),
        });

        yield* worker.enqueue("thread-a", "start");
        yield* worker.enqueue("thread-a", "stop");
        yield* worker.enqueue("thread-a", "restart");
        yield* worker.enqueue("thread-b", "approval");
        yield* Deferred.await(startedA1);
        yield* Deferred.await(startedB1);

        expect(processed).toEqual(["approval"]);
        yield* Deferred.succeed(releaseA1, undefined);
        yield* worker.drain;
        expect(processed).toEqual(["approval", "start", "stop", "restart"]);
      }),
    ),
  );

  it.live("drain awaits active and queued work across lanes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const startedA = yield* Deferred.make<void>();
        const startedB = yield* Deferred.make<void>();
        const releaseA = yield* Deferred.make<void>();
        const releaseB = yield* Deferred.make<void>();
        const drained = yield* Deferred.make<void>();
        const worker = yield* makeKeyedDrainableWorker<string, string, never, never>({
          concurrency: 2,
          process: (item) =>
            Effect.gen(function* () {
              const started = item.startsWith("a") ? startedA : startedB;
              const release = item.startsWith("a") ? releaseA : releaseB;
              yield* Deferred.succeed(started, undefined).pipe(Effect.ignore);
              yield* Deferred.await(release);
            }),
        });

        yield* worker.enqueue("a", "a1");
        yield* worker.enqueue("a", "a2");
        yield* worker.enqueue("b", "b1");
        yield* Deferred.await(startedA);
        yield* Deferred.await(startedB);
        yield* Effect.forkChild(
          worker.drain.pipe(Effect.andThen(Deferred.succeed(drained, undefined)), Effect.asVoid),
        );

        yield* Deferred.succeed(releaseB, undefined);
        expect(yield* Deferred.isDone(drained)).toBe(false);
        yield* Deferred.succeed(releaseA, undefined);
        yield* Deferred.await(drained);
      }),
    ),
  );

  it.live("enforces its limit and continues a lane after failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const started = new Map<string, Deferred.Deferred<void>>();
        const releases = new Map<string, Deferred.Deferred<void>>();
        for (const item of ["a", "b", "c"]) {
          started.set(item, yield* Deferred.make<void>());
          releases.set(item, yield* Deferred.make<void>());
        }
        const recovered = yield* Deferred.make<void>();
        let active = 0;
        let maxActive = 0;
        const worker = yield* makeKeyedDrainableWorker<string, string, string, never>({
          concurrency: 2,
          process: (item) =>
            item === "fail"
              ? Effect.fail("injected failure")
              : item === "recovered"
                ? Deferred.succeed(recovered, undefined).pipe(Effect.asVoid)
                : Effect.acquireUseRelease(
                    Effect.sync(() => {
                      active += 1;
                      maxActive = Math.max(maxActive, active);
                    }),
                    () =>
                      Effect.gen(function* () {
                        yield* Deferred.succeed(started.get(item)!, undefined).pipe(Effect.orDie);
                        yield* Deferred.await(releases.get(item)!);
                      }),
                    () =>
                      Effect.sync(() => {
                        active -= 1;
                      }),
                  ),
        });

        yield* worker.enqueue("a", "a");
        yield* worker.enqueue("b", "b");
        yield* worker.enqueue("c", "c");
        yield* worker.enqueue("recovery", "fail");
        yield* worker.enqueue("recovery", "recovered");
        yield* Deferred.await(started.get("a")!);
        yield* Deferred.await(started.get("b")!);
        expect(yield* Deferred.isDone(started.get("c")!)).toBe(false);
        expect(maxActive).toBe(2);

        yield* Deferred.succeed(releases.get("a")!, undefined);
        yield* Deferred.await(started.get("c")!);
        yield* Deferred.succeed(releases.get("b")!, undefined);
        yield* Deferred.succeed(releases.get("c")!, undefined);
        yield* Deferred.await(recovered);
        yield* worker.drain;
        expect(maxActive).toBe(2);
      }),
    ),
  );
});
