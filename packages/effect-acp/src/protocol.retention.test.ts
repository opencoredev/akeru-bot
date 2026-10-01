import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpProtocol from "./protocol.ts";
import { encodeJsonl } from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import {
  ExtRequest,
  decodeExtResponse,
  encodeUnknownJsonString,
  encoder,
} from "./protocol.test-support.ts";

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  for (const bufferSize of [undefined, 0, 8] as const) {
    it.effect(
      `bounds callback-only raw retention with buffer size ${bufferSize ?? "default"}`,
      () =>
        Effect.gen(function* () {
          const { stdio, input, output } = yield* makeInMemoryStdio();
          const terminated = yield* Deferred.make<void>();
          const count = 10_000;
          const text = "x".repeat(1024);
          let handled = 0;
          const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
            stdio,
            serverRequestMethods: new Set(),
            ...(bufferSize === undefined ? {} : { rawNotificationBufferSize: bufferSize }),
            onNotification: () =>
              Effect.suspend(() => {
                handled++;
                return handled === 1
                  ? Effect.fail(AcpError.AcpRequestError.internalError("handler failed"))
                  : Effect.void;
              }),
            onExtRequest: () => Effect.succeed({ ok: true }),
            onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
          });

          for (let index = 0; index < count; index++) {
            yield* Queue.offer(
              input,
              encoder.encode(
                `${encodeUnknownJsonString({
                  jsonrpc: "2.0",
                  method: "x/stress",
                  params: { index, text },
                })}\n`,
              ),
            );
          }
          yield* Queue.offer(
            input,
            yield* encodeJsonl(ExtRequest, {
              jsonrpc: "2.0",
              id: 7,
              method: "x/test",
              params: { hello: "world" },
              headers: [],
            }),
          );
          assert.deepEqual(yield* decodeExtResponse(yield* Queue.take(output)), {
            jsonrpc: "2.0",
            id: 7,
            result: { ok: true },
          });
          yield* Queue.end(input);
          yield* Deferred.await(terminated);

          assert.equal(handled, count);
          const retained = yield* Stream.runCollect(transport.incoming);
          assert.deepEqual(
            retained.map((notification) => notification.params),
            Array.from({ length: bufferSize ?? 0 }, (_, offset) => ({
              index: count - (bufferSize ?? 0) + offset,
              text,
            })),
          );
          assert.deepEqual(yield* Stream.runCollect(transport.incoming), []);
        }),
    );
  }

  it.effect("preserves opt-in late replay after a reader is interrupted", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const observed = yield* Deferred.make<void>();
      const terminated = yield* Deferred.make<void>();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        rawNotificationBufferSize: "unbounded",
        onTermination: () => Deferred.succeed(terminated, undefined).pipe(Effect.asVoid),
      });
      const reader = yield* transport.incoming.pipe(
        Stream.runForEach(() =>
          Deferred.succeed(observed, undefined).pipe(Effect.andThen(Effect.never)),
        ),
        Effect.forkScoped,
      );
      yield* Queue.offer(input, encoder.encode('{"jsonrpc":"2.0","method":"x/first"}\n'));
      yield* Deferred.await(observed);
      yield* Fiber.interrupt(reader);

      yield* Queue.offer(
        input,
        encoder.encode(
          '{"jsonrpc":"2.0","method":"x/second"}\n{"jsonrpc":"2.0","method":"x/third"}\n',
        ),
      );
      yield* Queue.end(input);
      yield* Deferred.await(terminated);
      const replay = yield* Stream.runCollect(transport.incoming);
      assert.deepEqual(
        replay.map((notification) => notification.method),
        ["x/second", "x/third"],
      );
      assert.deepEqual(yield* Stream.runCollect(transport.incoming), []);
    }),
  );

  it.effect("drains raw observations and completes waiting readers on decode failure", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        rawNotificationBufferSize: 8,
      });
      const reader = yield* transport.incoming.pipe(Stream.runCollect, Effect.forkScoped);
      yield* Queue.offer(input, encoder.encode('{"jsonrpc":"2.0","method":"x/first"}\n'));
      yield* Queue.offer(input, encoder.encode("{malformed}\n"));
      assert.deepEqual(
        (yield* Fiber.join(reader)).map((notification) => notification.method),
        ["x/first"],
      );
    }),
  );

  it.effect("interrupts raw readers outside the connection scope when it closes", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        rawNotificationBufferSize: 8,
      }).pipe(Effect.provideService(Scope.Scope, scope));
      const reader = yield* transport.incoming.pipe(
        Stream.runCollect,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* Scope.close(scope, Exit.void);
      assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(reader)));
    }),
  );
});
