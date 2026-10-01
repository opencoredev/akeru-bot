import type {
  ResourceMonitorEvent,
  ResourceMonitorHelloEvent,
  ResourceMonitorSnapshotEvent,
  ResourceTelemetrySourceStatus,
} from "@akeru/contracts";
import {
  ResourceMonitorCommand as ResourceMonitorCommandSchema,
  ResourceMonitorEvent as ResourceMonitorEventSchema,
} from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";

export const SAMPLE_INTERVAL_MS = 1_000;

export const UNKNOWN_BACKGROUND_SAMPLE_INTERVAL_MS = 5_000;

export const BATTERY_SAMPLE_INTERVAL_MS = 5_000;

export const CONSTRAINED_SAMPLE_INTERVAL_MS = 15_000;

export const HANDSHAKE_TIMEOUT = Duration.seconds(5);

export const SAMPLE_REQUEST_TIMEOUT = Duration.seconds(5);

export const PROCESS_TABLE_REQUEST_TIMEOUT = Duration.seconds(5);

export const HISTORY_REQUEST_TIMEOUT = Duration.seconds(15);

export const INITIAL_RESTART_DELAY = Duration.millis(500);

export const MAX_RESTART_DELAY = Duration.seconds(10);

export const FAILURE_WINDOW_MS = 60_000;

export const MAX_FAILURES_PER_WINDOW = 5;

export class NativeTelemetrySpawnFailed extends Schema.TaggedErrorClass<NativeTelemetrySpawnFailed>()(
  "NativeTelemetrySpawnFailed",
  {
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to start resource monitor '${this.path}'.`;
  }
}

export class NativeTelemetryHandshakeTimedOut extends Schema.TaggedErrorClass<NativeTelemetryHandshakeTimedOut>()(
  "NativeTelemetryHandshakeTimedOut",
  {
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor handshake timed out after ${this.timeoutMs}ms.`;
  }
}

export class NativeTelemetryRequestTimedOut extends Schema.TaggedErrorClass<NativeTelemetryRequestTimedOut>()(
  "NativeTelemetryRequestTimedOut",
  {
    operation: Schema.Literals(["processTable", "readHistory", "sampleNow"]),
    timeoutMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor '${this.operation}' request timed out after ${this.timeoutMs}ms.`;
  }
}

export class NativeTelemetryProtocolMismatch extends Schema.TaggedErrorClass<NativeTelemetryProtocolMismatch>()(
  "NativeTelemetryProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class NativeTelemetryDecodeFailed extends Schema.TaggedErrorClass<NativeTelemetryDecodeFailed>()(
  "NativeTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode resource monitor output.";
  }
}

export class NativeTelemetryCommandFailed extends Schema.TaggedErrorClass<NativeTelemetryCommandFailed>()(
  "NativeTelemetryCommandFailed",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Resource monitor command '${this.operation}' failed.`;
  }
}

export class NativeTelemetryExited extends Schema.TaggedErrorClass<NativeTelemetryExited>()(
  "NativeTelemetryExited",
  {
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Resource monitor exited with code ${this.exitCode}.`;
  }
}

export class NativeTelemetryStreamClosed extends Schema.TaggedErrorClass<NativeTelemetryStreamClosed>()(
  "NativeTelemetryStreamClosed",
  {},
) {
  override get message(): string {
    return "Resource monitor event stream closed unexpectedly.";
  }
}

export class NativeTelemetryUnavailable extends Schema.TaggedErrorClass<NativeTelemetryUnavailable>()(
  "NativeTelemetryUnavailable",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Resource monitor is unavailable: ${this.reason}`;
  }
}

export type NativeTelemetryClientError =
  | ResourceMonitorBinary.ResourceMonitorBinaryError
  | NativeTelemetrySpawnFailed
  | NativeTelemetryHandshakeTimedOut
  | NativeTelemetryRequestTimedOut
  | NativeTelemetryProtocolMismatch
  | NativeTelemetryDecodeFailed
  | NativeTelemetryCommandFailed
  | NativeTelemetryExited
  | NativeTelemetryStreamClosed
  | NativeTelemetryUnavailable;

export interface NativeTelemetryClientHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly hello: Option.Option<ResourceMonitorHelloEvent>;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
  readonly restartCount: number;
  readonly sampleIntervalMs: number;
}

export interface NativeTelemetrySnapshot {
  readonly generation: number;
  readonly snapshot: ResourceMonitorSnapshotEvent;
}

export const decodeMonitorEvent: (
  value: unknown,
) => Effect.Effect<ResourceMonitorEvent, Schema.SchemaError> = Schema.decodeUnknownEffect(
  ResourceMonitorEventSchema,
);

export const encodeMonitorCommand = Schema.encodeEffect(
  Schema.fromJsonString(ResourceMonitorCommandSchema),
);

export const isProtocolMismatch = Schema.is(NativeTelemetryProtocolMismatch);

export const isDecodeFailed = Schema.is(NativeTelemetryDecodeFailed);

export const isCommandFailed = Schema.is(NativeTelemetryCommandFailed);

export function eventVersion(value: unknown): number | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  return typeof version === "number" ? version : undefined;
}
