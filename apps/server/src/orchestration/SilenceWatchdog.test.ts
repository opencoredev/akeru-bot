import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { SILENCE_WATCHDOG_SILENT_MS, startSilenceWatchdog } from "./SilenceWatchdog.ts";

const recorder = () => {
  const events: string[] = [];
  return {
    events,
    callbacks: {
      onSilent: (lastActivityAtMs: number) =>
        Effect.sync(() => events.push(`silent@${lastActivityAtMs}`)),
      onResumed: Effect.sync(() => events.push("resumed")),
    },
  };
};

describe("silence watchdog", () => {
  it.effect("reports silence once after the silent interval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, callbacks } = recorder();
        const handle = yield* startSilenceWatchdog({ callbacks });
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS - 1);
        expect(events).toEqual([]);
        yield* TestClock.adjust(1);
        expect(events).toEqual(["silent@0"]);
        yield* TestClock.adjust("10 minutes");
        expect(events).toEqual(["silent@0"]);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("clears on activity and reports a later window again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, callbacks } = recorder();
        const handle = yield* startSilenceWatchdog({ callbacks });
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS);
        yield* handle.touch;
        yield* TestClock.adjust(1);
        expect(events).toEqual(["silent@0", "resumed"]);
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS);
        expect(events).toEqual(["silent@0", "resumed", `silent@${SILENCE_WATCHDOG_SILENT_MS}`]);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("activity before the interval restarts the countdown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, callbacks } = recorder();
        const handle = yield* startSilenceWatchdog({ callbacks });
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS - 1_000);
        yield* handle.touch;
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS - 1_000);
        expect(events).toEqual([]);
        yield* TestClock.adjust(1_000);
        expect(events).toHaveLength(1);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("pauses while approval or user input is outstanding", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, callbacks } = recorder();
        const handle = yield* startSilenceWatchdog({ callbacks });
        yield* handle.suspend;
        yield* TestClock.adjust("5 minutes");
        expect(events).toEqual([]);
        yield* handle.resume;
        yield* handle.touch;
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS);
        expect(events).toHaveLength(1);
        yield* handle.stop;
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stops cleanly and idempotently without reporting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, callbacks } = recorder();
        const handle = yield* startSilenceWatchdog({ callbacks });
        yield* handle.stop;
        yield* handle.stop;
        yield* TestClock.adjust("5 minutes");
        expect(events).toEqual([]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("stopping a silent watchdog does not report a resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, callbacks } = recorder();
        const handle = yield* startSilenceWatchdog({ callbacks });
        yield* TestClock.adjust(SILENCE_WATCHDOG_SILENT_MS);
        yield* handle.stop;
        yield* handle.touch;
        yield* TestClock.adjust("5 minutes");
        expect(events).toEqual(["silent@0"]);
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
});
