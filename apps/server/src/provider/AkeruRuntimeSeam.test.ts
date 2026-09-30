import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Scope from "effect/Scope";

import { makeAkeruRuntimeSeam } from "./AkeruRuntimeSeam.ts";

interface LoggedLine {
  readonly level: string;
  readonly message: ReadonlyArray<unknown>;
}

const captureLogs = () => {
  const lines: LoggedLine[] = [];
  const logged = Promise.withResolvers<void>();
  const logger = Logger.make(({ logLevel, message }) => {
    lines.push({ level: logLevel, message: Array.isArray(message) ? message : [message] });
    logged.resolve();
  });
  return {
    lines,
    logged: logged.promise,
    layer: Logger.layer([logger], { mergeWithExisting: false }),
  };
};

describe("AkeruRuntimeSeam", () => {
  it.effect("logs a failed background effect with its annotations", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const seam = yield* makeAkeruRuntimeSeam;
      seam.fork("Background work failed.", Effect.fail("boom"), { threadId: "thread-1" });
      yield* Effect.promise(() => logs.logged);

      assert.strictEqual(logs.lines.length, 1);
      const [line] = logs.lines;
      assert.strictEqual(line!.level, "Warn");
      assert.strictEqual(line!.message[0], "Background work failed.");
      assert.include(line!.message[1] as object, { threadId: "thread-1" });
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });

  it.effect("hands a rejected background promise to onFailure and logs it", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const seam = yield* makeAkeruRuntimeSeam;
      const failures: unknown[] = [];
      const rejection = new Error("library rejected");
      seam.forkPromise("Library work failed.", () => Promise.reject(rejection), {
        annotations: { turnId: "turn-1" },
        onFailure: (cause) => {
          failures.push(cause);
        },
      });
      yield* Effect.promise(() => logs.logged);

      assert.deepStrictEqual(failures, [rejection]);
      assert.strictEqual(logs.lines[0]!.message[0], "Library work failed.");
      assert.include(logs.lines[0]!.message[1] as object, { turnId: "turn-1" });
    }).pipe(Effect.scoped, Effect.provide(logs.layer));
  });

  it.effect("rejects runPromise callers with the effect's failure", () =>
    Effect.gen(function* () {
      const seam = yield* makeAkeruRuntimeSeam;
      const error = yield* Effect.promise(() =>
        seam.runPromise(Effect.fail("denied")).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      assert.strictEqual(error, "denied");
      assert.strictEqual(yield* Effect.promise(() => seam.runPromise(Effect.succeed(7))), 7);
    }).pipe(Effect.scoped),
  );

  it.effect("interrupts in-flight forked work when its scope closes, without logging", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const scope = yield* Scope.make();
      const seam = yield* makeAkeruRuntimeSeam.pipe(Scope.provide(scope));
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      seam.fork(
        "Long-running work failed.",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );
      yield* Deferred.await(started);

      yield* Scope.close(scope, Exit.void);

      assert.isTrue(yield* Deferred.isDone(interrupted));
      assert.deepStrictEqual(logs.lines, []);
    }).pipe(Effect.provide(logs.layer));
  });
});
