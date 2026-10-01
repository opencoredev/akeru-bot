// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { ThreadId } from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeEventNdjsonLogStore } from "./EventNdjsonLogger.ts";
import { ownedLogPath } from "./test-support/eventLogs.ts";

describe("EventNdjsonLogger", () => {
  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "provider-native.ndjson");

      try {
        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxBytes: 120,
          maxFiles: 2,
          batchWindowMs: 0,
        });

        const native = store.logger("native");
        const canonical = store.logger("canonical");

        for (let index = 0; index < 10; index += 1) {
          const logger = index % 2 === 0 ? native : canonical;
          yield* logger.write(
            {
              type: "session.started",
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.make("thread-rotate"),
          );
        }

        yield* store.close();

        const fileStem = NodePath.basename(ownedLogPath(basePath, "thread-rotate"));

        const matchingFiles = NodeFS.readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("enforces aggregate age and byte retention on startup", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const expiredPath = ownedLogPath(basePath, "expired");
      const oldPath = ownedLogPath(basePath, "old");
      const newPath = ownedLogPath(basePath, "new");
      const unrelatedLogPath = NodePath.join(tempDir, "unrelated.log");
      const legacyLogPath = NodePath.join(tempDir, "legacy-thread.log");
      const ignoredPath = NodePath.join(tempDir, "ignored.txt");

      try {
        yield* TestClock.setTime(1_800_000_000_000);
        const now = yield* Clock.currentTimeMillis;

        for (const filePath of [expiredPath, oldPath, newPath, unrelatedLogPath, ignoredPath]) {
          NodeFS.writeFileSync(filePath, "x".repeat(40));
        }

        NodeFS.writeFileSync(
          legacyLogPath,
          "[2026-01-01T00:00:00.000Z] CANON: legacy provider event\n",
        );
        NodeFS.utimesSync(expiredPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(legacyLogPath, (now - 20_000) / 1_000, (now - 20_000) / 1_000);
        NodeFS.utimesSync(oldPath, (now - 5_000) / 1_000, (now - 5_000) / 1_000);
        NodeFS.utimesSync(newPath, now / 1_000, now / 1_000);

        const store = yield* makeEventNdjsonLogStore(basePath, {
          maxAgeMs: 10_000,
          maxTotalBytes: 60,
        });

        yield* store.close();

        assert.equal(NodeFS.existsSync(expiredPath), false);
        assert.equal(NodeFS.existsSync(legacyLogPath), false);
        assert.equal(NodeFS.existsSync(oldPath), false);
        assert.equal(NodeFS.existsSync(newPath), true);
        assert.equal(NodeFS.existsSync(unrelatedLogPath), true);
        assert.equal(NodeFS.existsSync(ignoredPath), true);
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});

describe("EventNdjsonLogger", () => {
  it.effect("does not prune an active thread sink during an unrelated flush", () =>
    Effect.gen(function* () {
      const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-log-"));
      const basePath = NodePath.join(tempDir, "events.log");
      const activePath = ownedLogPath(basePath, "active");

      try {
        yield* TestClock.setTime(1_800_000_000_000);

        const store = yield* makeEventNdjsonLogStore(basePath, {
          batchWindowMs: 0,
          maxAgeMs: 1,
          retentionCheckIntervalMs: 1,
        });

        const logger = store.logger("native");

        yield* logger.write({ id: "active-before-retention" }, ThreadId.make("active"));
        assert.equal(NodeFS.existsSync(activePath), true);

        yield* TestClock.adjust("2 millis");
        yield* logger.write({ id: "retention-trigger" }, ThreadId.make("other"));

        assert.equal(NodeFS.existsSync(activePath), true);
        yield* store.close();
      } finally {
        NodeFS.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
});
