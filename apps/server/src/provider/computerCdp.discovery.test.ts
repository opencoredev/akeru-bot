import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { discoverComputerTargets } from "./computerCdp.ts";

describe("CDP discovery", () => {
  it.effect("forwards headers and consumes validated targets", () =>
    Effect.gen(function* () {
      let requestSignal: AbortSignal | undefined;

      const client = HttpClient.make((request, _url, signal) => {
        requestSignal = signal;
        assert.isFalse(signal.aborted);
        assert.strictEqual(request.url, "https://browser.example/json/list");
        assert.strictEqual(request.headers["x-daytona-preview-token"], "token");

        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json([{ type: "page", webSocketDebuggerUrl: "ws://browser/devtools/page/1" }]),
          ),
        );
      });

      const targets = yield* discoverComputerTargets("https://browser.example/json/list", {
        "x-daytona-preview-token": "token",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));

      assert.strictEqual(targets[0]?.webSocketDebuggerUrl, "ws://browser/devtools/page/1");
      assert.isTrue(requestSignal?.aborted);
    }),
  );

  it.effect("preserves the discovery error for non-success status", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
        ),
      );

      const error = yield* discoverComputerTargets("https://browser.example/json/list", {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      assert.strictEqual(error.message, "Graphical browser discovery failed.");
    }),
  );

  it.effect("interrupts discovery at the 30-second deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();

      const client = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)),
      );

      const fiber = yield* discoverComputerTargets("https://browser.example/json/list", {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(29_999);
      assert.isUndefined(fiber.pollUnsafe());
      yield* TestClock.adjust(1);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "TimeoutError");
    }),
  );

  it.effect("includes stalled body consumption in the discovery deadline", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let aborted = false;

      const client = HttpClient.make((request, _url, signal) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("["));
            signal.addEventListener(
              "abort",
              () => {
                aborted = true;
                controller.error(new Error("Request aborted"));
              },
              { once: true },
            );
          },
        });

        return Deferred.succeed(started, undefined).pipe(
          Effect.as(HttpClientResponse.fromWeb(request, new Response(body))),
        );
      });

      const fiber = yield* discoverComputerTargets("https://browser.example/json/list", {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );

      yield* Deferred.await(started);
      yield* TestClock.adjust(30_000);
      const error = yield* Fiber.join(fiber);
      assert.strictEqual(error._tag, "TimeoutError");
      assert.isTrue(aborted);
    }),
  );

  it.effect("rejects malformed target data", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json([{ type: 1 }]))),
      );

      const error = yield* discoverComputerTargets("https://browser.example/json/list", {}).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );

      assert.strictEqual(error._tag, "SchemaError");
    }),
  );
});
