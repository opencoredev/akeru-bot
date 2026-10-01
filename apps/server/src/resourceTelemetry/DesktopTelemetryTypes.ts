// @effect-diagnostics nodeBuiltinImport:off
import { type ResourceTelemetrySourceStatus } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class DesktopTelemetryDescriptorUnavailable extends Schema.TaggedErrorClass<DesktopTelemetryDescriptorUnavailable>()(
  "DesktopTelemetryDescriptorUnavailable",
  {
    mode: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop telemetry descriptor is unavailable in '${this.mode}' mode.`;
  }
}

export class DesktopTelemetryProtocolMismatch extends Schema.TaggedErrorClass<DesktopTelemetryProtocolMismatch>()(
  "DesktopTelemetryProtocolMismatch",
  {
    expectedVersion: Schema.Number,
    receivedVersion: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry protocol ${this.receivedVersion} is incompatible with expected protocol ${this.expectedVersion}.`;
  }
}

export class DesktopTelemetryDecodeFailed extends Schema.TaggedErrorClass<DesktopTelemetryDecodeFailed>()(
  "DesktopTelemetryDecodeFailed",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to decode desktop telemetry.";
  }
}

export class DesktopTelemetryStreamFailed extends Schema.TaggedErrorClass<DesktopTelemetryStreamFailed>()(
  "DesktopTelemetryStreamFailed",
  {
    fd: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop telemetry stream on fd ${this.fd} failed.`;
  }
}

export class DesktopTelemetryStreamClosed extends Schema.TaggedErrorClass<DesktopTelemetryStreamClosed>()(
  "DesktopTelemetryStreamClosed",
  {
    fd: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry stream on fd ${this.fd} closed.`;
  }
}

export class DesktopTelemetryStale extends Schema.TaggedErrorClass<DesktopTelemetryStale>()(
  "DesktopTelemetryStale",
  {
    fd: Schema.Number,
    staleAfterMs: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry on fd ${this.fd} has not updated for ${this.staleAfterMs}ms.`;
  }
}

export type DesktopTelemetryReceiverError =
  | DesktopTelemetryDescriptorUnavailable
  | DesktopTelemetryProtocolMismatch
  | DesktopTelemetryDecodeFailed
  | DesktopTelemetryStreamFailed
  | DesktopTelemetryStreamClosed;

export class DesktopTelemetryControlFailed extends Schema.TaggedErrorClass<DesktopTelemetryControlFailed>()(
  "DesktopTelemetryControlFailed",
  {
    fd: Schema.Number,
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop telemetry control '${this.operation}' failed on fd ${this.fd}.`;
  }
}

export class DesktopTelemetryControlStalled extends Schema.TaggedErrorClass<DesktopTelemetryControlStalled>()(
  "DesktopTelemetryControlStalled",
  {
    fd: Schema.Number,
    remainingBytes: Schema.Number,
  },
) {
  override get message(): string {
    return `Desktop telemetry control stalled on fd ${this.fd} with ${this.remainingBytes} bytes remaining.`;
  }
}

export type DesktopTelemetryControlError =
  | DesktopTelemetryControlFailed
  | DesktopTelemetryControlStalled;

export interface DesktopTelemetryReceiverHealth {
  readonly status: ResourceTelemetrySourceStatus;
  readonly lastSampleAt: Option.Option<DateTime.Utc>;
  readonly lastError: Option.Option<string>;
}
