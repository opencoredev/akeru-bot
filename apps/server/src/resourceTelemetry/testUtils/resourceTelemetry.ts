import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorProcessSample,
  ResourceMonitorSnapshotEvent,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as NativeTelemetryClient from "../NativeTelemetryClient.ts";

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

function nativeSnapshot(input: {
  readonly sequence: number;
  readonly sampledAtUnixMs: number;
  readonly childCpuTimeMs: number;
  readonly childWriteBytes: number;
  readonly externalProcesses?: ResourceMonitorSnapshotEvent["externalProcesses"];
}): ResourceMonitorSnapshotEvent {
  const processes = [
    processSample({
      pid: process.pid,
      ppid: 1,
      startTimeMs: 100,
      cpuTimeMs: input.sequence * 10,
    }),
    processSample({
      pid: 4_242,
      ppid: process.pid,
      startTimeMs: 200,
      name: "codex",
      command: "codex app-server",
      cpuTimeMs: input.childCpuTimeMs,
      ioWriteBytes: input.childWriteBytes,
    }),
    processSample({
      pid: 5_000,
      ppid: 1,
      startTimeMs: 300,
      name: "electron",
      command: "electron",
      cpuTimeMs: input.sequence * 20,
    }),
    processSample({
      pid: 9_000,
      ppid: process.pid,
      startTimeMs: 400,
      name: "t3-resource-monitor",
      command: "t3-resource-monitor",
      cpuTimeMs: input.sequence * 5,
    }),
  ];
  return {
    version: 3,
    type: "snapshot",
    sequence: input.sequence,
    sampledAtUnixMs: input.sampledAtUnixMs,
    collectionDurationMicros: 300,
    scannedProcessCount: 80,
    retainedProcessCount: processes.length,
    inaccessibleProcessCount: 1,
    ...(input.externalProcesses === undefined
      ? {}
      : { externalProcesses: input.externalProcesses }),
    processes,
  };
}

function nativeGeneration(
  snapshot: ResourceMonitorSnapshotEvent,
  generation: number,
): NativeTelemetryClient.NativeTelemetrySnapshot {
  return { generation, snapshot };
}

function desktopSnapshot(sampledAtUnixMs: number): DesktopHostTelemetrySnapshot {
  const sampledAt = DateTime.makeUnsafe(sampledAtUnixMs);
  return {
    version: 1,
    type: "desktopTelemetry",
    sequence: 1,
    sampledAtUnixMs,
    electronPid: 5_000,
    power: {
      source: "electron-main",
      idle: "false",
      idleSeconds: 2,
      locked: "false",
      suspended: false,
      onBattery: "true",
      lowPowerMode: "unknown",
      thermalState: "fair",
      stale: false,
      updatedAt: sampledAt,
    },
    speedLimitPercent: Option.some(90),
    electronProcesses: [
      {
        pid: 5_000,
        creationTimeMs: 300,
        type: "Browser",
        name: "electron",
        cpuPercent: 2,
        cumulativeCpuSeconds: 0.02,
        idleWakeupsPerSecond: 3,
        workingSetBytes: 4_096,
        peakWorkingSetBytes: 8_192,
      },
    ],
  };
}
export { processSample, nativeSnapshot, nativeGeneration, desktopSnapshot };
