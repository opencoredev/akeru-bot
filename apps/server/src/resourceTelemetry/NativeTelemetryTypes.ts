import type {
  HostPowerSnapshot,
  ResourceMonitorCapabilities,
  ResourceMonitorExternalProcess,
  ResourceMonitorProcessTableEntry,
  ResourceMonitorSnapshotEvent,
} from "@akeru/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import {
  type NativeTelemetryClientError,
  type NativeTelemetryClientHealth,
  type NativeTelemetrySnapshot,
} from "./NativeTelemetryProtocol.ts";

export class NativeTelemetryClient extends Context.Service<
  NativeTelemetryClient,
  {
    readonly capabilities: Effect.Effect<ResourceMonitorCapabilities, NativeTelemetryClientError>;
    readonly snapshots: Stream.Stream<NativeTelemetrySnapshot, NativeTelemetryClientError>;
    readonly readHistory: (
      windowMs: number,
    ) => Effect.Effect<ReadonlyArray<ResourceMonitorSnapshotEvent>, NativeTelemetryClientError>;
    readonly setExternalProcesses: (
      processes: ReadonlyArray<ResourceMonitorExternalProcess>,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly setHostPowerState: (
      snapshot: HostPowerSnapshot,
    ) => Effect.Effect<void, NativeTelemetryClientError>;
    readonly sampleNow: Effect.Effect<NativeTelemetrySnapshot, NativeTelemetryClientError>;
    readonly processTable: Effect.Effect<
      ReadonlyArray<ResourceMonitorProcessTableEntry>,
      NativeTelemetryClientError
    >;
    readonly retry: Effect.Effect<boolean>;
    readonly health: Effect.Effect<NativeTelemetryClientHealth>;
    readonly subscribeHealth: Effect.Effect<
      {
        readonly latest: NativeTelemetryClientHealth;
        readonly changes: Stream.Stream<NativeTelemetryClientHealth>;
      },
      never,
      Scope.Scope
    >;
  }
>()("akeru-bot/resourceTelemetry/NativeTelemetryTypes/NativeTelemetryClient") {}
