// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import { it } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import { assert, describe, expect } from "vite-plus/test";

import {
  type DesktopTelemetryReceiverHealth,
  initialDesktopTelemetryContactAt,
  isDesktopTelemetryContactStale,
  openDesktopTelemetryReadable,
  recordDesktopTelemetrySampleHealth,
  requireDesktopTelemetryWriteProgress,
  resolveDesktopTelemetrySnapshotStaleAfterMs,
  writeAllToFileDescriptor,
} from "./DesktopTelemetryReceiver.ts";

describe("DesktopTelemetryReceiver", () => {
  it("reads and closes an owned regular-file descriptor", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-telemetry-file-"));
    const path = NodePath.join(directory, "telemetry.ndjson");
    const payload = '{"type":"desktopTelemetryHello","version":1}\n';
    NodeFS.writeFileSync(path, payload);
    const fd = NodeFS.openSync(path, "r");
    const readable = openDesktopTelemetryReadable(fd);
    try {
      expect(readable).toBeInstanceOf(NodeFS.ReadStream);
      const closed = new Promise<void>((resolve, reject) => {
        readable.once("close", resolve);
        readable.once("error", reject);
      });
      let received = "";
      readable.setEncoding("utf8");
      for await (const chunk of readable) received += chunk;
      await closed;
      expect(received).toBe(payload);
      expect(() => NodeFS.fstatSync(fd)).toThrow();
    } finally {
      readable.destroy();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  it.skipIf(Context.get(Context.empty(), HostProcessPlatform) === "win32")(
    "closes an inherited socket and exits with its writer still open without filesystem reads",
    async ({ onTestFinished }) => {
      const sourceUrl = new URL("./DesktopTelemetryReceiver.ts", import.meta.url).href;
      const child = NodeChildProcess.spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
            import assert from "node:assert/strict";
            import fs from "node:fs";
            import * as NodeNet from "node:net";
            import * as NodeEvents from "node:events";
            import { syncBuiltinESMExports } from "node:module";
            import { openDesktopTelemetryReadable } from ${JSON.stringify(sourceUrl)};

            assert.equal(fs.fstatSync(3).isSocket(), true);
            const originalRead = fs.read;
            fs.read = (fd, ...args) => {
              assert.notEqual(fd, 3, "telemetry must not queue a blocking filesystem read");
              return originalRead(fd, ...args);
            };
            syncBuiltinESMExports();
            const readable = openDesktopTelemetryReadable(3);
            if (!(readable instanceof NodeNet.Socket)) {
              process.send("filesystem-reader");
              readable.destroy();
              process.disconnect();
            } else {
              let received = "";
              readable.on("data", (chunk) => {
                received += chunk.toString();
                if (!received.endsWith("\\n")) return;
                assert.equal(received, "telemetry\\n");
                process.send("read");
              });
              process.once("message", async (message) => {
                assert.equal(message, "close");
                const closed = NodeEvents.once(readable, "close");
                readable.destroy();
                await closed;
                await fs.promises.stat(new URL(${JSON.stringify(sourceUrl)}));
                process.send("closed");
                process.disconnect();
              });
            }
          `,
        ],
        {
          env: { ...process.env, UV_THREADPOOL_SIZE: "1" },
          stdio: ["ignore", "ignore", "pipe", "pipe", "ipc"],
        },
      );
      const writer = child.stdio[3];
      assert.instanceOf(writer, NodeStream.Duplex);
      if (!(writer instanceof NodeStream.Duplex)) throw new Error("Missing telemetry writer");
      writer.allowHalfOpen = true;
      onTestFinished(() => {
        writer.destroy();
        if (child.exitCode === null && child.signalCode === null) child.kill();
      });
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      const exited = new Promise<readonly [number | null, NodeJS.Signals | null]>(
        (resolve, reject) => {
          child.once("exit", (code, signal) => resolve([code, signal]));
          child.once("error", reject);
        },
      );
      const nextMessage = () =>
        Promise.race([
          new Promise<unknown>((resolve) => child.once("message", resolve)),
          exited.then(([code, signal]) => {
            throw new Error(`Telemetry fixture exited early (${code}, ${signal}): ${stderr}`);
          }),
        ]);
      const read = nextMessage();
      writer.write("telemetry\n");
      expect(await read).toBe("read");
      expect(writer.writableEnded).toBe(false);
      const closed = nextMessage();
      child.send("close");
      expect(await closed).toBe("closed");
      expect(await exited).toEqual([0, null]);
      expect(writer.writableEnded).toBe(false);
    },
  );

  it("degrades a hello-only stream after the first-sample deadline", () => {
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 90_999)).toBe(false);
    expect(isDesktopTelemetryContactStale(Option.some(1_000), 91_000)).toBe(true);
    expect(isDesktopTelemetryContactStale(Option.none(), 1_000_000)).toBe(false);
  });

  it("starts the stale deadline as soon as a telemetry descriptor is opened", () => {
    expect(initialDesktopTelemetryContactAt(7, 1_000)).toEqual(Option.some(1_000));
    expect(initialDesktopTelemetryContactAt(undefined, 1_000)).toEqual(Option.none());
  });

  it("keeps the snapshot deadline beyond the configured idle polling interval", () => {
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(30_000, 120_000)).toBe(150_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(60_000, 600_000)).toBe(630_000);
    expect(resolveDesktopTelemetrySnapshotStaleAfterMs(1_000, 1_000)).toBe(90_000);
  });

  it.effect("publishes the latest sample timestamp while health remains healthy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const initialSample = DateTime.makeUnsafe(1_000);
        const nextSample = DateTime.makeUnsafe(2_000);
        const health = yield* Ref.make<DesktopTelemetryReceiverHealth>({
          status: "healthy",
          lastSampleAt: Option.some(initialSample),
          lastError: Option.none<string>(),
        });
        const healthChanges = yield* PubSub.sliding<DesktopTelemetryReceiverHealth>(4);
        const subscription = yield* PubSub.subscribe(healthChanges);

        yield* recordDesktopTelemetrySampleHealth(health, healthChanges, nextSample);
        const published = yield* PubSub.take(subscription).pipe(Effect.timeout("1 second"));

        expect(DateTime.toEpochMillis(Option.getOrThrow(published.lastSampleAt))).toBe(2_000);
      }),
    ),
  );

  it.effect("writes control messages through the asynchronous descriptor path", () =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const directory = NodeFS.mkdtempSync(
          NodePath.join(NodeOS.tmpdir(), "t3-desktop-telemetry-control-test-"),
        );
        const path = NodePath.join(directory, "control.ndjson");
        return {
          directory,
          path,
          fd: NodeFS.openSync(path, "w"),
        };
      }),
      ({ fd, path }) =>
        Effect.gen(function* () {
          const payload = Buffer.from('{"type":"setDiagnosticsDemand","enabled":true}\n');
          yield* writeAllToFileDescriptor(fd, payload);
          NodeFS.fsyncSync(fd);

          assert.equal(NodeFS.readFileSync(path, "utf8"), payload.toString("utf8"));
        }),
      ({ directory, fd }) =>
        Effect.sync(() => {
          NodeFS.closeSync(fd);
          NodeFS.rmSync(directory, { recursive: true, force: true });
        }),
    ),
  );

  it.effect("models a zero-byte control write as a stalled descriptor", () =>
    Effect.gen(function* () {
      const error = yield* requireDesktopTelemetryWriteProgress(7, 42, 0).pipe(Effect.flip);

      expect(error._tag).toBe("DesktopTelemetryControlStalled");
      expect(error.fd).toBe(7);
      expect(error.remainingBytes).toBe(42);
      expect(error.message).toBe(
        "Desktop telemetry control stalled on fd 7 with 42 bytes remaining.",
      );
      yield* requireDesktopTelemetryWriteProgress(7, 42, 1);
    }),
  );
});
