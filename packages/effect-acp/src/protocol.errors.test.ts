import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpProtocol from "./protocol.ts";
import {
  makeInMemoryStdio,
  terminationErrorFromHandle,
  makeChildStdio,
} from "./_internal/stdio.ts";
import { encodeUnknownJsonString, encoder, makeHandle } from "./protocol.test-support.ts";

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect("logs decode failures without copying the cause or wire payload", () =>
    Effect.gen(function* () {
      const secret = "acp-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logIncoming: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, encoder.encode(`{"secret":"${secret}"\n`));
      yield* Deferred.await(termination);

      const event = events.find(({ stage }) => stage === "decode_failed");
      assert.deepEqual(event, {
        direction: "incoming",
        stage: "decode_failed",
        payload: {
          operation: "decode-wire-message",
        },
      });
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("correlates extension response errors with the originating request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();

      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      const response = yield* transport
        .request("x/private", { hello: "world" })
        .pipe(Effect.forkScoped);

      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            id: 1,
            error: {
              _tag: "Cause",
              code: -32602,
              message: "Invalid params",
              data: [
                {
                  _tag: "Fail",
                  error: {
                    code: -32602,
                    message: "Invalid params",
                    data: { field: "hello" },
                  },
                },
              ],
            },
          })}\n`,
        ),
      );

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected extension request to fail"),
        }),
      );

      assert.instanceOf(error, AcpError.AcpRequestError);
      assert.deepInclude(error, {
        code: -32602,
        errorMessage: "Invalid params",
        method: "x/private",
        requestId: 1,
        operation: "receive-response",
      });
    }),
  );

  it.effect("does not emit a second process-exit error after a decode failure", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        ACP_MOCK_MALFORMED_OUTPUT: "1",
        ACP_MOCK_MALFORMED_OUTPUT_EXIT_CODE: "23",
      });

      const terminationCalls = yield* Ref.make(0);
      const firstMessage = yield* Deferred.make<unknown>();

      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio: makeChildStdio(handle),
        terminationError: terminationErrorFromHandle(handle),
        serverRequestMethods: new Set(),
        onTermination: () => Ref.update(terminationCalls, (count) => count + 1),
      });

      yield* transport.clientProtocol
        .run(0, (message) => Deferred.succeed(firstMessage, message).pipe(Effect.asVoid))
        .pipe(Effect.forkScoped);

      const message = yield* Deferred.await(firstMessage);
      assert.equal(yield* Ref.get(terminationCalls), 1);
      assert.equal((message as { readonly _tag?: string })._tag, "ClientProtocolError");

      const defect = (message as { readonly error: { readonly reason: unknown } }).error.reason as {
        readonly _tag: string;
        readonly message: string;
        readonly cause: unknown;
      };

      assert.equal(defect._tag, "RpcClientDefect");
      assert.equal(defect.message, "ACP protocol terminated.");
      assert.instanceOf(defect.cause, AcpError.AcpProtocolParseError);
    }),
  );
});
