import {
  type DesktopElectronProcessMetric,
  type DesktopHostTelemetrySnapshot,
  type ResourceMonitorProcessSample,
  type ResourceMonitorSnapshotEvent,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { emptyTelemetryCounters, mergeProcesses, type MergeProcessesResult } from "../Model.ts";

const SERVER_PID = 100;

const BASE_TIME_MS = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"));

function processSample(
  input: Partial<ResourceMonitorProcessSample> &
    Pick<ResourceMonitorProcessSample, "pid" | "ppid" | "startTimeMs">,
): ResourceMonitorProcessSample {
  return {
    runTimeMs: 1_000,
    name: `process-${input.pid}`,
    command: `process-${input.pid}`,
    status: "Running",
    cpuPercent: 0,
    cpuTimeMs: 0,
    residentBytes: 1_024,
    virtualBytes: 2_048,
    ioReadBytes: 0,
    ioWriteBytes: 0,
    ioSemantics: "storage",
    ...input,
  };
}

function nativeSnapshot(
  sampledAtUnixMs: number,
  processes: ReadonlyArray<ResourceMonitorProcessSample>,
  sequence = 1,
): ResourceMonitorSnapshotEvent {
  return {
    version: 3,
    type: "snapshot",
    sequence,
    sampledAtUnixMs,
    collectionDurationMicros: 250,
    scannedProcessCount: processes.length,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 0,
    processes: [...processes],
  };
}

function electronMetric(
  input: Partial<DesktopElectronProcessMetric> &
    Pick<DesktopElectronProcessMetric, "pid" | "creationTimeMs" | "type">,
): DesktopElectronProcessMetric {
  return {
    cpuPercent: 0,
    idleWakeupsPerSecond: 0,
    workingSetBytes: 1_024,
    peakWorkingSetBytes: 2_048,
    ...input,
  };
}

function desktopSnapshot(
  sampledAtUnixMs: number,
  electronProcesses: ReadonlyArray<DesktopElectronProcessMetric>,
): DesktopHostTelemetrySnapshot {
  const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
  return {
    version: 1,
    type: "desktopTelemetry",
    sequence: 1,
    sampledAtUnixMs,
    electronPid: electronProcesses[0]?.pid ?? 10_000,
    power: {
      source: "electron-main",
      idle: "false",
      idleSeconds: 0,
      locked: "false",
      suspended: false,
      onBattery: "false",
      lowPowerMode: "unknown",
      thermalState: "nominal",
      stale: false,
      updatedAt: sampledAt,
    },
    speedLimitPercent: Option.none(),
    electronProcesses: [...electronProcesses],
  };
}

function merge(input: {
  readonly native: ResourceMonitorSnapshotEvent;
  readonly desktop?: DesktopHostTelemetrySnapshot;
  readonly previous?: MergeProcessesResult;
  readonly sidecarPid?: number;
}): MergeProcessesResult {
  return mergeProcesses({
    serverPid: SERVER_PID,
    sidecarPid: Option.fromUndefinedOr(input.sidecarPid),
    fallbackSampledAtMs: input.native.sampledAtUnixMs,
    nativeSnapshot: Option.some(input.native),
    desktopSnapshot: Option.fromUndefinedOr(input.desktop),
    previous: input.previous?.previous ?? new Map(),
    counters: input.previous?.counters ?? emptyTelemetryCounters(),
    updatePrevious: true,
  });
}
export {
  SERVER_PID,
  BASE_TIME_MS,
  processSample,
  nativeSnapshot,
  electronMetric,
  desktopSnapshot,
  merge,
};
