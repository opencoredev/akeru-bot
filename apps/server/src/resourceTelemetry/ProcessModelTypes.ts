import type {
  DesktopHostTelemetrySnapshot,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetryAggregate,
  ResourceTelemetryProcess,
  ResourceTelemetryProcessCategory,
} from "@akeru/contracts";
import * as Option from "effect/Option";

export const MAX_DELTA_INTERVAL_MS = 30_000;

export const ELECTRON_IDENTITY_TOLERANCE_MS = 2_000;

export interface ProcessState {
  readonly process: ResourceTelemetryProcess;
  readonly sampledAtMs: number;
}

export interface GroupCounters {
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
  readonly processStarts: number;
  readonly processExits: number;
}

export interface TelemetryCounters {
  readonly backend: GroupCounters;
  readonly electron: GroupCounters;
  readonly monitor: GroupCounters;
  readonly allT3: GroupCounters;
}

export interface ProcessDelta {
  readonly identityKey: string;
  readonly category: ResourceTelemetryProcessCategory;
  readonly cpuTimeMs: number;
  readonly ioReadBytes: number;
  readonly ioWriteBytes: number;
}

export interface MergeProcessesInput {
  readonly serverPid: number;
  readonly sidecarPid: Option.Option<number>;
  readonly fallbackSampledAtMs: number;
  readonly nativeSnapshot: Option.Option<ResourceMonitorSnapshotEvent>;
  readonly desktopSnapshot: Option.Option<DesktopHostTelemetrySnapshot>;
  readonly electronRootPids?: ReadonlySet<number>;
  readonly electronRootStartTimes?: ReadonlyMap<number, number>;
  readonly previous: ReadonlyMap<string, ProcessState>;
  readonly counters: TelemetryCounters;
  readonly updatePrevious: boolean;
}

export interface MergeProcessesResult {
  readonly sampledAtMs: number;
  readonly processes: ReadonlyArray<ResourceTelemetryProcess>;
  readonly previous: ReadonlyMap<string, ProcessState>;
  readonly counters: TelemetryCounters;
  readonly groups: {
    readonly backend: ResourceTelemetryAggregate;
    readonly electron: ResourceTelemetryAggregate;
    readonly monitor: ResourceTelemetryAggregate;
    readonly allT3: ResourceTelemetryAggregate;
  };
  readonly deltas: ReadonlyArray<ProcessDelta>;
}

export function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}
