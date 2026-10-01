import * as Path from "effect/Path";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, assert } from "@effect/vitest";
import * as AcpClient from "./client.ts";
import { encodeJsonl } from "./_internal/shared.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";
import {
  InitializeRequest,
  InitializeResponse,
  ExtRequest,
  ExtResponse,
  mockPeerPath,
  mockPeerArgs,
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

  it.effect(
    "returns structured invalid params without exposing values from typed extension request payloads",
    () =>
      Effect.gen(function* () {
        const handle = yield* makeHandle({ ACP_MOCK_BAD_TYPED_REQUEST: "1" });
        const scope = yield* Scope.make();
        const acpLayer = AcpClient.layerChildProcess(handle);
        const context = yield* Layer.buildWithScope(acpLayer, scope);

        const result = yield* Effect.gen(function* () {
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

          return yield* Effect.exit(
            acp.agent.prompt({
              sessionId: session.sessionId,
              prompt: [{ type: "text", text: "hello" }],
            }),
          );
        }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

        if (result._tag !== "Failure") {
          assert.fail("Expected prompt to fail for invalid typed extension payload");
        }
        const rendered = Cause.pretty(result.cause);
        assert.include(rendered, "Invalid payload for ACP extension method 'x/typed_request'.");
        assert.notInclude(rendered, "Expected string, got 123");
      }),
  );

  it.effect("uses distinct ids for RPC calls and extension requests", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const scope = yield* Scope.make();
      const acp = yield* AcpClient.make(stdio).pipe(Effect.provideService(Scope.Scope, scope));

      const initializeFiber = yield* acp.agent
        .initialize({
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: {
            name: "effect-acp-test",
            version: "0.0.0",
          },
        })
        .pipe(Effect.forkScoped);
      const extFiber = yield* acp.raw.request("x/test", { hello: "world" }).pipe(Effect.forkScoped);

      const firstOutbound = yield* Queue.take(output);
      const secondOutbound = yield* Queue.take(output);

      const decodedInitialize = Schema.decodeEffect(Schema.fromJsonString(InitializeRequest));
      const decodedExt = Schema.decodeEffect(Schema.fromJsonString(ExtRequest));
      const firstIsInitialize = yield* decodedInitialize(firstOutbound).pipe(
        Effect.match({
          onFailure: () => false,
          onSuccess: () => true,
        }),
      );

      const initializeRequest = firstIsInitialize
        ? yield* decodedInitialize(firstOutbound)
        : yield* decodedInitialize(secondOutbound);
      const extRequest = firstIsInitialize
        ? yield* decodedExt(secondOutbound)
        : yield* decodedExt(firstOutbound);

      assert.notEqual(initializeRequest.id, extRequest.id);

      yield* Queue.offer(
        input,
        yield* encodeJsonl(InitializeResponse, {
          jsonrpc: "2.0",
          id: initializeRequest.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {},
            agentInfo: {
              name: "mock-agent",
              version: "0.0.0",
            },
          },
        }),
      );
      yield* Queue.offer(
        input,
        yield* encodeJsonl(ExtResponse, {
          jsonrpc: "2.0",
          id: extRequest.id,
          result: { ok: true },
        }),
      );

      yield* Fiber.join(initializeFiber);
      assert.deepEqual(yield* Fiber.join(extFiber), { ok: true });
      yield* Scope.close(scope, Exit.void);
    }),
  );
});
