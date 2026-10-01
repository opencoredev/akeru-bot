
import * as Effect from "effect/Effect";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_FILES,
  DEFAULT_BATCH_WINDOW_MS,
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_MAX_AGE_MS,
  DEFAULT_RETENTION_CHECK_INTERVAL_MS,
  DEFAULT_MAX_BUFFERED_BYTES,
  DEFAULT_MAX_BUFFERED_RECORDS,
  type EventNdjsonLogStoreOptions,
  EventNdjsonLogConfigurationError,
  type ResolvedOptions,
} from "./EventLogTypes.ts";

export function validateOption(input: {
  readonly filePath: string;
  readonly option: string;
  readonly value: number;
  readonly minimum: number;
}): EventNdjsonLogConfigurationError | undefined {
  if (Number.isInteger(input.value) && input.value >= input.minimum) return undefined;

  return new EventNdjsonLogConfigurationError(input);
}

export function resolveOptions(
  filePath: string,
  options: EventNdjsonLogStoreOptions,
): Effect.Effect<ResolvedOptions, EventNdjsonLogConfigurationError> {
  const resolved = {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    maxFiles: options.maxFiles ?? DEFAULT_MAX_FILES,
    batchWindowMs: options.batchWindowMs ?? DEFAULT_BATCH_WINDOW_MS,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
    maxAgeMs: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
    retentionCheckIntervalMs:
      options.retentionCheckIntervalMs ?? DEFAULT_RETENTION_CHECK_INTERVAL_MS,
    maxBufferedBytes: options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES,
    maxBufferedRecords: options.maxBufferedRecords ?? DEFAULT_MAX_BUFFERED_RECORDS,
    attribution: options.attribution,
  } satisfies ResolvedOptions;

  const validations = [
    ["maxBytes", resolved.maxBytes, 1],
    ["maxFiles", resolved.maxFiles, 1],
    ["batchWindowMs", resolved.batchWindowMs, 0],
    ["maxTotalBytes", resolved.maxTotalBytes, 1],
    ["maxAgeMs", resolved.maxAgeMs, 1],
    ["retentionCheckIntervalMs", resolved.retentionCheckIntervalMs, 1],
    ["maxBufferedBytes", resolved.maxBufferedBytes, 1],
    ["maxBufferedRecords", resolved.maxBufferedRecords, 1],
  ] as const;

  for (const [option, value, minimum] of validations) {
    const error = validateOption({ filePath, option, value, minimum });

    if (error) return Effect.fail(error);
  }

  return Effect.succeed(resolved);
}
