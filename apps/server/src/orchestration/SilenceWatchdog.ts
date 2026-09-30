import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";

export const SILENCE_WATCHDOG_BEAT_MS = 60_000;
export const SILENCE_WATCHDOG_FAILURE_MS = 120_000;

export interface SilenceWatchdogCallbacks {
  readonly onBeat: Effect.Effect<void>;
  readonly onFailure: Effect.Effect<void>;
}

export interface SilenceWatchdogHandle {
  readonly touch: Effect.Effect<void>;
  readonly suspend: Effect.Effect<void>;
  readonly resume: Effect.Effect<void>;
  readonly stop: Effect.Effect<void>;
}

/** A per-turn watchdog. Its fiber is owned by the caller's Scope. */
export const startSilenceWatchdog = (input: {
  readonly skipFirstBeat?: boolean;
  readonly callbacks: SilenceWatchdogCallbacks;
}): Effect.Effect<SilenceWatchdogHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const lastActivity = yield* Ref.make(yield* Clock.currentTimeMillis);
    const beatSent = yield* Ref.make(Boolean(input.skipFirstBeat));
    const paused = yield* Ref.make(0);
    const wake = yield* Queue.unbounded<"activity" | "pause" | "resume" | "stop">();
    const stopped = yield* Deferred.make<void>();
    const stopRequested = yield* Ref.make(false);

    const loop = yield* Effect.gen(function* () {
      while (true) {
        const now = yield* Clock.currentTimeMillis;
        const last = yield* Ref.get(lastActivity);
        const elapsed = now - last;
        if ((yield* Ref.get(paused)) === 0 && elapsed >= SILENCE_WATCHDOG_FAILURE_MS) {
          yield* input.callbacks.onFailure;
          yield* Deferred.succeed(stopped, void 0);
          return;
        }
        if (
          (yield* Ref.get(paused)) === 0 &&
          elapsed >= SILENCE_WATCHDOG_BEAT_MS &&
          !(yield* Ref.get(beatSent))
        ) {
          yield* input.callbacks.onBeat;
          yield* Ref.set(beatSent, true);
        }
        // While paused, block on the next signal without a deadline timer.
        const remaining = Math.max(1, SILENCE_WATCHDOG_FAILURE_MS - elapsed);
        const signal =
          (yield* Ref.get(paused)) > 0
            ? yield* Queue.take(wake)
            : yield* Effect.race(
                Queue.take(wake),
                Effect.sleep(Duration.millis(Math.min(remaining, 1_000))),
              );
        if (signal === "stop") {
          yield* Deferred.succeed(stopped, void 0);
          return;
        }
        if (signal === "activity") {
          yield* Ref.set(lastActivity, yield* Clock.currentTimeMillis);
          yield* Ref.set(beatSent, Boolean(input.skipFirstBeat));
        }
        if (signal === "pause") yield* Ref.update(paused, (count) => count + 1);
        if (signal === "resume") {
          const count = yield* Ref.updateAndGet(paused, (count) => Math.max(0, count - 1));
          // The paused wait is not silence; restart the deadline from the resume.
          if (count === 0) {
            yield* Ref.set(lastActivity, yield* Clock.currentTimeMillis);
            yield* Ref.set(beatSent, Boolean(input.skipFirstBeat));
          }
        }
      }
    }).pipe(Effect.forkScoped);

    const touch = Queue.offer(wake, "activity").pipe(Effect.asVoid);
    const suspend = Queue.offer(wake, "pause").pipe(Effect.asVoid);
    const resume = Queue.offer(wake, "resume").pipe(Effect.asVoid);
    const stop = Effect.gen(function* () {
      const alreadyStopped = yield* Ref.getAndSet(stopRequested, true);
      if (!alreadyStopped) yield* Queue.offer(wake, "stop");
      yield* Deferred.await(stopped);
      yield* Fiber.interrupt(loop);
    });
    return { touch, suspend, resume, stop } satisfies SilenceWatchdogHandle;
  });
