import type {
  HostPowerSnapshot,
  ResourceMonitorHelloEvent,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetrySourceStatus,
} from "@akeru/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  SAMPLE_INTERVAL_MS,
  UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS,
  BATTERY_SAMPLE_INTERVAL_MS,
  CONSTRAINED_SAMPLE_INTERVAL_MS,
  INITIAL_RESTART_DELAY,
  MAX_RESTART_DELAY,
  FAILURE_WINDOW_MS,
  type NativeTelemetryClientError,
  type NativeTelemetryClientHealth,
} from "./NativeTelemetryProtocol.ts";
export interface ClientState {
  readonly status: ResourceTelemetrySourceStatus;
  readonly handle: Option.Option<ChildProcessSpawner.ChildProcessHandle>;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
}

export interface CollectionControl {
  readonly hostPower: HostPowerSnapshot;
  readonly liveSubscriberCount: number;
  readonly sampleIntervalMs: number;
}

export interface PendingHistoryRequest {
  readonly deferred: Deferred.Deferred<
    ReadonlyArray<ResourceMonitorSnapshotEvent>,
    NativeTelemetryClientError
  >;
  readonly snapshots: ReadonlyArray<ResourceMonitorSnapshotEvent>;
}

export const initialState: ClientState = {
  status: "starting",
  handle: Option.none(),
  hello: Option.none(),
  lastSampleAt: Option.none(),
  lastError: Option.none(),
  restartCount: 0,
};

export function toHealth(
  state: ClientState,
  sampleIntervalMs: number,
): NativeTelemetryClientHealth {
  return {
    status: state.status,
    hello: state.hello,
    lastSampleAt: state.lastSampleAt,
    lastError: state.lastError,
    restartCount: state.restartCount,
    sampleIntervalMs,
  };
}

export function isThermallyConstrained(snapshot: HostPowerSnapshot): boolean {
  return snapshot.thermalState === "serious" || snapshot.thermalState === "critical";
}

export function resolveNativeSampleIntervalMs(
  snapshot: HostPowerSnapshot,
  liveSubscriberCount: number,
): number {
  if (snapshot.stale || snapshot.source === "unknown") {
    return liveSubscriberCount > 0 ? SAMPLE_INTERVAL_MS : UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS;
  }
  if (
    snapshot.suspended ||
    snapshot.locked === "true" ||
    snapshot.lowPowerMode === "true" ||
    isThermallyConstrained(snapshot)
  ) {
    return CONSTRAINED_SAMPLE_INTERVAL_MS;
  }
  if (snapshot.onBattery === "true") return BATTERY_SAMPLE_INTERVAL_MS;
  return SAMPLE_INTERVAL_MS;
}

export function commitCollectionControlUpdate<E, R>(
  desiredState: Ref.Ref<CollectionControl>,
  appliedState: Ref.Ref<CollectionControl>,
  update: (current: CollectionControl) => CollectionControl,
  apply: (previous: CollectionControl, next: CollectionControl) => Effect.Effect<void, E, R>,
): Effect.Effect<readonly [CollectionControl, CollectionControl], E, R> {
  return Effect.gen(function* () {
    const [previousDesired, next] = yield* Ref.modify(desiredState, (previous) => {
      const next = update(previous);
      return [[previous, next] as const, next];
    });
    const previousApplied = yield* Ref.get(appliedState);
    yield* apply(previousApplied, next);
    yield* Ref.set(appliedState, next);
    return [previousDesired, next] as const;
  });
}

export function synchronizeCollectionControlOnStart<E1, R1, E2, R2>(
  mutex: Semaphore.Semaphore,
  desiredState: Ref.Ref<CollectionControl>,
  appliedState: Ref.Ref<CollectionControl>,
  apply: (control: CollectionControl) => Effect.Effect<void, E1, R1>,
  markReady: Effect.Effect<void, E2, R2>,
) {
  return mutex.withPermits(1)(
    Effect.gen(function* () {
      const control = yield* Ref.get(desiredState);
      yield* apply(control);
      yield* Ref.set(appliedState, control);
      yield* markReady;
      return control;
    }),
  );
}

export function restartDelay(attempt: number): Duration.Duration {
  return Duration.min(Duration.times(INITIAL_RESTART_DELAY, 2 ** attempt), MAX_RESTART_DELAY);
}

export function retainRecentNativeTelemetryFailures(
  failures: ReadonlyArray<number>,
  now: number,
): ReadonlyArray<number> {
  return failures.filter((failedAt) => now - failedAt <= FAILURE_WINDOW_MS);
}

export function errorMessage(error: NativeTelemetryClientError): string {
  return error.message;
}

export function nativeTelemetrySupervisorFailureMessage(_cause: Cause.Cause<unknown>): string {
  return "Resource monitor supervisor stopped unexpectedly.";
}

export function canRequestNativeTelemetryRetry(
  status: ResourceTelemetrySourceStatus,
  hasHandle: boolean,
): boolean {
  return status !== "healthy" && status !== "starting" && !hasHandle;
}

export function canCommandNativeTelemetrySidecar(
  status: ResourceTelemetrySourceStatus,
  hasHandle: boolean,
): boolean {
  return hasHandle && (status === "healthy" || status === "degraded");
}
