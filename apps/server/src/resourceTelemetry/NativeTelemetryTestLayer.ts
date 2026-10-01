import type { ResourceMonitorHelloEvent } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import {
  UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS,
  NativeTelemetryUnavailable,
} from "./NativeTelemetryProtocol.ts";
import { NativeTelemetryClient } from "./NativeTelemetryTypes.ts";

export const layerTest = (
  overrides: Partial<NativeTelemetryClient["Service"]> = {},
): Layer.Layer<NativeTelemetryClient> => {
  const health =
    overrides.health ??
    Effect.succeed({
      status: "unavailable" as const,
      hello: Option.none<ResourceMonitorHelloEvent>(),
      lastSampleAt: Option.none<DateTime.Utc>(),
      lastError: Option.some("Resource monitor test implementation is unavailable."),
      restartCount: 0,
      sampleIntervalMs: UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS,
    });

  return Layer.succeed(
    NativeTelemetryClient,
    NativeTelemetryClient.of({
      capabilities: Effect.succeed({
        cumulativeCpuTime: true,
        currentCpuPercent: true,
        residentMemory: true,
        virtualMemory: true,
        ioBytes: true,
        processStartTime: true,
        processTree: true,
      }),
      snapshots: Stream.empty,
      readHistory: () =>
        Effect.fail(
          new NativeTelemetryUnavailable({
            reason: "No resource monitor history was configured for this test.",
          }),
        ),
      setExternalProcesses: () => Effect.void,
      setHostPowerState: () => Effect.void,
      sampleNow: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor sample was configured for this test.",
        }),
      ),
      processTable: Effect.fail(
        new NativeTelemetryUnavailable({
          reason: "No resource monitor process table was configured for this test.",
        }),
      ),
      retry: Effect.succeed(false),
      health,
      subscribeHealth:
        overrides.subscribeHealth ??
        health.pipe(
          Effect.map((initial) => ({
            latest: initial,
            changes: Stream.empty,
          })),
        ),
      ...overrides,
    }),
  );
};
