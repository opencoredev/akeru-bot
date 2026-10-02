import { assert, describe } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Order from "effect/Order";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Tracer from "effect/Tracer";
import {
  makeLocalFileTracer,
  traceSink,
  type TraceRecord,
  type TraceSinkFlushStats,
} from "./observability.ts";
import {
  makeRecord,
  readTraceRecords,
  makeTestLayer,
  nodeServicesIt,
} from "./observability.test-support.ts";

describe("observability", () => {
  nodeServicesIt("node services", (it) => {
    it.effect("flushes buffered trace records on close", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* traceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        }),
      ),
    );

    it.effect("drains trace records when the owning fiber is interrupted", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tempDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-trace-interrupt-",
        });

        for (const count of [0, 1, 256]) {
          const tracePath = path.join(tempDir, `${count}.ndjson`);
          const ready = yield* Deferred.make<void>();

          const owner = yield* Effect.gen(function* () {
            const sink = yield* traceSink({
              filePath: tracePath,
              maxBytes: 1024 * 1024,
              maxFiles: 2,
              batchWindowMs: 10_000,
            });

            for (let index = 0; index < count; index++) sink.push(makeRecord(`record-${index}`));
            yield* Deferred.succeed(ready, undefined);

            return yield* Effect.never;
          }).pipe(Effect.scoped, Effect.forkChild);

          yield* Deferred.await(ready);
          yield* Fiber.interrupt(owner);

          if (count > 0) assert.equal((yield* readTraceRecords(tracePath)).length, count);
        }
      }),
    );

    it.effect("bounds queued trace bytes, reports drops, and rejects pushes after close", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-trace-bound-" });
          const tracePath = path.join(dir, "trace.ndjson");
          const messages: unknown[] = [];

          const capture = Logger.make<unknown, void>(({ message }) => {
            messages.push(message);
          });

          yield* Effect.gen(function* () {
            const sink = yield* traceSink({
              filePath: tracePath,
              maxBytes: 1024,
              maxFiles: 2,
              maxBufferedBytes: 1024,
              batchWindowMs: 10_000,
            });

            for (let index = 0; index < 1000; index++) sink.push(makeRecord("bounded"));
            yield* sink.close();
            const records = yield* readTraceRecords(tracePath);
            assert.isAbove(records.length, 0);
            assert.isBelow(records.length, 1000);
            assert.isAtMost(Number((yield* fs.stat(tracePath)).size), 1024);
            sink.push(makeRecord("after-close"));
            yield* sink.flush;
            assert.equal((yield* readTraceRecords(tracePath)).length, records.length);
          }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
          assert.isAbove(messages.length, 0);
        }),
      ),
    );

    it.effect(
      "reports asynchronous write failures without retrying records or claiming attribution",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const path = yield* Path.Path;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-trace-error-" });
            const tracePath = path.join(dir, "not-a-file");
            yield* fs.makeDirectory(tracePath);
            const messages: unknown[] = [];
            const stats: TraceSinkFlushStats[] = [];

            const capture = Logger.make<unknown, void>(({ message }) => {
              messages.push(message);
            });

            yield* Effect.gen(function* () {
              const sink = yield* traceSink({
                filePath: tracePath,
                maxBytes: 1024 * 1024,
                maxFiles: 2,
                batchWindowMs: 10_000,
                onFlush: (entry) =>
                  Effect.sync(() => {
                    stats.push(entry);
                  }),
              });

              sink.push(makeRecord("failed"));
              yield* sink.flush;
              yield* sink.close();
              yield* sink.close();
            }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
            assert.equal(messages.length, 1);
            assert.deepEqual(stats, []);
          }),
        ),
    );

    it.effect(
      "honors the local tracer buffer limit and flushes its owned sink on scope close",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-local-tracer-bound-" });
          const tracePath = path.join(dir, "trace.ndjson");
          yield* Effect.scoped(
            Effect.gen(function* () {
              const tracer = yield* makeLocalFileTracer({
                filePath: tracePath,
                maxBytes: 1024 * 1024,
                maxFiles: 2,
                maxBufferedBytes: 1024,
                batchWindowMs: 10_000,
              });

              for (let index = 0; index < 100; index++) {
                yield* Effect.void.pipe(
                  Effect.withSpan("bounded"),
                  Effect.provideService(Tracer.Tracer, tracer),
                );
              }
            }),
          );
          const records = yield* readTraceRecords(tracePath);
          assert.isAbove(records.length, 0);
          assert.isBelow(records.length, 100);
          assert.isAtMost(Number((yield* fs.stat(tracePath)).size), 1024);
        }),
    );

    it.effect("reports successful logical trace writes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const reported = yield* Ref.make<ReadonlyArray<TraceSinkFlushStats>>([]);

          const sink = yield* traceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            onFlush: (stats) => Ref.update(reported, (current) => [...current, stats]),
          });

          sink.push(makeRecord("attributed"));
          yield* sink.flush;

          const stats = yield* Ref.get(reported);
          assert.equal(stats.length, 1);
          assert.equal(stats[0]?.count, 1);
          assert.isAbove(stats[0]?.logicalWriteBytes ?? 0, 0);
        }),
      ),
    );

    it.effect("rotates the trace file when the configured max size is exceeded", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* traceSink({
            filePath: tracePath,
            maxBytes: 500,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }

          yield* sink.close();

          const matchingFiles = Arr.sort(
            (yield* fileSystem.readDirectory(tempDir)).filter(
              (entry) =>
                entry === "shared.trace.ndjson" || entry.startsWith("shared.trace.ndjson."),
            ),
            Order.String,
          );

          assert.equal(
            matchingFiles.some((entry) => entry === "shared.trace.ndjson.1"),
            true,
          );
          assert.equal(
            matchingFiles.some((entry) => entry === "shared.trace.ndjson.3"),
            false,
          );
        }),
      ),
    );

    it.effect("keeps every trace file within the configured limit for threshold flushes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const maxBytes = 1_024;

          const sink = yield* traceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 256; index += 1) {
            sink.push(makeRecord("threshold", `${index}-${"x".repeat(48)}`));
          }

          yield* sink.close();

          const matchingFiles = (yield* fileSystem.readDirectory(tempDir)).filter(
            (entry) => entry === "shared.trace.ndjson" || entry.startsWith("shared.trace.ndjson."),
          );

          assert.include(matchingFiles, "shared.trace.ndjson.1");

          for (const entry of matchingFiles) {
            const stat = yield* fileSystem.stat(path.join(tempDir, entry));
            assert.isAtMost(Number(stat.size), maxBytes, entry);
          }
        }),
      ),
    );

    it.effect("drops a single trace record that cannot fit within the configured limit", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");
          const maxBytes = 1_024;

          const sink = yield* traceSink({
            filePath: tracePath,
            maxBytes,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("oversized", "x".repeat(maxBytes * 2)));
          sink.push(makeRecord("retained"));
          yield* sink.close();

          const records = yield* readTraceRecords(tracePath);
          const stat = yield* fileSystem.stat(tracePath);
          assert.deepEqual(
            records.map((record) => record.name),
            ["retained"],
          );
          assert.isAtMost(Number(stat.size), maxBytes);
        }),
      ),
    );

    it.effect("drops only the invalid trace record when serialization fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-trace-sink-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          const sink = yield* traceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          const circular: Array<unknown> = [];
          circular.push(circular);

          sink.push(makeRecord("alpha"));
          sink.push({
            ...makeRecord("invalid"),
            attributes: {
              circular,
            },
          } as TraceRecord);
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = yield* readTraceRecords(tracePath);

          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["alpha", "beta"],
          );
        }),
      ),
    );

    it.effect("writes nested spans to disk and captures log messages as span events", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.gen(function* () {
              const program = Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.parent": true,
                });
                yield* Effect.logInfo("parent event");
                yield* Effect.gen(function* () {
                  yield* Effect.annotateCurrentSpan({
                    "demo.child": true,
                  });
                  yield* Effect.logInfo("child event");
                }).pipe(Effect.withSpan("child-span"));
              }).pipe(Effect.withSpan("parent-span"));

              yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
            }),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.equal(records.length, 2);

          const parent = records.find((record) => record.name === "parent-span");
          const child = records.find((record) => record.name === "child-span");

          assert.notEqual(parent, undefined);
          assert.notEqual(child, undefined);

          if (!parent || !child) {
            return;
          }

          assert.equal(child.parentSpanId, parent.spanId);
          assert.equal(parent.attributes["demo.parent"], true);
          assert.equal(child.attributes["demo.child"], true);
          assert.equal(
            parent.events.some((event) => event.name === "parent event"),
            true,
          );
          assert.equal(
            child.events.some((event) => event.name === "child event"),
            true,
          );
          assert.equal(
            child.events.some((event) => event.attributes["effect.logLevel"] === "INFO"),
            true,
          );
        }),
      ),
    );

    it.effect("serializes interrupted spans with an interrupted exit status", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const tempDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-local-tracer-" });
          const tracePath = path.join(tempDir, "shared.trace.ndjson");

          yield* Effect.scoped(
            Effect.exit(
              Effect.interrupt.pipe(
                Effect.withSpan("interrupt-span"),
                Effect.provide(makeTestLayer(tracePath)),
              ),
            ),
          );

          const records = yield* readTraceRecords(tracePath);
          assert.equal(records.length, 1);
          assert.equal(records[0]?.name, "interrupt-span");
          assert.equal(records[0]?.exit?._tag, "Interrupted");
        }),
      ),
    );
  });
});
