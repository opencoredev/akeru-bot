import * as AcpError from "./errors.ts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as AcpProtocol from "./protocol.ts";
import { encodeJsonl } from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import {
  SessionUpdateNotification,
  ElicitationCompleteNotification,
  decodeSessionCancelNotification,
  encodeUnknownJsonString,
  encoder,
} from "./protocol.test-support.ts";

it.layer(NodeServices.layer)("effect-acp protocol", (it) => {
  it.effect(
    "emits exact JSON-RPC notifications and decodes inbound session/update and elicitation completion",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
          stdio,
          serverRequestMethods: new Set(),
          rawNotificationBufferSize: "unbounded",
        });

        const notifications =
          yield* Deferred.make<ReadonlyArray<AcpProtocol.AcpIncomingNotification>>();
        yield* transport.incoming.pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.flatMap((notificationChunk) => Deferred.succeed(notifications, notificationChunk)),
          Effect.forkScoped,
        );

        yield* transport.notify("session/cancel", { sessionId: "session-1" });
        const outbound = yield* Queue.take(output);
        assert.deepEqual(yield* decodeSessionCancelNotification(outbound), {
          jsonrpc: "2.0",
          method: "session/cancel",
          params: {
            sessionId: "session-1",
          },
        });

        yield* Queue.offer(
          input,
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "session-1",
              update: {
                sessionUpdate: "plan",
                entries: [
                  {
                    content: "Inspect repository",
                    priority: "high",
                    status: "in_progress",
                  },
                ],
              },
            },
          }),
        );

        yield* Queue.offer(
          input,
          yield* encodeJsonl(ElicitationCompleteNotification, {
            jsonrpc: "2.0",
            method: "session/elicitation/complete",
            params: {
              elicitationId: "elicitation-1",
            },
          }),
        );

        const [update, completion] = yield* Deferred.await(notifications);
        assert.equal(update?._tag, "SessionUpdate");
        assert.equal(completion?._tag, "ElicitationComplete");
      }),
  );

  it.effect("keeps invalid core notification values only in the schema cause", () =>
    Effect.gen(function* () {
      const secret = "acp-core-notification-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<AcpError.AcpError>();
      yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encoder.encode(
          `${encodeUnknownJsonString({
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: { secret },
              update: {
                sessionUpdate: "plan",
                entries: [],
              },
            },
          })}\n`,
        ),
      );

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, AcpError.AcpProtocolParseError);
      const parseError = error as AcpError.AcpProtocolParseError;
      const { cause, ...directDiagnostics } = parseError;
      assert.equal(parseError.operation, "decode-notification-payload");
      assert.equal(parseError.method, "session/update");
      assert.isAbove(parseError.issueCount ?? 0, 0);
      assert.include(parseError.issueKinds ?? [], "Pointer");
      assert.isAbove(parseError.maximumPathDepth ?? 0, 0);
      assert.isTrue(Schema.isSchemaError(cause));
      assert.notInclude(parseError.message, secret);
      assert.notInclude(encodeUnknownJsonString(directDiagnostics), secret);
    }),
  );

  it.effect("logs outgoing notifications when logOutgoing is enabled", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const events: Array<AcpProtocol.AcpProtocolLogEvent> = [];
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
        logOutgoing: true,
        logger: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      });

      yield* transport.notify("session/cancel", { sessionId: "session-1" });

      // A notification must not carry `id` or `headers`. Grok CLI drops frames that do.
      assert.deepEqual(events, [
        {
          direction: "outgoing",
          stage: "decoded",
          payload: {
            _tag: "Notification",
            tag: "session/cancel",
            payload: {
              sessionId: "session-1",
            },
          },
        },
        {
          direction: "outgoing",
          stage: "raw",
          payload:
            '{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"session-1"}}\n',
        },
      ]);
    }),
  );

  it.effect("fails notification encoding through the declared ACP error channel", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* AcpProtocol.makeAcpPatchedProtocol({
        stdio,
        serverRequestMethods: new Set(),
      });

      // Notifications encode through Schema, so the cause is the schema failure rather
      // than the raw TypeError JSON.stringify throws. The ACP error shape is what callers see.
      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, AcpError.AcpProtocolParseError);
      assert.equal(bigintError.operation, "encode-message");
      assert.equal(bigintError.method, "x/test");
      assert.isDefined(bigintError.cause);
      assert.equal(
        bigintError.message,
        "ACP protocol operation 'encode-message' failed for method 'x/test'.",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, AcpError.AcpProtocolParseError);
      assert.equal(circularError.operation, "encode-message");
      assert.equal(circularError.method, "x/test");
      assert.isDefined(circularError.cause);

      const requestError = yield* transport.request("x/request", 1n).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request encoding to fail"),
        }),
      );
      assert.instanceOf(requestError, AcpError.AcpProtocolParseError);
      assert.deepInclude(requestError, {
        operation: "encode-message",
        method: "x/request",
        requestId: 1,
      });
    }),
  );
});
