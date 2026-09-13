import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import * as CodexRpc from "./rpc.ts";
import * as CodexSchema from "./schema.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const encoder = new TextEncoder();

const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeAccountTokenUsageResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
);
const decodeAccountRateLimitsResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
);
const decodeConsumeRateLimitResetCreditParams = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
);
const decodeConsumeRateLimitResetCreditResponse = Schema.decodeUnknownEffect(
  CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
);

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

  it.effect("routes a large notification fragmented across thousands of input chunks", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const notifications: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: (notification) =>
          Effect.sync(() => {
            notifications.push(notification);
          }),
      });
      const response = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      const notification = {
        method: "turn/diff/updated",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          diff: "x".repeat(4 * 1024 * 1024),
        },
      };
      const bytes = encoder.encode(
        `${encodeUnknownJsonString(notification)}\n${encodeUnknownJsonString({ id: 1, result: { ok: true } })}\n`,
      );
      for (let offset = 0; offset < bytes.length; offset += 1024) {
        yield* Queue.offer(input, bytes.subarray(offset, offset + 1024));
      }

      assert.deepEqual(yield* Fiber.join(response), { ok: true });
      assert.deepEqual(notifications, [notification]);
    }),
  );

  it.effect.each([1, 7, 1024])(
    "preserves JSONL framing and UTF-8 across %i-byte input chunks",
    (chunkSize) =>
      Effect.gen(function* () {
        const { stdio, input } = yield* makeInMemoryStdio();
        const notifications: Array<CodexProtocol.CodexAppServerIncomingNotification> = [];
        const rawLines: Array<unknown> = [];
        const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
        yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          logIncoming: true,
          logger: (event) =>
            Effect.sync(() => {
              if (event.stage === "raw") {
                rawLines.push(event.payload);
              }
            }),
          onNotification: (notification) =>
            Effect.sync(() => {
              notifications.push(notification);
            }),
          onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
        });

        const firstLine = '{"method":"x/first",\r"params":{"text":"hé🙂"}}';
        const secondLine = '{"method":"x/second","params":{"value":2}}';
        const finalLine = '{"method":"x/final","params":{"text":"最後"}}\r';
        const bytes = encoder.encode(`\n \t\r\n${firstLine}\r\n\n${secondLine}\n${finalLine}`);
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          yield* Queue.offer(input, bytes.subarray(offset, offset + chunkSize));
        }
        yield* Queue.end(input);

        assert.instanceOf(
          yield* Deferred.await(termination),
          CodexError.CodexAppServerInputStreamEndedError,
        );
        assert.deepEqual(notifications, [
          { method: "x/first", params: { text: "hé🙂" } },
          { method: "x/second", params: { value: 2 } },
          { method: "x/final", params: { text: "最後" } },
        ]);
        assert.deepEqual(rawLines, [firstLine, secondLine, finalLine]);
      }),
  );

  it.effect("reports a malformed fragmented final line before input stream termination", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });
      const response = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(input, encoder.encode('{"id":1,'));
      yield* Queue.offer(input, encoder.encode('"result":'));
      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
      assert.equal(error.operation, "decode-wire-message");
      const responseError = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (failure) => failure,
          onSuccess: () => assert.fail("Expected the malformed response to fail the request"),
        }),
      );
      assert.strictEqual(responseError, error);
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

  it.effect("maps account usage responses to the upstream token usage schema", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
        CodexSchema.V2GetAccountTokenUsageResponse,
      );
      const decoded = yield* decodeAccountTokenUsageResponse({
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
      assert.deepEqual(decoded, {
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
    }),
  );

  it.effect("maps earned rate-limit reset credits from account rate-limit snapshots", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
        CodexSchema.V2GetAccountRateLimitsResponse,
      );

      const response = {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "RateLimitResetCredit_1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_781_654_400,
              expiresAt: 1_784_246_400,
              title: "Full reset",
              description: "Ready to redeem",
            },
            {
              id: "RateLimitResetCredit_2",
              resetType: "unknown",
              status: "unknown",
              grantedAt: 1_781_654_401,
              expiresAt: null,
            },
          ],
        },
      } as const;

      assert.deepEqual(yield* decodeAccountRateLimitsResponse(response), response);
      assert.deepEqual(
        yield* decodeAccountRateLimitsResponse({
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        }),
        {
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        },
      );
    }),
  );

  it.effect("maps the earned rate-limit reset consume request and response", () =>
    Effect.gen(function* () {
      assert.equal(
        CodexRpc.CLIENT_REQUEST_METHODS["account/rateLimitResetCredit/consume"],
        "account/rateLimitResetCredit/consume",
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_PARAMS["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditParams,
      );
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimitResetCredit/consume"],
        CodexSchema.V2ConsumeAccountRateLimitResetCreditResponse,
      );

      assert.deepEqual(
        yield* decodeConsumeRateLimitResetCreditParams({
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        }),
        {
          idempotencyKey: "8ae96ff3-3425-4f4c-8772-b6fd61502868",
          creditId: "RateLimitResetCredit_1",
        },
      );
      assert.deepEqual(yield* decodeConsumeRateLimitResetCreditResponse({ outcome: "reset" }), {
        outcome: "reset",
      });
    }),
  );

  it.effect(
    "encodes requests without a jsonrpc field and routes inbound requests and notifications",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
          stdio,
          rawNotificationBufferSize: "unbounded",
          rawRequestBufferSize: "unbounded",
        });

        const notificationDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingNotification>>();
        const requestDeferred =
          yield* Deferred.make<ReadonlyArray<CodexProtocol.CodexAppServerIncomingRequest>>();

        yield* transport.incomingNotifications.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((notifications) => Deferred.succeed(notificationDeferred, notifications)),
          Effect.forkScoped,
        );

        yield* transport.incomingRequests.pipe(
          Stream.take(1),
          Stream.runCollect,
          Effect.flatMap((requests) => Deferred.succeed(requestDeferred, requests)),
          Effect.forkScoped,
        );

        yield* transport.notify("initialized");
        assert.equal(yield* Queue.take(output), '{"method":"initialized"}\n');

        const initializeParams = {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        };

        const pendingInitialize = yield* transport
          .request("initialize", initializeParams)
          .pipe(Effect.forkScoped);
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 1,
          method: "initialize",
          params: initializeParams,
        });

        yield* Queue.offer(
          input,
          encodeJsonl({
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          }),
        );
        yield* Queue.offer(
          input,
          encodeJsonl({
            id: 1,
            result: {
              userAgent: "mock-codex-app-server",
              codexHome: "/tmp/codex-home",
              platformFamily: "unix",
              platformOs: "macos",
            },
          }),
        );

        assert.deepEqual(yield* Fiber.join(pendingInitialize), {
          userAgent: "mock-codex-app-server",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        });
        assert.deepEqual(yield* Deferred.await(notificationDeferred), [
          {
            method: "item/agentMessage/delta",
            params: {
              delta: "Hello from the mock peer.",
              itemId: "item-1",
              threadId: "thread-1",
              turnId: "turn-1",
            },
          },
        ]);
        assert.deepEqual(yield* Deferred.await(requestDeferred), [
          {
            id: 77,
            method: "item/tool/requestUserInput",
            params: {
              itemId: "item-approval-1",
              threadId: "thread-1",
              turnId: "turn-1",
              questions: [
                {
                  id: "approved",
                  header: "Approve",
                  question: "Continue?",
                },
              ],
            },
          },
        ]);

        yield* transport.respond(77, {
          answers: {
            approved: {
              answers: ["yes"],
            },
          },
        });
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 77,
          result: {
            answers: {
              approved: {
                answers: ["yes"],
              },
            },
          },
        });

        yield* transport.respondError(
          78,
          CodexError.CodexAppServerRequestError.methodNotFound("x/test"),
        );
        assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
          id: 78,
          error: {
            code: -32601,
            message: "Method not found: x/test",
          },
        });
      }),
  );

  it.effect("surfaces JSON encoding failures as protocol parse errors", () =>
    Effect.gen(function* () {
      const { stdio } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const bigintError = yield* transport.notify("x/test", 1n).pipe(Effect.flip);
      assert.instanceOf(bigintError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(bigintError.operation, "encode-wire-message");
      assert.equal(bigintError.method, "x/test");
      assert.exists(bigintError.cause);
      assert.equal(
        bigintError.message,
        "Codex App Server protocol operation 'encode-wire-message' failed for method 'x/test'.",
      );

      const circular: Record<string, unknown> = {};
      circular.self = circular;
      const circularError = yield* transport.notify("x/test", circular).pipe(Effect.flip);
      assert.instanceOf(circularError, CodexError.CodexAppServerProtocolParseError);
      assert.equal(circularError.operation, "encode-wire-message");
      assert.equal(circularError.method, "x/test");
      assert.exists(circularError.cause);

      const requestError = yield* transport.request("x/request", 1n).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected request encoding to fail"),
        }),
      );
      assert.instanceOf(requestError, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(requestError, {
        operation: "encode-wire-message",
        method: "x/request",
        requestId: "1",
      });
    }),
  );

  it.effect("correlates response errors with the originating request", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({ stdio });

      const response = yield* transport.request("thread/start", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);
      yield* Queue.offer(
        input,
        encodeJsonl({
          id: 1,
          error: {
            code: -32602,
            message: "Invalid params",
            data: { field: "cwd" },
          },
        }),
      );

      const error = yield* Fiber.join(response).pipe(
        Effect.match({
          onFailure: (error) => error,
          onSuccess: () => assert.fail("Expected Codex App Server request to fail"),
        }),
      );
      assert.instanceOf(error, CodexError.CodexAppServerRequestError);
      assert.deepInclude(error, {
        code: -32602,
        errorMessage: "Invalid params",
        method: "thread/start",
        requestId: "1",
        operation: "receive-response",
      });
    }),
  );

  it.effect("logs decode failures without copying the cause or wire payload", () =>
    Effect.gen(function* () {
      const secret = "codex-wire-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const events: Array<CodexProtocol.CodexAppServerProtocolLogEvent> = [];
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
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
      assert.exists(event);
      assert.equal(event.direction, "incoming");
      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.operation, "decode-wire-message");
      assert.isNumber(payload.issueCount);
      assert.isArray(payload.issueKinds);
      assert.isNumber(payload.maximumPathDepth);
      assert.equal("cause" in payload, false);
      assert.equal("detail" in payload, false);
      assert.notInclude(encodeUnknownJsonString(event), secret);
    }),
  );

  it.effect("describes unroutable messages with safe structural diagnostics", () =>
    Effect.gen(function* () {
      const secret = "codex-unroutable-secret-sentinel";
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(
        input,
        encodeJsonl({ id: true, method: "thread/start", params: { token: secret } }),
      );

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerProtocolParseError);
      assert.deepInclude(error, {
        operation: "route-wire-message",
        method: "thread/start",
        payloadKind: "object",
        presentFields: ["id", "method", "params"],
      });
      assert.isUndefined(error.requestId);
      assert.notProperty(error, "detail");
      assert.notProperty(error, "cause");
      assert.notInclude(error.message, secret);
    }),
  );

  it.effect("classifies an input stream ending without inventing a cause", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const termination = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onTermination: (error) => Deferred.succeed(termination, error).pipe(Effect.asVoid),
      });

      yield* Queue.end(input);

      const error = yield* Deferred.await(termination);
      assert.instanceOf(error, CodexError.CodexAppServerInputStreamEndedError);
      assert.equal(error.message, "Codex App Server input stream ended.");
      assert.equal("cause" in error, false);
    }),
  );
});
