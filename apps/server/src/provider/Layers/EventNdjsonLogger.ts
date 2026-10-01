// @effect-diagnostics nodeBuiltinImport:off
/**
 * Best-effort provider event logging with one shared writer per thread.
 *
 * Native and canonical views share batching, rotation, and retention state so
 * they cannot race while appending to the same thread-scoped file.
 */
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { ThreadId } from "@akeru/contracts";
import { RotatingFileSink } from "@akeru/shared/logging";
import { errorTag } from "@akeru/shared/observability";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  type EventNdjsonStream,
  type EventNdjsonLogger,
  type EventNdjsonLogStore,
  type EventNdjsonLogStoreOptions,
  type EventNdjsonLoggerOptions,
  EventNdjsonLogDirectoryError,
  type EventNdjsonLogStoreError,
  type ResolvedOptions,
  type PendingRecord,
  type StoreState,
  type FileOperationFailure,
  type RetentionResult,
  type DrainResult,
} from "./logging/EventLogTypes.ts";
import {
  logWarning,
  resolveThreadSegment,
  resolveStreamLabel,
  providerLogPrefix,
  providerLogPath,
  shouldPersist,
  serializeEvent,
} from "./logging/EventLogEncoding.ts";
import { writeBatchedMessages } from "./logging/EventLogFiles.ts";
import { resolveOptions } from "./logging/EventLogOptions.ts";

async function isProviderLogFile(
  filePath: string,
  fileName: string,
  filePrefix: string,
): Promise<boolean> {
  if (!/\.log(?:\.\d+)?$/u.test(fileName)) return false;

  if (fileName.startsWith(filePrefix)) return true;

  const descriptor = await NodeFSP.open(filePath, "r");

  try {
    const header = Buffer.alloc(256);
    const { bytesRead } = await descriptor.read(header, 0, header.byteLength, 0);

    return /^\[[^\]\r\n]+\] (?:NTIVE|CANON|ORCH): /u.test(header.toString("utf8", 0, bytesRead));
  } finally {
    await descriptor.close();
  }
}

async function enforceRetention(input: {
  readonly directory: string;
  readonly maxTotalBytes: number;
  readonly maxAgeMs: number;
  readonly activeFilePaths: ReadonlySet<string>;
  readonly filePrefix: string;
  readonly now: number;
}): Promise<RetentionResult> {
  const failures: Array<FileOperationFailure> = [];
  const files: Array<{ filePath: string; mtimeMs: number; size: number }> = [];

  let entries: ReadonlyArray<NodeFS.Dirent>;

  try {
    entries = await NodeFSP.readdir(input.directory, { withFileTypes: true });
  } catch (cause) {
    return { failures: [{ filePath: input.directory, cause }] };
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const filePath = NodePath.join(input.directory, entry.name);

    try {
      if (!(await isProviderLogFile(filePath, entry.name, input.filePrefix))) continue;
      const stat = await NodeFSP.stat(filePath);
      files.push({ filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (cause) {
      failures.push({ filePath, cause });
    }
  }

  let totalBytes = files.reduce((total, file) => total + file.size, 0);

  const remove = async (file: (typeof files)[number]) => {
    if (input.activeFilePaths.has(file.filePath)) return false;

    try {
      await NodeFSP.rm(file.filePath, { force: true });
      totalBytes -= file.size;

      return true;
    } catch (cause) {
      failures.push({ filePath: file.filePath, cause });

      return false;
    }
  };

  const retained: typeof files = [];

  for (const file of files) {
    if (input.now - file.mtimeMs <= input.maxAgeMs || !(await remove(file))) retained.push(file);
  }

  for (const file of retained.toSorted(
    (left, right) => left.mtimeMs - right.mtimeMs || left.filePath.localeCompare(right.filePath),
  )) {
    if (totalBytes <= input.maxTotalBytes) break;
    await remove(file);
  }

  return { failures };
}

async function drainPending(input: {
  readonly directory: string;
  readonly options: ResolvedOptions;
  readonly state: StoreState;
  readonly filePrefix: string;
  readonly now: number;
  readonly timerFired: boolean;
  readonly close: boolean;
}): Promise<readonly [DrainResult, StoreState]> {
  if (input.state.closed) {
    return [{ attributions: [], failures: [] }, input.state];
  }

  const sinks = new Map(input.state.sinks);
  const failures: Array<FileOperationFailure> = [];

  const attributionByStream = new Map<
    EventNdjsonStream,
    { count: number; logicalWriteBytes: number }
  >();

  const recordsBySegment = new Map<string, Array<PendingRecord>>();

  for (const record of input.state.pending) {
    const records = recordsBySegment.get(record.threadSegment) ?? [];
    records.push(record);
    recordsBySegment.set(record.threadSegment, records);
  }

  for (const [threadSegment, records] of recordsBySegment) {
    const filePath = providerLogPath(input.directory, input.filePrefix, threadSegment);
    let sink = sinks.get(threadSegment);

    if (!sink) {
      try {
        sink = new RotatingFileSink({
          filePath,
          maxBytes: input.options.maxBytes,
          maxFiles: input.options.maxFiles,
          maxBufferedBytes: input.options.maxBufferedBytes,
        });
        sinks.set(threadSegment, sink);
      } catch (cause) {
        failures.push({ filePath, cause });
        continue;
      }
    }

    try {
      await writeBatchedMessages(sink, records, input.options.maxBytes, (writtenRecords) => {
        for (const record of writtenRecords) {
          const current = attributionByStream.get(record.stream) ?? {
            count: 0,
            logicalWriteBytes: 0,
          };

          attributionByStream.set(record.stream, {
            count: current.count + 1,
            logicalWriteBytes: current.logicalWriteBytes + record.bytes,
          });
        }
      });
    } catch (cause) {
      await sink.close().catch(() => undefined);
      sinks.delete(threadSegment);
      failures.push({ filePath, cause });
    }
  }

  const retentionDue =
    input.now - input.state.lastRetentionAt >= input.options.retentionCheckIntervalMs;

  const retention = retentionDue
    ? await enforceRetention({
        directory: input.directory,
        maxTotalBytes: input.options.maxTotalBytes,
        maxAgeMs: input.options.maxAgeMs,
        activeFilePaths: new Set(
          Array.from(sinks.keys(), (threadSegment) =>
            providerLogPath(input.directory, input.filePrefix, threadSegment),
          ),
        ),
        filePrefix: input.filePrefix,
        now: input.now,
      })
    : { failures: [] };

  if (input.close) {
    for (const [segment, sink] of sinks) {
      try {
        await sink.close();
      } catch (cause) {
        failures.push({
          filePath: providerLogPath(input.directory, input.filePrefix, segment),
          cause,
        });
      }
    }

    sinks.clear();
  }

  return [
    {
      attributions: Array.from(attributionByStream, ([stream, value]) => ({
        stream,
        ...value,
      })),
      failures: [...failures, ...retention.failures],
    },
    {
      pending: [],
      pendingBytes: 0,
      sinks,
      flushScheduled: input.timerFired ? false : input.state.flushScheduled,
      closed: input.close,
      lastRetentionAt: retentionDue ? input.now : input.state.lastRetentionAt,
    },
  ];
}

export const makeEventNdjsonLogStore = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLogStoreOptions = {},
): Effect.fn.Return<EventNdjsonLogStore, EventNdjsonLogStoreError> {
  const resolved = yield* resolveOptions(filePath, options);
  const directory = NodePath.dirname(filePath);
  const filePrefix = providerLogPrefix(filePath);

  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(directory, { recursive: true }),
    catch: (cause) => new EventNdjsonLogDirectoryError({ directory, cause }),
  });

  const initializedAt = yield* Clock.currentTimeMillis;

  const initialRetention = yield* Effect.promise(() =>
    enforceRetention({
      directory,
      maxTotalBytes: resolved.maxTotalBytes,
      maxAgeMs: resolved.maxAgeMs,
      activeFilePaths: new Set(),
      filePrefix,
      now: initializedAt,
    }),
  );

  for (const failure of initialRetention.failures) {
    yield* logWarning("provider event log retention failed", {
      filePath: failure.filePath,
      errorTag: errorTag(failure.cause),
    });
  }

  const stateRef = yield* SynchronizedRef.make<StoreState>({
    pending: [],
    pendingBytes: 0,
    sinks: new Map(),
    flushScheduled: false,
    closed: false,
    lastRetentionAt: initializedAt,
  });

  const timerScope = yield* Scope.make();

  const drain = (state: StoreState, now: number, timerFired = false, close = false) =>
    Effect.promise(() =>
      drainPending({ directory, options: resolved, state, filePrefix, now, timerFired, close }),
    );

  const reportDrain = Effect.fnUntraced(function* (result: DrainResult, startedAt: number) {
    for (const failure of result.failures) {
      yield* logWarning("provider event log write or retention failed", {
        filePath: failure.filePath,
        errorTag: errorTag(failure.cause),
      });
    }

    if (resolved.attribution && result.attributions.length > 0) {
      const completedAt = yield* Clock.currentTimeMillis;
      const durationMs = Math.max(0, completedAt - startedAt);

      const totalBytes = result.attributions.reduce(
        (total, entry) => total + entry.logicalWriteBytes,
        0,
      );

      yield* Effect.forEach(
        result.attributions,
        (entry) =>
          resolved.attribution?.record({
            component: "provider-event-log",
            operation: `${entry.stream}.append`,
            logicalWriteBytes: entry.logicalWriteBytes,
            count: entry.count,
            durationMs:
              totalBytes === 0
                ? 0
                : Math.round(durationMs * (entry.logicalWriteBytes / totalBytes)),
          }) ?? Effect.void,
        { discard: true },
      );
    }
  });

  const flush = Effect.fnUntraced(function* (timerFired: boolean, close: boolean) {
    const startedAt = yield* Clock.currentTimeMillis;

    const result = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
      drain(state, startedAt, timerFired, close),
    );

    yield* reportDrain(result, startedAt);
  }, Effect.uninterruptible);

  const scheduleFlush = Effect.fnUntraced(function* () {
    yield* Effect.forkIn(
      Effect.sleep(resolved.batchWindowMs).pipe(Effect.andThen(flush(true, false))),
      timerScope,
      { startImmediately: true },
    );
  });

  const close = Effect.fnUntraced(function* () {
    yield* flush(false, true);
    yield* Scope.close(timerScope, Exit.void);
  }, Effect.uninterruptible);

  const loggerViews = new Map<EventNdjsonStream, EventNdjsonLogger>();

  const logger = (stream: EventNdjsonStream): EventNdjsonLogger => {
    const existing = loggerViews.get(stream);

    if (existing) return existing;

    const write = Effect.fnUntraced(function* (event: unknown, threadId: ThreadId | null) {
      if (!shouldPersist(stream, event)) return;
      const startedAt = yield* Clock.currentTimeMillis;

      const results = yield* SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          const results: DrainResult[] = [];

          if (state.closed) return [results, state] as const;
          const payload = yield* serializeEvent(event);

          if (payload === undefined) return [results, state] as const;
          const observedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const line = `[${observedAt}] ${resolveStreamLabel(stream)}: ${payload}\n`;
          const bytes = Buffer.byteLength(line);

          if (bytes > resolved.maxBufferedBytes) {
            yield* logWarning("provider event log record exceeds buffer capacity", {
              filePath,
              bytes,
            });

            return [results, state] as const;
          }

          let current = state;

          if (current.pendingBytes + bytes > resolved.maxBufferedBytes) {
            const [result, drained] = yield* drain(current, startedAt);
            results.push(result);
            current = drained;
          }

          const pending = current.pending;
          pending.push({ stream, threadSegment: resolveThreadSegment(threadId), line, bytes });
          const pendingBytes = current.pendingBytes + bytes;

          const flushNow =
            resolved.batchWindowMs === 0 ||
            pending.length >= resolved.maxBufferedRecords ||
            pendingBytes >= resolved.maxBufferedBytes;

          current = { ...current, pending, pendingBytes };

          if (flushNow) {
            const [result, drained] = yield* drain(current, startedAt);
            results.push(result);
            current = drained;
          } else if (!current.flushScheduled) {
            yield* scheduleFlush();
            current = { ...current, flushScheduled: true };
          }

          return [results, current] as const;
        }),
      ).pipe(Effect.uninterruptible);

      for (const result of results) yield* reportDrain(result, startedAt);
    });

    const view = { filePath, write, close: () => Effect.void } satisfies EventNdjsonLogger;
    loggerViews.set(stream, view);

    return view;
  };

  return { filePath, logger, flush: flush(false, false), close } satisfies EventNdjsonLogStore;
});

export const makeEventNdjsonLogger = Effect.fnUntraced(function* (
  filePath: string,
  options: EventNdjsonLoggerOptions,
): Effect.fn.Return<EventNdjsonLogger | undefined> {
  const store = yield* makeEventNdjsonLogStore(filePath, options).pipe(
    Effect.catch((error) =>
      logWarning(error.message, { error }).pipe(
        Effect.as<EventNdjsonLogStore | undefined>(undefined),
      ),
    ),
  );

  if (!store) return undefined;

  return { ...store.logger(options.stream), close: store.close };
});

export {
  type EventNdjsonStream,
  type EventNdjsonLogger,
  type EventNdjsonLogStore,
  type EventNdjsonLogStoreOptions,
  type EventNdjsonLoggerOptions,
  EventNdjsonLogConfigurationError,
  EventNdjsonLogDirectoryError,
  type EventNdjsonLogStoreError,
  type PendingRecord,
} from "./logging/EventLogTypes.ts";

export { writeBatchedMessages } from "./logging/EventLogFiles.ts";
