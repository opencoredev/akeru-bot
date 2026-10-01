import { assert, describe, it } from "@effect/vitest";

import * as Deferred from "effect/Deferred";

import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as Fiber from "effect/Fiber";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as PlatformError from "effect/PlatformError";

import * as Queue from "effect/Queue";

import * as Ref from "effect/Ref";

import * as Stream from "effect/Stream";

import * as TestClock from "effect/testing/TestClock";

import { HttpClientRequest } from "effect/unstable/http";

import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";

import {
  isBackendProcessError,
  encodeDesktopTelemetryControl,
  baseConfig,
  configWithObservability,
  makeProcess,
  responseForRequest,
  httpClientLayer,
  healthyHttpClientLayer,
  decodeBootstrap,
  makeTestInstance,
} from "./test-support/BackendManagerHarness.ts";

describe("DesktopBackendManager", () => {
  it.effect("spawns the backend with fd3 bootstrap and fd4 telemetry", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let spawnedCommand: ChildProcess.Command | undefined;
        let bootstrapJson = "";
        let telemetryJson = "";
        let readyCount = 0;
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) =>
            Effect.gen(function* () {
              spawnedCommand = command;

              if (command._tag === "StandardCommand") {
                const fd3 = command.options.additionalFds?.fd3;

                if (fd3?.type === "input" && fd3.stream) {
                  bootstrapJson = yield* fd3.stream.pipe(Stream.decodeText(), Stream.mkString);
                }

                const fd4 = command.options.additionalFds?.fd4;

                if (fd4?.type === "input" && fd4.stream) {
                  telemetryJson = yield* fd4.stream.pipe(Stream.decodeText(), Stream.mkString);
                }
              }

              return makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          config: {
            ...baseConfig,
            bootstrap: configWithObservability,
          },
          spawnerLayer,
          desktopTelemetryStream: Stream.encodeText(
            Stream.make('{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n'),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.isDefined(spawnedCommand);

        if (spawnedCommand._tag !== "StandardCommand") {
          throw new Error("Expected backend to spawn a standard command.");
        }

        assert.equal(spawnedCommand.command, "/electron");
        assert.deepEqual(spawnedCommand.args, ["/server/bin.mjs", "--bootstrap-fd", "3"]);
        assert.equal(spawnedCommand.options.cwd, "/server");
        assert.equal(spawnedCommand.options.extendEnv, true);
        assert.equal(spawnedCommand.options.stdout, "pipe");
        assert.equal(spawnedCommand.options.stderr, "pipe");
        assert.equal(spawnedCommand.options.killSignal, "SIGTERM");
        assert.isDefined(spawnedCommand.options.forceKillAfter);
        assert.equal(spawnedCommand.options.additionalFds?.fd4?.type, "input");
        assert.equal(spawnedCommand.options.additionalFds?.fd5?.type, "output");
        assert.equal(
          Duration.toMillis(Duration.fromInputUnsafe(spawnedCommand.options.forceKillAfter)),
          2_000,
        );

        assert.deepEqual(yield* decodeBootstrap(bootstrapJson), configWithObservability);
        assert.equal(
          telemetryJson,
          '{"version":1,"type":"desktopTelemetryHello","electronPid":123}\n',
        );
      }),
    ),
  );

  it.effect("preserves the readiness timeout cause and process context", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<HttpClientRequest.HttpClientRequest>();

      const layer = Layer.merge(
        TestClock.layer(),
        httpClientLayer((request) =>
          Deferred.succeed(requested, request).pipe(Effect.andThen(Effect.never)),
        ),
      );

      yield* Effect.gen(function* () {
        const readiness = yield* DesktopBackendManager.waitForHttpReady({
          executablePath: baseConfig.executablePath,
          entryPath: baseConfig.entryPath,
          cwd: baseConfig.cwd,
          httpBaseUrl: baseConfig.httpBaseUrl,
          timeout: Duration.millis(50),
        }).pipe(Effect.flip, Effect.forkChild);

        const request = yield* Deferred.await(requested);
        assert.equal(request.url, "http://127.0.0.1:3773/.well-known/t3/environment");

        yield* TestClock.adjust(Duration.millis(50));
        const error = yield* Fiber.join(readiness);

        assert.instanceOf(error, DesktopBackendManager.BackendReadinessTimeoutError);
        assert.equal(error.executablePath, "/electron");
        assert.equal(error.entryPath, "/server/bin.mjs");
        assert.equal(error.cwd, "/server");
        assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
        assert.equal(error.readinessUrl.href, "http://127.0.0.1:3773/.well-known/t3/environment");
        assert.equal(error.timeoutMs, 50);
        assert.isDefined(error.cause);
        assert.equal(
          error.message,
          "Timed out after 50ms waiting for desktop backend readiness at http://127.0.0.1:3773/.well-known/t3/environment.",
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect("reports bootstrap encoding failures with stable process context", () =>
    Effect.gen(function* () {
      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
      );

      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        bootstrap: {
          ...baseConfig.bootstrap,
          port: 0,
        },
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessBootstrapEncodeError") {
        return assert.fail(`Expected bootstrap encode error, received ${error._tag}`);
      }

      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.isDefined(error.cause);
      assert.equal(
        error.message,
        "Failed to encode the desktop backend bootstrap payload for /server/bin.mjs.",
      );
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves spawn failures without deriving their message from the cause", () =>
    Effect.gen(function* () {
      const spawnCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcessSpawner",
        method: "spawn",
        pathOrDescriptor: baseConfig.executablePath,
        description: "low-level detail that must not become the public message",
      });

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() => Effect.fail(spawnCause)),
      );

      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessSpawnError") {
        return assert.fail(`Expected backend spawn error, received ${error._tag}`);
      }

      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, spawnCause);
      assert.equal(
        error.message,
        "Failed to spawn desktop backend entry /server/bin.mjs with /electron.",
      );
      assert.notInclude(error.message, spawnCause.message);
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("preserves exit-status failures without copying their detail into the message", () =>
    Effect.gen(function* () {
      const exitCause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "ChildProcess",
        method: "exitCode",
        description: "exit-status-secret-sentinel",
      });

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              exitCode: Effect.fail(exitCause),
            }),
          ),
        ),
      );

      const error = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
      }).pipe(
        Effect.flip,
        Effect.scoped,
        Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
      );

      if (error._tag !== "BackendProcessExitStatusError") {
        return assert.fail(`Expected backend exit-status error, received ${error._tag}`);
      }

      assert.equal(error.pid, 123);
      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.strictEqual(error.cause, exitCause);
      assert.equal(error.message, "Failed to read the exit status of desktop backend process 123.");
      assert.notInclude(error.message, "exit-status-secret-sentinel");
      assert.isTrue(isBackendProcessError(error));
    }),
  );

  it.effect("reports output stream failures with process and stream context", () =>
    Effect.gen(function* () {
      const outputCause = PlatformError.systemError({
        _tag: "BadResource",
        module: "ChildProcess",
        method: "stdout",
        description: "output-stream-secret-sentinel",
      });

      const reported = yield* Deferred.make<DesktopBackendManager.BackendProcessOutputError>();

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.fail(outputCause),
              exitCode: Deferred.await(reported).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onOutputFailure: (error) => Deferred.succeed(reported, error).pipe(Effect.asVoid),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)));

      const error = yield* Deferred.await(reported);

      assert.equal(exit.code.pipe(Option.getOrUndefined), 0);

      if (error._tag !== "BackendProcessOutputReadError") {
        return assert.fail(`Expected output read error, received ${error._tag}`);
      }

      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(error.pid, 123);
      assert.equal(error.streamName, "stdout");
      assert.strictEqual(error.cause, outputCause);
      assert.equal(error.message, "Failed to read stdout from desktop backend process 123.");
      assert.notInclude(error.message, "output-stream-secret-sentinel");
    }),
  );

  it.effect("reports output handler failures separately from stream read failures", () =>
    Effect.gen(function* () {
      const chunk = new TextEncoder().encode("backend output");
      const nextChunk = new TextEncoder().encode("still draining");
      const outputCause = new Error("output-handler-secret-sentinel");
      const reported = yield* Deferred.make<DesktopBackendManager.BackendProcessOutputError>();
      const drained = yield* Deferred.make<void>();
      let outputCount = 0;

      const spawnerLayer = Layer.succeed(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make(() =>
          Effect.succeed(
            makeProcess({
              stdout: Stream.make(chunk, nextChunk),
              exitCode: Deferred.await(drained).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
            }),
          ),
        ),
      );

      const exit = yield* DesktopBackendManager.runBackendProcess({
        ...baseConfig,
        desktopTelemetryStream: Stream.empty,
        onOutput: () => {
          outputCount += 1;

          return outputCount === 1
            ? Effect.fail(outputCause)
            : Deferred.succeed(drained, void 0).pipe(Effect.asVoid);
        },
        onOutputFailure: (error) => Deferred.succeed(reported, error).pipe(Effect.asVoid),
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)));

      const error = yield* Deferred.await(reported);

      assert.equal(exit.code.pipe(Option.getOrUndefined), 0);

      if (error._tag !== "BackendProcessOutputHandlingError") {
        return assert.fail(`Expected output handling error, received ${error._tag}`);
      }

      assert.equal(error.executablePath, "/electron");
      assert.equal(error.entryPath, "/server/bin.mjs");
      assert.equal(error.cwd, "/server");
      assert.equal(error.httpBaseUrl.href, "http://127.0.0.1:3773/");
      assert.equal(error.pid, 123);
      assert.equal(error.streamName, "stdout");
      assert.equal(error.chunkByteLength, chunk.byteLength);
      assert.strictEqual(error.cause, outputCause);
      assert.equal(
        error.message,
        `Failed to handle ${chunk.byteLength} bytes from stdout of desktop backend process 123.`,
      );
      assert.notInclude(error.message, "output-handler-secret-sentinel");
      assert.equal(outputCount, 2);
    }),
  );

  it.effect("reports child exit before waiting for trailing output to drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const exitObserved = yield* Deferred.make<void>();
        const finishOutputDrain = yield* Deferred.make<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.await(finishOutputDrain).pipe(
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );

        const runFiber = yield* DesktopBackendManager.runBackendProcess({
          ...baseConfig,
          desktopTelemetryStream: Stream.empty,
          onExitObserved: () => Deferred.succeed(exitObserved, void 0).pipe(Effect.asVoid),
        }).pipe(
          Effect.provide(Layer.merge(spawnerLayer, healthyHttpClientLayer)),
          Effect.forkChild,
        );

        yield* Deferred.await(exitObserved);
        assert.isUndefined(runFiber.pollUnsafe());

        yield* Deferred.succeed(finishOutputDrain, void 0);
        assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 1);
      }),
    ),
  );

  it.effect("continues routing desktop telemetry control messages after an invalid line", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const handled = yield* Deferred.make<boolean>();

        const controlMessage = encodeDesktopTelemetryControl({
          version: 1,
          type: "setDiagnosticsDemand",
          enabled: true,
        });

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                getOutputFd: (fd) =>
                  fd === 5
                    ? Stream.encodeText(Stream.make(`not-json\n${controlMessage}\n`))
                    : Stream.empty,
                exitCode: Deferred.await(handled).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              }),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          desktopTelemetryPublisher: {
            handleControl: (message) =>
              message.type === "setDiagnosticsDemand"
                ? Deferred.succeed(handled, message.enabled).pipe(Effect.asVoid)
                : Effect.void,
          },
        });

        yield* instance.start;
        assert.isTrue(yield* Deferred.await(handled));
      }),
    ),
  );

  it.effect("drains trailing child output before persisting an unexpected exit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const persistedOutput = yield* Deferred.make<ReadonlyArray<string>>();
        const outputDrainStarted = yield* Deferred.make<void>();
        const outputChunks = yield* Ref.make<Array<string>>([]);

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                stdout: Stream.fromEffect(
                  Deferred.succeed(outputDrainStarted, void 0).pipe(
                    Effect.andThen(Effect.sleep(Duration.seconds(1))),
                    Effect.as(new TextEncoder().encode("trailing output\n")),
                  ),
                ),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
              }),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          backendOutputLog: {
            writeOutputChunk: (_streamName, chunk) =>
              Ref.update(outputChunks, (current) => [...current, new TextDecoder().decode(chunk)]),
            persistFailure: () =>
              Ref.get(outputChunks).pipe(
                Effect.flatMap((chunks) => Deferred.succeed(persistedOutput, chunks)),
                Effect.asVoid,
              ),
          },
        });

        yield* instance.start;
        yield* Deferred.await(outputDrainStarted);
        yield* TestClock.adjust(Duration.seconds(1));

        assert.deepEqual(yield* Deferred.await(persistedOutput), ["trailing output\n"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("retries HTTP readiness before reporting the backend ready", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requestUrls: Array<string> = [];
        const statuses = [503, 200];
        let readyCount = 0;
        const firstRequest = yield* Deferred.make<void>();
        const ready = yield* Deferred.make<void>();
        const exited = yield* Queue.unbounded<void>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              makeProcess({
                exitCode: Deferred.await(ready).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              }),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer((request) =>
            Effect.gen(function* () {
              const status = statuses.shift();
              assert.isDefined(status);
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstRequest, void 0);

              return responseForRequest(request, status);
            }),
          ),
          onReady: Effect.sync(() => {
            readyCount += 1;
          }).pipe(Effect.andThen(Deferred.succeed(ready, void 0)), Effect.asVoid),
          backendOutputLog: {
            persistFailure: () => Queue.offer(exited, void 0).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;
        yield* Deferred.await(firstRequest);

        assert.equal(readyCount, 0);
        assert.deepEqual(requestUrls, ["http://127.0.0.1:3773/.well-known/t3/environment"]);

        yield* TestClock.adjust(Duration.millis(100));
        yield* Queue.take(exited);

        assert.equal(readyCount, 1);
        assert.deepEqual(requestUrls, [
          "http://127.0.0.1:3773/.well-known/t3/environment",
          "http://127.0.0.1:3773/.well-known/t3/environment",
        ]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect(
    "re-probes readiness after the first budget expires while the backend is still alive",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const requestUrls: Array<string> = [];
          let requestCount = 0;
          let readyCount = 0;
          let readinessTimeoutCount = 0;
          const firstProbe = yield* Deferred.make<void>();
          const childExit = yield* Deferred.make<void>();

          const spawnerLayer = Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.succeed(
                makeProcess({
                  exitCode: Deferred.await(childExit).pipe(
                    Effect.as(ChildProcessSpawner.ExitCode(0)),
                  ),
                }),
              ),
            ),
          );

          // The backend stays 503 through the first *two* readiness budgets
          // and only becomes healthy (200) for the third round, i.e. it comes
          // up well after the initial 50ms budget has expired.
          const httpLayer = httpClientLayer((request) =>
            Effect.gen(function* () {
              requestCount += 1;
              requestUrls.push(request.url);
              yield* Deferred.succeed(firstProbe, void 0);

              return responseForRequest(request, requestCount <= 2 ? 503 : 200);
            }),
          );

          const runFiber = yield* DesktopBackendManager.runBackendProcess({
            ...baseConfig,
            desktopTelemetryStream: Stream.empty,
            readinessTimeout: Duration.millis(50),
            onReady: () =>
              Effect.sync(() => {
                readyCount += 1;
              }),
            onReadinessFailure: () =>
              Effect.sync(() => {
                readinessTimeoutCount += 1;
              }),
          }).pipe(Effect.provide(Layer.merge(spawnerLayer, httpLayer)), Effect.forkChild);

          yield* Deferred.await(firstProbe);
          assert.equal(readyCount, 0);
          assert.equal(readinessTimeoutCount, 0);

          // The first 50ms readiness budget expires while the backend still
          // answers 503. The child is alive and may yet become healthy, so the
          // probe must start a fresh round instead of stopping permanently —
          // the pre-fix behavior left the app stuck on "Connecting to WSL…"
          // forever even though the backend kept running.
          yield* TestClock.adjust(Duration.millis(50));
          assert.equal(readinessTimeoutCount, 1);
          assert.equal(readyCount, 0);

          // The second budget also expires (backend still 503), then the third
          // round connects. The point is the probe persisted across budgets
          // while the process was alive instead of giving up after the first.
          yield* TestClock.adjust(Duration.millis(100));
          assert.equal(readinessTimeoutCount, 2);
          assert.equal(readyCount, 1);
          assert.equal(requestUrls.length, 3);

          yield* Deferred.succeed(childExit, void 0);
          assert.equal((yield* Fiber.join(runFiber)).code.pipe(Option.getOrUndefined), 0);
        }).pipe(Effect.provide(TestClock.layer())),
      ),
  );
});
