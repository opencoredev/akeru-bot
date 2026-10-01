import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { type DesktopTelemetryReceiverHealth } from "./DesktopTelemetryTypes.ts";

export const INITIAL_SAMPLE_DEADLINE_MS = 90_000;

export const MIN_SNAPSHOT_STALE_AFTER_MS = 90_000;

export const STALE_GRACE_MS = 30_000;

export const DEFAULT_HOST_POWER_ACTIVE_INTERVAL_MS = 30_000;

export const DEFAULT_HOST_POWER_IDLE_INTERVAL_MS = 120_000;

export function isDesktopTelemetryContactStale(
  lastContactAtMs: Option.Option<number>,
  nowMs: number,
): boolean {
  return Option.exists(
    lastContactAtMs,
    (lastContact) => nowMs - lastContact >= INITIAL_SAMPLE_DEADLINE_MS,
  );
}

export function resolveDesktopTelemetrySnapshotStaleAfterMs(
  activeIntervalMs: number,
  idleIntervalMs: number,
): number {
  return Math.max(
    MIN_SNAPSHOT_STALE_AFTER_MS,
    Math.max(activeIntervalMs, idleIntervalMs) + STALE_GRACE_MS,
  );
}

export function initialDesktopTelemetryContactAt(
  desktopTelemetryFd: number | undefined,
  nowMs: number,
): Option.Option<number> {
  return desktopTelemetryFd === undefined ? Option.none() : Option.some(nowMs);
}

export const recordDesktopTelemetrySampleHealth = Effect.fn(
  "resourceTelemetry.desktopTelemetryReceiver.recordSampleHealth",
)(function* (
  health: Ref.Ref<DesktopTelemetryReceiverHealth>,
  healthChanges: PubSub.PubSub<DesktopTelemetryReceiverHealth>,
  sampledAt: DateTime.Utc,
) {
  const next: DesktopTelemetryReceiverHealth = {
    status: "healthy",
    lastSampleAt: Option.some(sampledAt),
    lastError: Option.none(),
  };

  yield* Ref.set(health, next);
  yield* PubSub.publish(healthChanges, next);
});
