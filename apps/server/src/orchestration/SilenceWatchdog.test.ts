import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { startSilenceWatchdog } from "./SilenceWatchdog.ts";

describe("silence watchdog", () => {
  it.effect("emits a beat at 60 seconds and fails at 120 seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const beats: string[] = [];
        const failures: string[] = [];
        const handle = yield* startSilenceWatchdog({
          callbacks: {
            onBeat: Effect.sync(() => beats.push("beat")),
            onFailure: Effect.sync(() => failures.push("failure")),
          },
        });
        yield* TestClock.adjust("60 seconds");
        expect(beats).toEqual(["beat"]);
        expect(failures).toEqual([]);
        yield* TestClock.adjust("60 seconds");
        expect(failures).toEqual(["failure"]);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("skips the first beat for a hidden wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const beats: string[] = [];
        const handle = yield* startSilenceWatchdog({
          skipFirstBeat: true,
          callbacks: { onBeat: Effect.sync(() => beats.push("beat")), onFailure: Effect.void },
        });
        yield* TestClock.adjust("60 seconds");
        expect(beats).toEqual([]);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("pauses while approval or user input is outstanding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failures = 0;
        const handle = yield* startSilenceWatchdog({
          callbacks: { onBeat: Effect.void, onFailure: Effect.sync(() => failures++) },
        });
        yield* handle.suspend;
        yield* TestClock.adjust("2 minutes");
        expect(failures).toBe(0);
        yield* handle.resume;
        yield* handle.touch;
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("schedules no timers during a long approval wait", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failures = 0;
        let sleeps = 0;
        const clock = yield* TestClock.testClockWith(Effect.succeed);
        const countingClock: Clock.Clock = {
          currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
          currentTimeMillis: clock.currentTimeMillis,
          currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
          currentTimeNanos: clock.currentTimeNanos,
          monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
          monotonicTimeNanos: clock.monotonicTimeNanos,
          sleep: (duration) => Effect.suspend(() => (sleeps++, clock.sleep(duration))),
        };
        const handle = yield* startSilenceWatchdog({
          callbacks: { onBeat: Effect.void, onFailure: Effect.sync(() => failures++) },
        }).pipe(Effect.provideService(Clock.Clock, countingClock));
        yield* handle.suspend;
        yield* TestClock.adjust("1 second");
        const sleepsWhenPaused = sleeps;
        yield* TestClock.adjust("10 minutes");
        expect(sleeps).toBe(sleepsWhenPaused);
        expect(failures).toBe(0);
        yield* handle.resume;
        yield* TestClock.adjust("119 seconds");
        expect(failures).toBe(0);
        yield* TestClock.adjust("1 second");
        expect(failures).toBe(1);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels cleanly", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let failures = 0;
        const handle = yield* startSilenceWatchdog({
          callbacks: { onBeat: Effect.void, onFailure: Effect.sync(() => failures++) },
        });
        yield* handle.stop;
        yield* handle.stop;
        yield* TestClock.adjust("2 minutes");
        expect(failures).toBe(0);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
