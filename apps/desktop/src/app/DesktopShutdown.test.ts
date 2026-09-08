import { afterEach, expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Tracer from "effect/Tracer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { makeLocalFileTracer, makeTraceSink } from "@t3tools/shared/observability";
import { DesktopTraceShutdown } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";

const writer = vi.hoisted(() => ({ append: vi.fn<(data: string) => Promise<void>>() }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    appendFile: (_path: unknown, data: Uint8Array) => writer.append(Buffer.from(data).toString()),
  };
});
afterEach(() => vi.clearAllMocks());

for (const fail of [false, true]) {
  it.effect(
    `waits for real trace writer acknowledgement before fake native exit (failure=${fail})`,
    () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const events: string[] = [];
      const records: string[] = [];
      writer.append.mockImplementation(async (data) => {
        records.push(data);
        entered.resolve();
        await release.promise;
        events.push(fail ? "write-error" : "write-complete");
        if (fail) throw new Error("blocked writer failed");
      });
      return Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped();
          const sink = yield* makeTraceSink({
            filePath: `${directory}/desktop.trace.ndjson`,
            maxBytes: 100_000,
            maxFiles: 1,
            batchWindowMs: 60_000,
          });
          const tracer = yield* makeLocalFileTracer({
            filePath: sink.filePath,
            maxBytes: 100_000,
            maxFiles: 1,
            batchWindowMs: 60_000,
            sink,
          });
          const shutdown = yield* DesktopShutdown.DesktopShutdown;
          const exit = yield* shutdown.awaitComplete.pipe(
            Effect.andThen(
              Effect.sync(() => {
                events.push("native-exit");
              }),
            ),
            Effect.forkChild,
          );
          const program = yield* Effect.void.pipe(
            Effect.withSpan("desktop.app"),
            Effect.provideService(Tracer.Tracer, tracer),
            Effect.ensuring(
              DesktopShutdown.acknowledgeShutdown.pipe(
                Effect.provideService(DesktopTraceShutdown, { close: sink.close() }),
              ),
            ),
            Effect.forkChild,
          );
          yield* Effect.promise(() => entered.promise);
          expect(yield* shutdown.isComplete).toBe(false);
          expect(events).toEqual([]);
          release.resolve();
          yield* Fiber.join(program);
          yield* Fiber.join(exit);
          expect(yield* shutdown.isComplete).toBe(true);
          expect(records.join("")).toContain('"name":"desktop.app"');
          expect(events).toEqual(
            fail
              ? ["write-error", "error-reported", "native-exit"]
              : ["write-complete", "native-exit"],
          );
        }),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopShutdown.layer,
            NodeServices.layer,
            Logger.layer([
              Logger.make(({ message }) => {
                if (String(message).includes("could not be persisted"))
                  events.push("error-reported");
              }),
            ]),
          ),
        ),
      );
    },
  );
}
