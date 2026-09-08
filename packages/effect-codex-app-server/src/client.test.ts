import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexClient from "./client.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

const mockPeerPath = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(import.meta.dirname, "../test/fixtures/codex-app-server-mock-peer.ts"),
);
const mockPeerArgs = (path: string) => [path];

it.layer(NodeServices.layer)("effect-codex-app-server client", (it) => {
  for (const [rawNotificationBufferSize, rawRequestBufferSize] of [
    [2, 0],
    [0, 2],
    ["unbounded", "unbounded"],
  ] as const) {
    it.effect(
      `opts into raw buffers independently (${rawNotificationBufferSize}, ${rawRequestBufferSize})`,
      () =>
        Effect.gen(function* () {
          const { stdio, input, output } = yield* makeInMemoryStdio();
          const client = yield* CodexClient.make(stdio, {
            rawNotificationBufferSize,
            rawRequestBufferSize,
          });
          let notifications = 0;
          let requests = 0;
          yield* client.handleUnknownServerNotification(() =>
            Effect.sync(() => {
              notifications++;
            }),
          );
          yield* client.handleUnknownServerRequest(() =>
            Effect.sync(() => {
              requests++;
              return { ok: true };
            }),
          );
          for (const index of [0, 1, 2]) {
            yield* Queue.offer(
              input,
              encoder.encode(`${encodeJson({ method: "x/notify", params: index })}\n`),
            );
            yield* Queue.offer(
              input,
              encoder.encode(`${encodeJson({ id: index, method: "x/request" })}\n`),
            );
            assert.deepEqual(yield* decodeJson(yield* Queue.take(output)), {
              id: index,
              result: { ok: true },
            });
          }
          const notificationCount =
            rawNotificationBufferSize === "unbounded" ? 3 : rawNotificationBufferSize;
          const requestCount = rawRequestBufferSize === "unbounded" ? 3 : rawRequestBufferSize;
          const rawNotifications = yield* client.raw.notifications.pipe(
            Stream.take(notificationCount),
            Stream.runCollect,
          );
          const rawRequests = yield* client.raw.requests.pipe(
            Stream.take(requestCount),
            Stream.runCollect,
          );
          assert.deepEqual(
            rawNotifications.map((notification) => notification.params),
            [0, 1, 2].slice(3 - notificationCount),
          );
          assert.deepEqual(
            rawRequests.map((request) => request.id),
            [0, 1, 2].slice(3 - requestCount),
          );
          assert.equal(notifications, 3);
          assert.equal(requests, 3);
        }),
    );
  }

  const makeHandle = (env?: Record<string, string>) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const peerCwd = path.join(import.meta.dirname, "..");
      const command = ChildProcess.make(process.execPath, mockPeerArgs(yield* mockPeerPath), {
        cwd: peerCwd,
        ...(env ? { env: { ...process.env, ...env } } : {}),
      });
      return yield* spawner.spawn(command);
    });

  it.effect("initializes, handles typed server requests, and reads account and skills data", () =>
    Effect.gen(function* () {
      const userInputRequests = yield* Ref.make<Array<unknown>>([]);
      const messageDeltas = yield* Ref.make<Array<unknown>>([]);
      const handle = yield* makeHandle();
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const result = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;

        yield* client.handleServerRequest("item/tool/requestUserInput", (payload) =>
          Ref.update(userInputRequests, (current) => [...current, payload]).pipe(
            Effect.as({
              answers: {
                approved: {
                  answers: ["yes"],
                },
              },
            }),
          ),
        );

        yield* client.handleServerNotification("item/agentMessage/delta", (payload) =>
          Ref.update(messageDeltas, (current) => [...current, payload]),
        );

        const initialized = yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
        assert.equal(initialized.userAgent, "mock-codex-app-server");

        yield* client.notify("initialized", undefined);

        const account = yield* client.request("account/read", {});
        assert.equal(account.requiresOpenaiAuth, false);
        assert.deepEqual(account.account, {
          type: "chatgpt",
          email: "mock@example.com",
          planType: "plus",
        });

        const path = yield* Path.Path;
        const peerCwd = path.join(import.meta.dirname, "..");
        const skills = yield* client.request("skills/list", { cwds: [peerCwd] });
        assert.equal(skills.data.length, 1);
        assert.equal(skills.data[0]?.cwd, peerCwd);
        assert.deepEqual(yield* Stream.runCollect(client.raw.notifications), []);
        assert.deepEqual(yield* Stream.runCollect(client.raw.requests), []);

        return {
          account,
          skills,
        };
      }).pipe(Effect.provide(context), Effect.ensuring(Scope.close(scope, Exit.void)));

      assert.equal(result.skills.data[0]?.skills.length, 0);
      assert.deepEqual(yield* Ref.get(userInputRequests), [
        {
          itemId: "item-approval-1",
          threadId: "thread-1",
          turnId: "turn-1",
          questions: [
            {
              id: "approved",
              header: "Approve",
              question: "Continue with the mock skills request?",
              options: [
                {
                  label: "yes",
                  description: "Approve the request",
                },
              ],
            },
          ],
        },
      ]);
      assert.deepEqual(yield* Ref.get(messageDeltas), [
        {
          delta: "Mock server is ready.",
          itemId: "item-1",
          threadId: "thread-1",
          turnId: "turn-1",
        },
      ]);
    }),
  );
  it.effect("drains child stderr so large diagnostics cannot block protocol responses", () =>
    Effect.gen(function* () {
      const handle = yield* makeHandle({
        CODEX_APP_SERVER_TEST_STDERR_BYTES: String(512 * 1024),
      });
      const scope = yield* Scope.make();
      const clientLayer = CodexClient.layerChildProcess(handle);
      const context = yield* Layer.buildWithScope(clientLayer, scope);

      const initialized = yield* Effect.gen(function* () {
        const client = yield* CodexClient.CodexAppServerClient;
        return yield* client.request("initialize", {
          clientInfo: {
            name: "effect-codex-app-server-test",
            title: "Effect Codex App Server Test",
            version: "0.0.0",
          },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: null,
          },
        });
      }).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(context),
        Effect.ensuring(Scope.close(scope, Exit.void)),
      );

      assert.equal(initialized.userAgent, "mock-codex-app-server");
    }),
  );
});
