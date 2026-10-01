// @effect-diagnostics nodeBuiltinImport:off

import type { ThreadId } from "@akeru/contracts";
import { RotatingFileSink } from "@akeru/shared/logging";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { ResourceAttribution } from "../../../resourceTelemetry/ResourceAttribution.ts";

export const MEBIBYTE = 1024 * 1024;

export const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_MAX_BYTES = 10 * MEBIBYTE;

export const DEFAULT_MAX_FILES = 10;

export const DEFAULT_BATCH_WINDOW_MS = 1_000;

export const DEFAULT_MAX_TOTAL_BYTES = 512 * MEBIBYTE;

export const DEFAULT_MAX_AGE_MS = 14 * DAY_MS;

export const DEFAULT_RETENTION_CHECK_INTERVAL_MS = 5 * 60 * 1_000;

export const DEFAULT_MAX_BUFFERED_BYTES = MEBIBYTE;

export const DEFAULT_MAX_BUFFERED_RECORDS = 512;

export const GLOBAL_THREAD_SEGMENT = "_global";

export const LOG_SCOPE = "provider-observability";

export type EventNdjsonStream = "native" | "canonical" | "orchestration";

export interface EventNdjsonLogger {
  readonly filePath: string;
  readonly write: <Event>(event: Event, threadId: ThreadId | null) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStore {
  readonly filePath: string;
  readonly logger: (stream: EventNdjsonStream) => EventNdjsonLogger;
  readonly flush: Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export interface EventNdjsonLogStoreOptions {
  readonly maxBytes?: number;
  readonly maxFiles?: number;
  readonly batchWindowMs?: number;
  readonly maxTotalBytes?: number;
  readonly maxAgeMs?: number;
  readonly retentionCheckIntervalMs?: number;
  readonly maxBufferedBytes?: number;
  readonly maxBufferedRecords?: number;
  readonly attribution?: ResourceAttribution["Service"];
}

export interface EventNdjsonLoggerOptions extends EventNdjsonLogStoreOptions {
  readonly stream: EventNdjsonStream;
}

export class EventNdjsonLogConfigurationError extends Schema.TaggedErrorClass<EventNdjsonLogConfigurationError>()(
  "EventNdjsonLogConfigurationError",
  {
    filePath: Schema.String,
    option: Schema.String,
    value: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `Provider event log option '${this.option}' must be an integer >= ${this.minimum}; received ${this.value} for '${this.filePath}'`;
  }
}

export class EventNdjsonLogDirectoryError extends Schema.TaggedErrorClass<EventNdjsonLogDirectoryError>()(
  "EventNdjsonLogDirectoryError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to create provider event log directory '${this.directory}'`;
  }
}

export type EventNdjsonLogStoreError =
  | EventNdjsonLogConfigurationError
  | EventNdjsonLogDirectoryError;

export interface ResolvedOptions {
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly retentionCheckIntervalMs: number;
  readonly maxBufferedBytes: number;
  readonly maxBufferedRecords: number;
  readonly attribution: ResourceAttribution["Service"] | undefined;
}

export interface PendingRecord {
  readonly stream: EventNdjsonStream;
  readonly threadSegment: string;
  readonly line: string;
  readonly bytes: number;
}

export interface StoreState {
  readonly pending: Array<PendingRecord>;
  readonly pendingBytes: number;
  readonly sinks: ReadonlyMap<string, RotatingFileSink>;
  readonly flushScheduled: boolean;
  readonly closed: boolean;
  readonly lastRetentionAt: number;
}

export interface AttributionSummary {
  readonly stream: EventNdjsonStream;
  readonly count: number;
  readonly logicalWriteBytes: number;
}

export interface FileOperationFailure {
  readonly filePath: string;
  readonly cause: unknown;
}

export interface RetentionResult {
  readonly failures: ReadonlyArray<FileOperationFailure>;
}

export interface DrainResult {
  readonly attributions: ReadonlyArray<AttributionSummary>;
  readonly failures: ReadonlyArray<FileOperationFailure>;
}
