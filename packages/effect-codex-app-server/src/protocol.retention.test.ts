import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import { encoder, encodeJsonl, decodeJson } from "./protocol.test-support.ts";

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  for (const bufferSize of [undefined, 0, 8] as const) {
    it.effect(
      `bounds callback-only raw retention with buffer size ${bufferSize ?? "default"}`,
      () =>
        Effect.gen(function* () {
          const { stdio, input, output } = yield* makeInMemoryStdio();
          const terminated = yield* Deferred.make<void>();
          const count = 10_000;
          const text = "x".repeat(1024);
          let notificationCount = 0;
          let requestCount = 0;

          const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
            stdio,
            ...(bufferSize === undefined
              ? {}
              : {
                  rawNotificationBufferSize: bufferSize,
                  rawRequestBufferSize: bufferSize,
                }),
            onNotification: () =>
              Effect.sync(() => {
                notificationCount++;
              }),
            onRequest: (request) =>
              Effect.suspend(() => {
                requestCount++;

                return request.id === 0
                  ? Effect.fail(
                      CodexError.CodexAppServerRequestError.methodNotFound(request.method),
                    )
                  : Effect.succeed({ ok: true });
              }),
            onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
          });

          for (let index = 0; index < count; index++) {
            yield* Queue.offer(input, encodeJsonl({ method: "x/stress", params: { index, text } }));
            yield* Queue.offer(
              input,
              encodeJsonl({ id: index, method: "x/request", params: { text } }),
            );
          }

          for (let index = 0; index < count; index++) {
            assert.deepEqual(
              yield* decodeJson(yield* Queue.take(output)),
              index === 0
                ? {
                    id: 0,
                    error: { code: -32601, message: "Method not found: x/request" },
                  }
                : { id: index, result: { ok: true } },
            );
          }

          yield* Queue.end(input);
          yield* Deferred.await(terminated);

          assert.equal(notificationCount, count);
          assert.equal(requestCount, count);
          const notifications = yield* Stream.runCollect(transport.incomingNotifications);
          const requests = yield* Stream.runCollect(transport.incomingRequests);

          const retainedIndexes = Array.from(
            { length: bufferSize ?? 0 },
            (_, offset) => count - (bufferSize ?? 0) + offset,
          );

          assert.deepEqual(
            notifications.map((notification) => notification.params),
            retainedIndexes.map((index) => ({ index, text })),
          );
          assert.deepEqual(
            requests.map((request) => request.id),
            retainedIndexes,
          );
          assert.deepEqual(yield* Queue.clear(output), []);
          assert.deepEqual(yield* Stream.runCollect(transport.incomingNotifications), []);
          assert.deepEqual(yield* Stream.runCollect(transport.incomingRequests), []);
        }),
    );
  }

  it.effect("preserves opt-in late replay after raw readers are interrupted", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const notificationObserved = yield* Deferred.make<void>();
      const requestObserved = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();

      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        rawNotificationBufferSize: "unbounded",
        rawRequestBufferSize: "unbounded",
        onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
      });

      const notificationReader = yield* transport.incomingNotifications.pipe(
        Stream.runForEach(() =>
          Deferred.succeed(notificationObserved, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkScoped,
      );

      const requestReader = yield* transport.incomingRequests.pipe(
        Stream.runForEach(() =>
          Deferred.succeed(requestObserved, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkScoped,
      );

      yield* Queue.offer(input, encodeJsonl({ method: "x/first" }));
      yield* Queue.offer(input, encodeJsonl({ id: 1, method: "x/first" }));
      yield* Deferred.await(notificationObserved);
      yield* Deferred.await(requestObserved);
      yield* Fiber.interrupt(notificationReader);
      yield* Fiber.interrupt(requestReader);

      for (const id of [2, 3]) {
        yield* Queue.offer(input, encodeJsonl({ method: "x/next", params: id }));
        yield* Queue.offer(input, encodeJsonl({ id, method: "x/next" }));
      }

      yield* Queue.end(input);
      yield* Deferred.await(terminated);
      assert.deepEqual(
        (yield* Stream.runCollect(transport.incomingNotifications)).map(
          (notification) => notification.params,
        ),
        [2, 3],
      );
      assert.deepEqual(
        (yield* Stream.runCollect(transport.incomingRequests)).map((request) => request.id),
        [2, 3],
      );
      assert.deepEqual(yield* Stream.runCollect(transport.incomingNotifications), []);
      assert.deepEqual(yield* Stream.runCollect(transport.incomingRequests), []);
    }),
  );

  it.effect("drains raw observations and completes waiting readers on decode failure", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();

      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        rawNotificationBufferSize: 8,
        rawRequestBufferSize: 8,
      });

      const notifications = yield* transport.incomingNotifications.pipe(
        Stream.runCollect,
        Effect.forkScoped,
      );

      const requests = yield* transport.incomingRequests.pipe(Stream.runCollect, Effect.forkScoped);
      yield* Queue.offer(input, encodeJsonl({ method: "x/first" }));
      yield* Queue.offer(input, encodeJsonl({ id: 1, method: "x/first" }));
      yield* Queue.offer(input, encoder.encode("{malformed}\n"));
      assert.deepEqual(yield* Fiber.join(notifications), [{ method: "x/first" }]);
      assert.deepEqual(yield* Fiber.join(requests), [{ id: 1, method: "x/first" }]);
    }),
  );

  it.effect("interrupts raw readers outside the connection scope when it closes", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();

      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        rawNotificationBufferSize: 8,
        rawRequestBufferSize: 8,
      }).pipe(Effect.provideService(Scope.Scope, scope));

      const notifications = yield* transport.incomingNotifications.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );

      const requests = yield* transport.incomingRequests.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );

      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(notifications)));
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(requests)));
    }),
  );
});
