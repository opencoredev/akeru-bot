import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { RotatingFileSink } from "../logging.ts";
import { type TraceRecord } from "./types.ts";
import { errorTag } from "./attributes.ts";

const FLUSH_BUFFER_THRESHOLD = 256;

const DEFAULT_MAX_BUFFERED_BYTES = 1024 * 1024;

export interface TraceSinkOptions {
  readonly filePath: string;
  readonly maxBytes: number;
  readonly maxFiles: number;
  readonly batchWindowMs: number;
  readonly maxBufferedBytes?: number;
  readonly onFlush?: (stats: TraceSinkFlushStats) => Effect.Effect<void>;
}

export interface TraceSinkFlushStats {
  readonly logicalWriteBytes: number;
  readonly count: number;
  readonly durationMs: number;
}

export interface TraceSink {
  readonly filePath: string;
  push: (record: TraceRecord) => void;
  flush: Effect.Effect<void>;
  close: () => Effect.Effect<void>;
}

export const makeTraceSink = Effect.fn("makeTraceSink")(function* (options: TraceSinkOptions) {
  const maxBufferedBytes = options.maxBufferedBytes ?? DEFAULT_MAX_BUFFERED_BYTES;

  const sink = new RotatingFileSink({
    filePath: options.filePath,
    maxBytes: options.maxBytes,
    maxFiles: options.maxFiles,
    maxBufferedBytes,
  });

  let buffer: Array<{ line: string; bytes: number }> = [];
  let bufferedBytes = 0;
  let closed = false;
  let droppedRecords = 0;
  let writeError: unknown;
  let reportedWriteError = false;
  let pendingFlushStats: TraceSinkFlushStats = { logicalWriteBytes: 0, count: 0, durationMs: 0 };

  const submit = () => {
    const records = buffer;
    buffer = [];
    bufferedBytes = 0;
    let index = 0;

    while (index < records.length) {
      const start = index;
      let bytes = 0;
      const lines: string[] = [];

      while (index < records.length) {
        const record = records[index]!;

        if (bytes + record.bytes > options.maxBytes) break;
        bytes += record.bytes;
        lines.push(record.line);
        index += 1;
      }

      const count = index - start;
      const startedAt = performance.now();
      void sink.write(lines.join("")).then(
        () => {
          pendingFlushStats = {
            logicalWriteBytes: pendingFlushStats.logicalWriteBytes + bytes,
            count: pendingFlushStats.count + count,
            durationMs: pendingFlushStats.durationMs + Math.max(0, performance.now() - startedAt),
          };
        },
        (cause: unknown) => {
          writeError = cause;
          droppedRecords += count;
        },
      );
    }
  };

  const drain = (close: boolean) =>
    Effect.gen(function* () {
      if (close) closed = true;
      submit();
      yield* Effect.promise(() => (close ? sink.close() : sink.flush())).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            writeError ??= Cause.squash(cause);
          }),
        ),
      );
      const stats = pendingFlushStats;
      pendingFlushStats = { logicalWriteBytes: 0, count: 0, durationMs: 0 };
      const dropped = droppedRecords;
      droppedRecords = 0;

      if (dropped > 0 || (writeError !== undefined && !reportedWriteError)) {
        reportedWriteError = writeError !== undefined;
        yield* Effect.logWarning("trace log records could not be persisted", {
          filePath: options.filePath,
          droppedRecords: dropped,
          ...(writeError !== undefined ? { errorTag: errorTag(writeError) } : {}),
        });
      }

      if (stats.count > 0 && options.onFlush) yield* options.onFlush(stats).pipe(Effect.ignore);
    }).pipe(Effect.withTracerEnabled(false), Effect.uninterruptible);

  const flush = drain(false);
  const close = () => drain(true);

  yield* Effect.addFinalizer(close);
  yield* Effect.forkScoped(
    Effect.sleep(`${options.batchWindowMs} millis`).pipe(Effect.andThen(flush), Effect.forever),
  );

  return {
    filePath: options.filePath,
    push(record) {
      if (closed) return;

      try {
        const line = `${JSON.stringify(record)}\n`;
        const bytes = Buffer.byteLength(line);

        if (
          bytes > options.maxBytes ||
          bufferedBytes + sink.bufferedBytes + bytes > maxBufferedBytes
        ) {
          droppedRecords += 1;

          return;
        }

        buffer.push({ line, bytes });
        bufferedBytes += bytes;

        if (buffer.length >= FLUSH_BUFFER_THRESHOLD) submit();
      } catch {
        droppedRecords += 1;
      }
    },
    flush,
    close,
  } satisfies TraceSink;
});
