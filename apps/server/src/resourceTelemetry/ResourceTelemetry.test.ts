import {
  nativeSnapshot,
  nativeGeneration,
  desktopSnapshot,
} from "./testUtils/resourceTelemetry.ts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as DesktopTelemetryReceiver from "./DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./NativeTelemetryClient.ts";
import * as ResourceAttribution from "./ResourceAttribution.ts";
import * as ResourceTelemetry from "./ResourceTelemetry.ts";
describe("ResourceTelemetry", () => {
  it.effect(
    "attributes an initial Electron root from the identity recorded by the native snapshot",
    () =>
      Effect.gen(function* () {
        const sampledAtUnixMs = DateTime.toEpochMillis(yield* DateTime.now);
        const sample = nativeSnapshot({
          sequence: 1,
          sampledAtUnixMs,
          childCpuTimeMs: 100,
          childWriteBytes: 1_000,
          externalProcesses: [{ pid: 5_000, startTimeMs: 300 }],
        });
        const desktop = {
          ...desktopSnapshot(sampledAtUnixMs),
          electronProcesses: [],
        };
        const nativeLayer = NativeTelemetryClient.layerTest({
          sampleNow: Effect.succeed(nativeGeneration(sample, 0)),
          health: Effect.succeed({
            status: "healthy",
            hello: Option.none(),
            lastSampleAt: Option.none(),
            lastError: Option.none(),
            restartCount: 0,
            sampleIntervalMs: 1_000,
          }),
        });
        const desktopLayer = DesktopTelemetryReceiver.layerTest({
          latest: Effect.succeedSome(desktop),
        });
        const telemetryLayer = ResourceTelemetry.layer.pipe(
          Layer.provide(Layer.mergeAll(nativeLayer, desktopLayer, ResourceAttribution.layer)),
        );

        const snapshot = yield* Effect.gen(function* () {
          const telemetry = yield* ResourceTelemetry.ResourceTelemetry;
          return yield* telemetry.refresh;
        }).pipe(Effect.provide(telemetryLayer));

        expect(snapshot.processes.find((entry) => entry.identity.pid === 5_000)?.category).toBe(
          "electron-main",
        );
        expect(snapshot.groups.electron.processStarts).toBe(1);
        expect(snapshot.groups.backend.processStarts).toBe(3);
      }),
  );
});
