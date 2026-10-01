import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import { makeEventNdjsonLogger, makeEventNdjsonLogStore } from "./EventNdjsonLogger.ts";
import { encodeUnknownJson, ownedLogPath, parseLogLine } from "./test-support/eventLogs.ts";

describe("EventNdjsonLogger", () => {
  it.effect("logs bounded diagnostics when an event cannot be serialized", () => {
    const messages: Array<unknown> = [];

    const logCapture = Logger.make<unknown, void>(({ message }) => {
      if (Array.isArray(message)) {
        messages.push(...message);
      } else {
        messages.push(message);
      }
    });

    const secret = "secret-circular-event-value";

    return Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");
      const circular: CircularLogFixture = { secret };
      circular.self = circular;

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.exists(logger);

        if (!logger) return;
        yield* logger.write(circular, ThreadId.make("thread-1"));

        const serialized = encodeUnknownJson(messages);
        assert.notInclude(serialized, secret);
        assert.include(serialized, '"errorTag":"SchemaError"');
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(Logger.layer([logCapture], { mergeWithExisting: false })));
  });
});

describe("EventNdjsonLogger", () => {
  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);

        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.make("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.make("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = ownedLogPath(basePath, "thread-1");
        const threadTwoPath = ownedLogPath(basePath, "thread-2");
        assert.equal(NodeFS.existsSync(threadOnePath), true);
        assert.equal(NodeFS.existsSync(threadTwoPath), true);

        const first = parseLogLine(NodeFS.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(NodeFS.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
        const basePath = NodePath.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);

          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as ThreadId);
          yield* logger.close();

          const globalPath = ownedLogPath(basePath, "_global");
          assert.equal(NodeFS.existsSync(globalPath), true);

          const lines = NodeFS.readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));

          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "ORCH");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "ORCH");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("shares one thread writer across native and canonical streams", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const native = store.logger("native");
        const canonical = store.logger("canonical");
        const threadId = ThreadId.make("thread-shared");

        yield* native.write({ id: "native-event" }, threadId);
        yield* canonical.write({ type: "item.completed", id: "canonical-event" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-shared"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "NTIVE", payload: '{"id":"native-event"}' },
            {
              stream: "CANON",
              payload: '{"type":"item.completed","id":"canonical-event"}',
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
  it.effect("drops transient provider events before serialization", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, { batchWindowMs: 0 });
        const canonical = store.logger("canonical");
        const native = store.logger("native");
        const threadId = ThreadId.make("thread-filtered");
        const circularDelta: CircularLogFixture = { type: "content.delta" };
        circularDelta["self"] = circularDelta;

        yield* canonical.write(circularDelta, threadId);
        yield* canonical.write({ type: "item.completed", id: "final" }, threadId);
        yield* native.write({ type: "content.delta", id: "native-delta" }, threadId);
        yield* native.write(
          { method: "item/agentMessage/delta", payload: circularDelta },
          threadId,
        );
        yield* native.write(
          { method: "thread/realtime/outputAudio/delta", payload: circularDelta },
          threadId,
        );
        yield* native.write(
          { method: "thread/realtime/transcript/delta", payload: circularDelta },
          threadId,
        );
        yield* native.write(
          {
            event: {
              method: "claude/stream_event/content_block_delta/text_delta",
              payload: circularDelta,
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              method: "session/update",
              payload: { update: { sessionUpdate: "agent_message_chunk" } },
            },
          },
          threadId,
        );
        yield* native.write(
          {
            event: {
              type: "message.part.updated",
              payload: { properties: { part: { type: "text" } } },
            },
          },
          threadId,
        );
        yield* native.write({ type: "turn.completed", id: "native-final" }, threadId);
        yield* store.close();

        const lines = NodeFS.readFileSync(ownedLogPath(basePath, "thread-filtered"), "utf8")
          .trim()
          .split("\n")
          .map(parseLogLine);

        assert.deepEqual(
          lines.map(({ stream, payload }) => ({ stream, payload })),
          [
            { stream: "CANON", payload: '{"type":"item.completed","id":"final"}' },
            { stream: "NTIVE", payload: '{"type":"turn.completed","id":"native-final"}' },
          ],
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("contains hostile event accessors inside guarded serialization", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });

        assert.exists(logger);

        if (!logger) return;

        const hostile = new Proxy(
          { id: "hostile" },
          {
            get(_target, property) {
              if (property === "type") throw new Error("blocked");

              return undefined;
            },
          },
        );

        yield* logger.write(hostile, ThreadId.make("thread-hostile"));
        yield* logger.close();

        const contents = NodeFS.readFileSync(ownedLogPath(basePath, "thread-hostile"), "utf8");
        assert.notInclude(contents, "blocked");
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect(
    "reports rejected oversized records and asynchronous disk failures without failing provider work",
    () =>
      Effect.gen(function* () {
        const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-error-"));
        const basePath = NodePath.join(tempDir, "events.log");
        const messages: unknown[] = [];

        const capture = Logger.make<unknown, void>(({ message }) => {
          messages.push(message);
        });

        try {
          yield* Effect.gen(function* () {
            const store = yield* makeEventNdjsonLogStore(basePath, {
              maxBufferedBytes: 256,
              batchWindowMs: 0,
            });

            NodeFS.mkdirSync(ownedLogPath(basePath, "broken"));
            const logger = store.logger("native");
            yield* logger.write({ payload: "x".repeat(1024) }, ThreadId.make("oversized"));
            yield* logger.write({ id: "failed" }, ThreadId.make("broken"));
            yield* logger.write({ id: "retained" }, ThreadId.make("healthy"));
            yield* store.close();
          }).pipe(Effect.provide(Logger.layer([capture], { mergeWithExisting: false })));
          assert.isFalse(NodeFS.existsSync(ownedLogPath(basePath, "oversized")));
          assert.include(
            NodeFS.readFileSync(ownedLogPath(basePath, "healthy"), "utf8"),
            "retained",
          );
          assert.equal(messages.length, 2);
        } finally {
          NodeFS.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );
});

interface CircularLogFixture {
  secret?: string;
  type?: string;
  self?: object;
}
