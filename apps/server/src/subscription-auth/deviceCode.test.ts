import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import {
  createDeviceCodePollState,
  type DeviceCodePollOutcome,
  nextPollDelayMs,
  pollDeviceCodeUntilSettled,
  stepDeviceCodePoll,
} from "./deviceCode.ts";

const NOW = 1_700_000_000_000;

describe("device code polling", () => {
  it("uses the provider interval and expiration", () => {
    const state = createDeviceCodePollState({
      intervalSeconds: 5,
      expiresInSeconds: 600,
      now: NOW,
    });
    expect(state).toEqual({
      deadlineAt: NOW + 600_000,
      intervalMs: 5_000,
      slowDownResponses: 0,
    });
    expect(nextPollDelayMs(state, NOW)).toBe(6_000);
  });

  it.effect("grows the interval after slow_down", () =>
    Effect.gen(function* () {
      const state = createDeviceCodePollState({ expiresInSeconds: 600, now: 0 });
      const result = yield* stepDeviceCodePoll(
        state,
        Effect.succeed<DeviceCodePollOutcome<string>>({ status: "slow_down" }),
      );
      expect(result.status).toBe("slow_down");
      expect(result.state.slowDownResponses).toBe(1);
      expect(result.state.intervalMs).toBe(10_000);
      if (result.status === "slow_down") expect(result.nextPollMs).toBe(14_000);
    }),
  );

  it.effect("uses the interval a slow_down response sends", () =>
    Effect.gen(function* () {
      const state = createDeviceCodePollState({ expiresInSeconds: 600, now: 0 });
      const result = yield* stepDeviceCodePoll(
        state,
        Effect.succeed<DeviceCodePollOutcome<string>>({
          status: "slow_down",
          intervalSeconds: 20,
        }),
      );
      expect(result.state.intervalMs).toBe(20_000);
    }),
  );

  it.effect("returns completion without changing the state", () =>
    Effect.gen(function* () {
      const state = createDeviceCodePollState({ expiresInSeconds: 600, now: 0 });
      const result = yield* stepDeviceCodePoll(
        state,
        Effect.succeed<DeviceCodePollOutcome<string>>({ status: "complete", result: "token" }),
      );
      expect(result).toEqual({ status: "complete", result: "token", state });
    }),
  );

  it.effect("fails before polling after expiration", () =>
    Effect.gen(function* () {
      const state = createDeviceCodePollState({ expiresInSeconds: 1, now: 0 });
      yield* TestClock.adjust(1_001);
      let polled = false;
      const result = yield* stepDeviceCodePoll(
        state,
        Effect.sync((): DeviceCodePollOutcome<string> => {
          polled = true;
          return { status: "pending" };
        }),
      );
      expect(polled).toBe(false);
      expect(result).toMatchObject({ status: "failed", error: "Device flow timed out" });
    }),
  );

  it.effect("waits the computed interval between polls until the flow settles", () =>
    Effect.gen(function* () {
      const outcomes: Array<DeviceCodePollOutcome<string>> = [
        { status: "pending" },
        { status: "slow_down" },
        { status: "complete", result: "token" },
      ];
      const polledAt: Array<number> = [];
      const state = createDeviceCodePollState({
        intervalSeconds: 5,
        expiresInSeconds: 600,
        now: 0,
      });
      const fiber = yield* pollDeviceCodeUntilSettled(state, () =>
        Effect.sync(() => {
          polledAt.push(polledAt.length);
          return outcomes.shift()!;
        }),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(0);
      expect(polledAt).toHaveLength(1);
      // pending: 5s interval * 1.2
      yield* TestClock.adjust(5_999);
      expect(polledAt).toHaveLength(1);
      yield* TestClock.adjust(1);
      expect(polledAt).toHaveLength(2);
      // slow_down: (5s + 5s) * 1.4
      yield* TestClock.adjust(13_999);
      expect(polledAt).toHaveLength(2);
      yield* TestClock.adjust(1);
      expect(polledAt).toHaveLength(3);

      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({
        status: "complete",
        result: "token",
        state: { intervalMs: 10_000, slowDownResponses: 1 },
      });
    }),
  );

  it.effect("stops with the timeout failure once the device code expires", () =>
    Effect.gen(function* () {
      const state = createDeviceCodePollState({
        intervalSeconds: 5,
        expiresInSeconds: 10,
        now: 0,
      });
      let polls = 0;
      const fiber = yield* pollDeviceCodeUntilSettled(state, () =>
        Effect.sync((): DeviceCodePollOutcome<string> => {
          polls += 1;
          return { status: "pending" };
        }),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust(10_000);
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ status: "failed", error: "Device flow timed out" });
      // Polls at 0s and 6s; the delay after that clamps to the 10s deadline.
      expect(polls).toBe(2);
    }),
  );
});
