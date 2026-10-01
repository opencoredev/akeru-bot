import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import * as AcpError from "./errors.ts";
import { encodeJsonl } from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import {
  PromptResponse,
  SessionUpdateNotification,
  decodePromptRequestLine,
  XAiPromptCompleteNotification,
  XAiQueueChangedNotification,
  XAiSessionsChangedNotification,
  mockPeerPath,
  mockPeerArgs,
  concatBytes,
} from "./client.test-support.ts";

it.layer(NodeServices.layer)("effect-acp client", (it) => {
  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;

      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: path.join(import.meta.dirname, ".."),
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });

      return yield* spawner.spawn(command);
    });

  it.effect("handles callback-only session traffic without retaining raw notifications", () =>
    Effect.gen(function* () {
      const { stdio, input } = yield* makeInMemoryStdio();
      const acp = yield* AcpClient.make(stdio);
      const handled = yield* Deferred.make<void>();
      const count = 10_000;
      let updates = 0;
      yield* acp.handleSessionUpdate(() =>
        Effect.suspend(() => {
          updates++;

          return updates === count
            ? Deferred.succeed(handled, undefined).pipe(Effect.asVoid)
            : Effect.void;
        }),
      );

      for (let index = 0; index < count; index++) {
        yield* Queue.offer(
          input,
          yield* encodeJsonl(SessionUpdateNotification, {
            jsonrpc: "2.0",
            method: "session/update",
            params: {
              sessionId: "stress-session",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: `${index}:${"x".repeat(1024)}` },
              },
            },
          }),
        );
      }

      yield* Deferred.await(handled);
      assert.equal(updates, count);
      assert.deepEqual(yield* Stream.runCollect(acp.raw.notifications), []);
    }),
  );

  it.effect("replays buffered notifications to handlers registered after they arrive", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<Array<unknown>>([]);
      const elicitationCompletions = yield* Ref.make<Array<unknown>>([]);
      const typedRequests = yield* Ref.make<Array<unknown>>([]);
      const typedNotifications = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission(() =>
          Effect.succeed({
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({
            action: {
              action: "accept",
              content: {
                approved: true,
              },
            },
          }),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          (payload) =>
            Ref.update(typedRequests, (current) => [...current, payload]).pipe(
              Effect.as({
                ok: true,
                echoedMessage: payload.message,
              }),
            ),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          (payload) => Ref.update(typedNotifications, (current) => [...current, payload]),
        );

        yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });

        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });

        yield* acp.handleSessionUpdate((notification) =>
          Ref.update(updates, (current) => [...current, notification]),
        );
        yield* acp.handleElicitationComplete((notification) =>
          Ref.update(elicitationCompletions, (current) => [...current, notification]),
        );

        assert.equal((yield* Ref.get(updates)).length, 1);
        assert.equal((yield* Ref.get(elicitationCompletions)).length, 1);
        assert.deepEqual(yield* Ref.get(typedRequests), [{ message: "hello from typed request" }]);
        assert.deepEqual(yield* Ref.get(typedNotifications), [{ count: 2 }]);
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

  it.effect("continues dispatching session updates after one handler fails", () =>
    Effect.gen(function* () {
      const successfulHandlers = yield* Ref.make(0);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const acpLayer = AcpClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(acpLayer, scope);

      yield* Effect.gen(function* () {
        const acp = yield* AcpClient.AcpClient;

        yield* acp.handleRequestPermission(() =>
          Effect.succeed({
            outcome: {
              outcome: "selected",
              optionId: "allow",
            },
          }),
        );
        yield* acp.handleElicitation(() =>
          Effect.succeed({
            action: {
              action: "accept",
              content: {
                approved: true,
              },
            },
          }),
        );
        yield* acp.handleExtRequest(
          "x/typed_request",
          Schema.Struct({ message: Schema.String }),
          () => Effect.succeed({ ok: true }),
        );
        yield* acp.handleExtNotification(
          "x/typed_notification",
          Schema.Struct({ count: Schema.Number }),
          () => Effect.void,
        );
        yield* acp.handleSessionUpdate(() =>
          Effect.fail(AcpError.AcpRequestError.internalError("session update handler failed")),
        );
        yield* acp.handleSessionUpdate(() => Ref.update(successfulHandlers, (count) => count + 1));

        yield* acp.agent.initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        });
        yield* acp.agent.authenticate({ methodId: "cursor_login" });

        const session = yield* acp.agent.createSession({
          cwd: process.cwd(),
          mcpServers: [],
        });

        yield* acp.agent.prompt({
          sessionId: session.sessionId,
          prompt: [{ type: "text", text: "hello" }],
        });

        assert.equal(yield* Ref.get(successfulHandlers), 1);
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));
    }),
  );

  it.effect(
    "routes a standard prompt response after Grok extension notifications in the same batch",
    () =>
      Effect.gen(function* () {
        const { stdio, input, output } = yield* makeInMemoryStdio();
        const scope = yield* Scope.make();
        const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

        const promptFiber = yield* acp.agent
          .prompt({
            sessionId: "grok-session-1",
            prompt: [{ type: "text", text: "run the ls command" }],
          })
          .pipe(Effect.forkScoped);

        const outbound = yield* Queue.take(output);
        const decodedPrompt = yield* decodePromptRequestLine(outbound);

        const responseBatch = concatBytes(
          yield* Effect.all([
            encodeJsonl(XAiQueueChangedNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/queue/changed",
              params: { sessionId: "grok-session-1", entries: [] },
            }),
            encodeJsonl(XAiPromptCompleteNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/session/prompt_complete",
              params: {
                sessionId: "grok-session-1",
                promptId: "prompt-1",
                stopReason: "end_turn",
                agentResult: null,
              },
            }),
            encodeJsonl(XAiSessionsChangedNotification, {
              jsonrpc: "2.0",
              method: "_x.ai/sessions/changed",
              params: {
                upserted: [
                  {
                    sessionId: "grok-session-1",
                    title: null,
                    cwd: process.cwd(),
                    isWorktree: false,
                    modelId: "grok-composer-2.5-fast",
                    yolo: false,
                    activity: "idle",
                    resident: true,
                    lastChangeUnixMs: 1_710_000_000_000,
                    origin: { kind: "local" },
                  },
                ],
                removed: [],
              },
            }),
            encodeJsonl(PromptResponse, {
              jsonrpc: "2.0",
              id: decodedPrompt.id,
              result: {
                stopReason: "end_turn",
                _meta: {
                  sessionId: "grok-session-1",
                  requestId: "prompt-1",
                  promptId: "prompt-1",
                  modelId: "grok-composer-2.5-fast",
                },
              },
            }),
          ]),
        );

        yield* Queue.offer(input, responseBatch);

        assert.deepEqual(yield* Fiber.join(promptFiber), {
          stopReason: "end_turn",
          _meta: {
            sessionId: "grok-session-1",
            requestId: "prompt-1",
            promptId: "prompt-1",
            modelId: "grok-composer-2.5-fast",
          },
        });
        yield* Scope.close(scope, Exit.void);
      }),
  );
});
