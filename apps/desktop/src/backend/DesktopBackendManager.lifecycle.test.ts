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

import * as Scope from "effect/Scope";

import * as TestClock from "effect/testing/TestClock";

import { ChildProcessSpawner } from "effect/unstable/process";

import {
  baseConfig,
  makeProcess,
  httpClientLayer,
  makeTestInstance,
} from "./test-support/BackendManagerHarness.ts";

describe("DesktopBackendManager", () => {
  it.effect("starts the configured backend and closes the scoped process on stop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let startCount = 0;
        let closedCount = 0;
        const closed = yield* Deferred.make<void>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();
        const ready = yield* Deferred.make<void>();
        const backendReadyFlag = yield* Ref.make(false);
        let shutdownCount = 0;
        let persistedFailureCount = 0;
        let discardedSessionCount = 0;
        let removedTelemetrySources = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              startCount += 1;
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(teardownStarted, undefined).pipe(
                Effect.andThen(Deferred.await(finishTeardown)),
                Effect.andThen(
                  Effect.sync(() => {
                    closedCount += 1;
                  }),
                ),
                Effect.andThen(Deferred.succeed(closed, void 0)),
                Effect.asVoid,
              );

              yield* Scope.addFinalizer(scope, close);

              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          onReady: Ref.set(backendReadyFlag, true).pipe(
            Effect.andThen(Deferred.succeed(ready, void 0)),
            Effect.asVoid,
          ),
          onShutdown: Ref.set(backendReadyFlag, false).pipe(
            Effect.andThen(
              Effect.sync(() => {
                shutdownCount += 1;
              }),
            ),
          ),
          backendOutputLog: {
            persistFailure: () =>
              Effect.sync(() => {
                persistedFailureCount += 1;
              }),
            discardSession: Effect.sync(() => {
              discardedSessionCount += 1;
            }),
          },
          desktopTelemetryPublisher: {
            removeControlSource: () =>
              Effect.sync(() => {
                removedTelemetrySources += 1;
              }),
          },
        });
        assert.isTrue(Option.isNone(yield* instance.currentConfig));

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        yield* Deferred.await(ready);
        assert.isTrue(yield* Ref.get(backendReadyFlag));
        assert.deepEqual(yield* instance.currentConfig, Option.some(baseConfig));

        const runningSnapshot = yield* instance.snapshot;
        assert.equal(runningSnapshot.ready, true);
        assert.deepEqual(runningSnapshot.activePid, Option.some(123));

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        assert.equal(startCount, 1);
        assert.equal(closedCount, 1);
        assert.equal(persistedFailureCount, 0);
        assert.equal(discardedSessionCount, 1);
        assert.equal(removedTelemetrySources, 1);

        const stoppedSnapshot = yield* instance.snapshot;
        assert.isFalse(yield* Ref.get(backendReadyFlag));
        assert.equal(shutdownCount, 1);
        assert.equal(stoppedSnapshot.desiredRunning, false);
        assert.equal(stoppedSnapshot.ready, false);
        assert.equal(Option.isNone(stoppedSnapshot.activePid), true);
      }),
    ),
  );

  it.effect("restarts when start is requested during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        assert.equal((yield* instance.snapshot).desiredRunning, true);

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        const restarted = yield* instance.snapshot;
        assert.equal(restarted.desiredRunning, true);
        assert.deepEqual(restarted.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("retries config resolution after a start request during stop teardown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        const configAttempts = yield* Ref.make(0);
        let startCount = 0;

        const configFailure = PlatformError.systemError({
          _tag: "Unknown",
          module: "DesktopBackendManager",
          method: "configResolve",
          description: "transient configuration failure",
        });
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );
        const configResolve = Ref.updateAndGet(configAttempts, (attempt) => attempt + 1).pipe(
          Effect.flatMap((attempt) =>
            attempt === 2 ? Effect.fail(configFailure) : Effect.succeed(baseConfig),
          ),
        );
        const instance = yield* makeTestInstance({
          spawnerLayer,
          configResolve,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance.stop().pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        yield* Deferred.succeed(finishTeardown, undefined);
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));

        const pendingRestart = yield* instance.snapshot;
        assert.equal(pendingRestart.desiredRunning, true);
        assert.equal(pendingRestart.restartScheduled, true);

        yield* TestClock.adjust(Duration.seconds(2));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
        assert.equal(yield* Ref.get(configAttempts), 3);
        assert.equal((yield* instance.snapshot).desiredRunning, true);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps a timed-out run active until its process exits", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const teardownStarted = yield* Deferred.make<void>();
        const finishTeardown = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              const scope = yield* Scope.Scope;
              const closed = yield* Deferred.make<void>();
              startCount += 1;
              yield* Queue.offer(starts, startCount);
              if (startCount === 1) {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(teardownStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(finishTeardown)),
                    Effect.andThen(Deferred.succeed(closed, undefined)),
                    Effect.asVoid,
                  ),
                );
              } else {
                yield* Scope.addFinalizer(
                  scope,
                  Deferred.succeed(closed, undefined).pipe(Effect.asVoid),
                );
              }
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        const stopFiber = yield* instance
          .stop({ timeout: Duration.millis(100) })
          .pipe(Effect.forkChild);
        yield* Deferred.await(teardownStarted).pipe(Effect.timeout("1 second"));
        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(100));
        yield* Fiber.join(stopFiber).pipe(Effect.timeout("1 second"));

        assert.equal(startCount, 1);
        const timedOut = yield* instance.snapshot;
        assert.equal(timedOut.desiredRunning, true);
        assert.deepEqual(timedOut.activePid, Option.some(123));

        yield* Deferred.succeed(finishTeardown, undefined);
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.take(starts).pipe(Effect.timeout("1 second")), 2);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown before the first start has prior state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;
        const closed = yield* Deferred.make<void>();
        const startedPids = yield* Queue.unbounded<number>();

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              yield* Queue.offer(startedPids, 123);
              const close = Deferred.succeed(closed, void 0).pipe(Effect.asVoid);
              return makeProcess({
                exitCode: Deferred.await(closed).pipe(Effect.as(ChildProcessSpawner.ExitCode(0))),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(startedPids), 123);
        assert.equal(shutdownCount, 0);
      }),
    ),
  );

  it.effect("restarts an unexpectedly exited backend with the Effect clock", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const failures = yield* Queue.unbounded<string>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
          backendOutputLog: {
            persistFailure: ({ details }) => Queue.offer(failures, details).pipe(Effect.asVoid),
          },
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);
        assert.equal(yield* Queue.take(failures), "pid=123 code=1");

        yield* TestClock.adjust(Duration.millis(499));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 2);

        yield* TestClock.adjust(Duration.millis(999));
        assert.equal(yield* Queue.size(starts), 0);
        yield* TestClock.adjust(Duration.millis(1));
        assert.equal(yield* Queue.take(starts), 3);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not notify shutdown when a scheduled restart starts from non-ready state", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let shutdownCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "preflight failed", fatal: false }),
          },
          onShutdown: Effect.sync(() => {
            shutdownCount += 1;
          }),
        });

        yield* instance.start;
        assert.equal(shutdownCount, 0);

        yield* TestClock.adjust(Duration.millis(500));
        assert.equal(shutdownCount, 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a fatal preflight failure once and stops looping after the cap", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "Node.js not found", fatal: true }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        assert.deepEqual(failures, []);

        // Five fatal attempts with exponential backoff (500ms, 1s, 2s, 4s) reach
        // the cap, at which point the failure is surfaced exactly once.
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        assert.deepEqual(failures, ["Node.js not found"]);

        // Past the cap the loop stops and nothing else is surfaced.
        yield* TestClock.adjust(Duration.seconds(8));
        yield* TestClock.adjust(Duration.seconds(30));
        assert.deepEqual(failures, ["Node.js not found"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("can be started again after a fatal preflight cap once config recovers", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failing = yield* Ref.make(true);
        const starts = yield* Queue.unbounded<number>();
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Queue.offer(starts, 123).pipe(
              Effect.as(
                makeProcess({
                  exitCode: Effect.never,
                }),
              ),
            ),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          configResolve: Ref.get(failing).pipe(
            Effect.map((isFailing) =>
              isFailing
                ? {
                    ...baseConfig,
                    preflightFailure: Option.some({
                      reason: "Node.js not found",
                      fatal: true,
                    }),
                  }
                : baseConfig,
            ),
          ),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        yield* TestClock.adjust(Duration.seconds(1));
        yield* TestClock.adjust(Duration.seconds(2));
        yield* TestClock.adjust(Duration.seconds(4));
        yield* TestClock.adjust(Duration.seconds(8));

        const parked = yield* instance.snapshot;
        assert.equal(parked.desiredRunning, false);
        assert.equal(parked.ready, false);
        assert.isTrue(Option.isNone(parked.activePid));
        assert.equal(parked.restartScheduled, false);
        assert.equal(yield* Queue.size(starts), 0);

        yield* Ref.set(failing, false);
        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 123);
        const running = yield* instance.snapshot;
        assert.equal(running.desiredRunning, true);
        assert.deepEqual(running.activePid, Option.some(123));
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("keeps retrying a transient (non-fatal) preflight failure without surfacing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({ reason: "wslpath conversion failed", fatal: false }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        // Well beyond the fatal cap's worth of time: a transient failure must
        // keep retrying (self-heal) and never surface.
        yield* TestClock.adjust(Duration.minutes(2));
        assert.deepEqual(failures, []);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("surfaces a bounded transient preflight failure after its retry limit", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const failures: string[] = [];
        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("unexpected backend spawn")),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          config: {
            ...baseConfig,
            preflightFailure: Option.some({
              reason: "WSL toolchain probe timed out",
              fatal: false,
              retryLimit: 3,
            }),
          },
          onPreflightFailed: (failure) =>
            Effect.sync(() => {
              failures.push(failure.reason);
            }).pipe(Effect.as(false)),
        });

        yield* instance.start;
        yield* TestClock.adjust(Duration.millis(500));
        assert.deepEqual(failures, []);

        yield* TestClock.adjust(Duration.seconds(1));
        assert.deepEqual(failures, ["WSL toolchain probe timed out"]);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("cancels a scheduled restart when start is requested manually", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        const secondClosed = yield* Deferred.make<void>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.gen(function* () {
              startCount += 1;
              yield* Queue.offer(starts, startCount);

              if (startCount === 1) {
                return makeProcess({
                  exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
                });
              }

              const scope = yield* Scope.Scope;
              const close = Deferred.succeed(secondClosed, void 0).pipe(Effect.asVoid);
              yield* Scope.addFinalizer(scope, close);
              return makeProcess({
                exitCode: Deferred.await(secondClosed).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(0)),
                ),
                kill: () => close,
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;

        assert.equal(yield* Queue.take(starts), 1);
        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 2);

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );

  it.effect("does not restart after stop cancels a scheduled restart", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const starts = yield* Queue.unbounded<number>();
        let startCount = 0;

        const spawnerLayer = Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.sync(() => {
              startCount += 1;
              return makeProcess({
                exitCode: Queue.offer(starts, startCount).pipe(
                  Effect.as(ChildProcessSpawner.ExitCode(1)),
                ),
              });
            }),
          ),
        );

        const instance = yield* makeTestInstance({
          spawnerLayer,
          httpClientLayer: httpClientLayer(() => Effect.never),
        });

        yield* instance.start;
        assert.equal(yield* Queue.take(starts), 1);

        let restartScheduled = false;
        while (!restartScheduled) {
          restartScheduled = (yield* instance.snapshot).restartScheduled;
          if (!restartScheduled) {
            yield* Effect.yieldNow;
          }
        }

        yield* instance.stop();
        yield* TestClock.adjust(Duration.millis(500));

        assert.equal(yield* Queue.size(starts), 0);
        assert.equal((yield* instance.snapshot).desiredRunning, false);
      }).pipe(Effect.provide(TestClock.layer())),
    ),
  );
});
