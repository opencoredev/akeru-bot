/**
 * RFC 8628 (OAuth 2.0 Device Authorization Grant) polling helpers.
 *
 * Ported from Mastra Code (mastra-ai/mastra, `mastracode/sdk/src/auth/device-code.ts`),
 * Apache-2.0. The RPC path drives polling one step at a time from the client,
 * so every poll state must be JSON-serializable between requests.
 * `pollDeviceCodeUntilSettled` runs the same steps server-side on a Schedule.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

const DEFAULT_INTERVAL_SECONDS = 5;
const INITIAL_POLL_INTERVAL_MULTIPLIER = 1.2;
const SLOW_DOWN_POLL_INTERVAL_MULTIPLIER = 1.4;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

/** Serializable poll-loop state. Safe to round-trip through JSON. */
export interface DeviceCodePollState {
  /** ms epoch after which the device authorization is considered expired. */
  deadlineAt: number;
  /** Current base poll interval in ms (grows on slow_down responses). */
  intervalMs: number;
  /** Number of slow_down responses observed so far. */
  slowDownResponses: number;
}

export function createDeviceCodePollState(options: {
  /** Poll interval suggested by the server, in seconds. Defaults to 5 (RFC 8628). */
  intervalSeconds?: number | undefined;
  /** Lifetime of the device code, in seconds. */
  expiresInSeconds: number;
  /** Current time in ms epoch, read from the Effect Clock by callers. */
  now: number;
}): DeviceCodePollState {
  const intervalSeconds =
    typeof options.intervalSeconds === "number" && options.intervalSeconds > 0
      ? options.intervalSeconds
      : DEFAULT_INTERVAL_SECONDS;
  return {
    deadlineAt: options.now + options.expiresInSeconds * 1000,
    intervalMs: Math.max(1000, Math.floor(intervalSeconds * 1000)),
    slowDownResponses: 0,
  };
}

/**
 * Classified result of one upstream token-endpoint poll. Providers implement
 * the HTTP request and map their response shape onto this union.
 */
export type DeviceCodePollOutcome<T> =
  | { status: "complete"; result: T }
  | { status: "pending"; intervalSeconds?: number | undefined }
  | { status: "slow_down"; intervalSeconds?: number | undefined }
  | { status: "failed"; error: string };

export type DeviceCodeStepResult<T> =
  | { status: "complete"; result: T; state: DeviceCodePollState }
  | { status: "pending"; nextPollMs: number; state: DeviceCodePollState }
  | { status: "slow_down"; nextPollMs: number; state: DeviceCodePollState }
  | { status: "failed"; error: string; state: DeviceCodePollState };

function timeoutMessage(state: DeviceCodePollState): string {
  if (state.slowDownResponses > 0) {
    // Repeated slow_down responses followed by a timeout usually means the
    // local clock is behind the server's (common in WSL/VMs after sleep).
    return "Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Sync the clock and try again.";
  }
  return "Device flow timed out";
}

/**
 * Delay to wait before the next poll, honoring slow_down growth and clamped
 * to the remaining lifetime of the device code.
 */
export function nextPollDelayMs(state: DeviceCodePollState, now: number): number {
  const multiplier =
    state.slowDownResponses > 0
      ? SLOW_DOWN_POLL_INTERVAL_MULTIPLIER
      : INITIAL_POLL_INTERVAL_MULTIPLIER;
  const remainingMs = Math.max(0, state.deadlineAt - now);
  return Math.min(Math.ceil(state.intervalMs * multiplier), remainingMs);
}

function foldOutcome<T>(
  state: DeviceCodePollState,
  outcome: DeviceCodePollOutcome<T>,
  now: number,
): DeviceCodeStepResult<T> {
  switch (outcome.status) {
    case "complete":
      return { status: "complete", result: outcome.result, state };
    case "failed":
      return { status: "failed", error: outcome.error, state };
    case "slow_down": {
      const next: DeviceCodePollState = {
        ...state,
        slowDownResponses: state.slowDownResponses + 1,
        // RFC 8628 section 3.5: grow the interval by 5 seconds, unless the
        // server told us the interval to use.
        intervalMs:
          typeof outcome.intervalSeconds === "number" && outcome.intervalSeconds > 0
            ? outcome.intervalSeconds * 1000
            : Math.max(1000, state.intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS),
      };
      return { status: "slow_down", nextPollMs: nextPollDelayMs(next, now), state: next };
    }
    case "pending": {
      const next: DeviceCodePollState =
        typeof outcome.intervalSeconds === "number" && outcome.intervalSeconds > 0
          ? { ...state, intervalMs: Math.max(1000, outcome.intervalSeconds * 1000) }
          : state;
      return { status: "pending", nextPollMs: nextPollDelayMs(next, now), state: next };
    }
  }
}

/**
 * Perform exactly one upstream poll and fold the outcome into the poll state.
 * Flow-level conditions (expiry, denial) are `{ status: 'failed' }`; only
 * request failures from `pollOnce` reach the error channel.
 */
export const stepDeviceCodePoll = Effect.fn("stepDeviceCodePoll")(function* <T, E, R>(
  state: DeviceCodePollState,
  pollOnce: Effect.Effect<DeviceCodePollOutcome<T>, E, R>,
): Effect.fn.Return<DeviceCodeStepResult<T>, E, R> {
  if ((yield* Clock.currentTimeMillis) >= state.deadlineAt) {
    return { status: "failed", error: timeoutMessage(state), state };
  }
  const outcome = yield* pollOnce;
  return foldOutcome(state, outcome, yield* Clock.currentTimeMillis);
});

const isWaiting = <T>(step: DeviceCodeStepResult<T>) =>
  step.status === "pending" || step.status === "slow_down";

/**
 * Repeats while the last step is still waiting, sleeping the delay that step
 * computed from the server interval and any slow_down growth. Outputs the last
 * step, which is `complete` or `failed` once the schedule stops.
 */
export const deviceCodePollSchedule = <T>() =>
  Schedule.forever.pipe(
    Schedule.setInputType<DeviceCodeStepResult<T>>(),
    Schedule.passthrough,
    Schedule.while(({ input }) => isWaiting(input)),
    Schedule.modifyDelay(({ input }) =>
      Effect.succeed(isWaiting(input) && "nextPollMs" in input ? input.nextPollMs : 0),
    ),
  );

/** Poll a device authorization until it completes, fails, or expires. */
export const pollDeviceCodeUntilSettled = Effect.fn("pollDeviceCodeUntilSettled")(function* <
  T,
  E,
  R,
>(
  initial: DeviceCodePollState,
  pollOnce: (state: DeviceCodePollState) => Effect.Effect<DeviceCodePollOutcome<T>, E, R>,
): Effect.fn.Return<DeviceCodeStepResult<T>, E, R> {
  const current = yield* Ref.make(initial);
  const step = Ref.get(current).pipe(
    Effect.flatMap((state) => stepDeviceCodePoll(state, pollOnce(state))),
    Effect.tap((result) => Ref.set(current, result.state)),
  );
  return yield* Effect.repeat(step, deviceCodePollSchedule<T>());
});
