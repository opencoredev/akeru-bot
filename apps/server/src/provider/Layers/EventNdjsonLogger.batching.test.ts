// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@akeru/contracts";
import { assert, describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as ResourceAttribution from "../../resourceTelemetry/ResourceAttribution.ts";
import {
  makeEventNdjsonLogger,
  makeEventNdjsonLogStore,
  type PendingRecord,
  writeBatchedMessages,
} from "./EventNdjsonLogger.ts";
import { encodeUnknownJson, ownedLogPath, parseLogLine } from "./test-support/eventLogs.ts";

describe("EventNdjsonLogger", () => {
  it.effect("closes empty and buffered stores when the owning fiber is interrupted", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-interrupt-"));

      try {
        for (const count of [0, 1]) {
          const basePath = NodePath.join(tempDir, `provider-${count}.ndjson`);
          const ready = yield* Deferred.make<void>();

          const owner = yield* Effect.gen(function* () {
            const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 10_000 });
            yield* Effect.addFinalizer(() => store.close());

            if (count > 0) {
              yield* store.logger("native").write({ id: "accepted" }, ThreadId.make("thread-1"));
            }

            yield* Deferred.succeed(ready, undefined);

            return yield* Effect.never;
          }).pipe(Effect.scoped, Effect.forkChild);

          yield* Deferred.await(ready);
          yield* Fiber.interrupt(owner);

          if (count > 0) {
            const line = NodeFS.readFileSync(ownedLogPath(basePath, "thread-1"), "utf8").trim();
            assert.equal(parseLogLine(line).payload, '{"id":"accepted"}');
          }
        }
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("keeps shared store views non-owning when one adapter closes", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared-close");

        yield* native.write({ id: "before-close" }, threadId);
        yield* native.close();
        yield* canonical.write({ type: "item.completed", id: "after-close" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-shared-close"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "NTIVE", payload: '{"id":"before-close"}' },
            {
              stream: "CANON",
              payload: '{"type":"item.completed","id":"after-close"}',
            },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("flushes an active batch without a permanent polling loop", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadPath = ownedLogPath(basePath, "thread-batched");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 1_000 });
        yield* store
          .logger("native")
          .write({ id: "batched-event" }, ThreadId.make("thread-batched"));

        assert.equal(NodeFS.existsSync(threadPath), false);
        yield* TestClock.adjust(1_000);
        yield* store.flush;
        assert.equal(NodeFS.existsSync(threadPath), true);
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("does not strand a later batch after an interrupted write", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const threadPath = ownedLogPath(basePath, "thread-interrupted");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 1_000 });
        const logger = store.logger("native");

        const interruptedWrite = yield* logger
          .write({ id: "possibly-interrupted" }, ThreadId.make("thread-interrupted"))
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(interruptedWrite);
        yield* logger.write({ id: "accepted" }, ThreadId.make("thread-interrupted"));

        yield* TestClock.adjust(1_000);
        yield* store.flush;

        assert.equal(NodeFS.existsSync(threadPath), true);
        assert.include(NodeFS.readFileSync(threadPath, "utf8"), '{"id":"accepted"}');
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });

        assert.notEqual(logger, undefined);

        if (!logger) {
          return;
        }

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        const globalPath = ownedLogPath(basePath, "_global");
        assert.equal(NodeFS.existsSync(globalPath), true);

        const lines = NodeFS.readFileSync(globalPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.payload).toSorted(), [
          '{"id":"evt-concurrent-1"}',
          '{"id":"evt-concurrent-2"}',
        ]);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it("attributes batches that were written before a later chunk fails", async () => {
    const records: ReadonlyArray<PendingRecord> = [
      {
        stream: "native",
        threadSegment: "thread",
        line: "first",
        bytes: 5,
      },
      {
        stream: "canonical",
        threadSegment: "thread",
        line: "second",
        bytes: 6,
      },
    ];

    const attributed: Array<PendingRecord> = [];
    let writes = 0;

    await expect(
      writeBatchedMessages(
        {
          write: async () => {
            writes += 1;

            if (writes === 2) throw new Error("simulated disk exhaustion");
          },
        },
        records,
        5,
        (written) => attributed.push(...written),
      ),
    ).rejects.toThrow("simulated disk exhaustion");
    assert.deepEqual(attributed, [records[0]]);
  });
});

describe("EventNdjsonLogger", () => {
  it.effect(
    "backpressures concurrent batches within byte and record limits and flushes in order",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-bound-"));
        const basePath = NodePath.join(tempDir, "events.log");

        try {
          const store = yield* makeEventNdjsonLogStore(basePath, {
            maxBufferedBytes: 160,
            maxBufferedRecords: 2,
            batchWindowMs: 1_000,
          });

          const native = store.logger("native");
          const canonical = store.logger("canonical");
          yield* Effect.all(
            Array.from({ length: 20 }, (_, index) =>
              (index % 2 ? canonical : native).write({ id: index }, ThreadId.make("ordered")),
            ),
            { concurrency: "unbounded" },
          );
          yield* native.close();
          yield* store.flush;
          yield* store.close();

          const lines = NodeFS.readFileSync(ownedLogPath(basePath, "ordered"), "utf8")
            .trim()
            .split("\n")
            .map(parseLogLine);

          assert.deepEqual(
            lines.map((line) => line.payload),
            Array.from({ length: 20 }, (_, id) => encodeUnknownJson({ id })),
          );
          let serializedAfterClose = false;
          yield* native.write(
            {
              toJSON: () => {
                serializedAfterClose = true;

                return {};
              },
            },
            null,
          );
          assert.isFalse(serializedAfterClose);
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("reports logical provider log writes to resource attribution", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const attribution = yield* ResourceAttribution.make();

        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          batchWindowMs: 0,
          attribution,
        });

        assert.notEqual(logger, undefined);

        if (!logger) {
          return;
        }

        yield* logger.write({ id: "attributed-event" }, ThreadId.make("thread-attribution"));
        yield* logger.close();

        const snapshot = yield* attribution.snapshot;
        assert.equal(snapshot.entries.length, 1);
        assert.equal(snapshot.entries[0]?.component, "provider-event-log");
        assert.equal(snapshot.entries[0]?.operation, "native.append");
        assert.equal(snapshot.entries[0]?.count, 1);
        assert.isAbove(snapshot.entries[0]?.logicalWriteBytes ?? 0, 0);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
