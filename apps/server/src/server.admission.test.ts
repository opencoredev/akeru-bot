// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { BotId, CommandId, DEFAULT_SERVER_SETTINGS, MessageId, ORCHESTRATION_WS_METHODS, ProviderDriverKind, ThreadId } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as ServerConfig from "./config.ts";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionBots from "./persistence/Services/ProjectionBots.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { readyDefaultProvider, defaultProjectId, defaultModelSelection, defaultDesktopBootstrapToken, makeChannelTestBot } from "./serverTestFixtures.ts";
import { getWsServerUrl, withWsRpcClient, exchangeAccessToken } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {

  it.effect("checks a new chat's bootstrap model before creating its thread", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );
      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([{ ...readyDefaultProvider, enabled: false }]),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-unavailable-provider"),
            threadId: ThreadId.make("thread-bootstrap-unavailable-provider"),
            message: {
              messageId: MessageId.make("msg-bootstrap-unavailable-provider"),
              role: "user",
              text: "Start chat",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "New chat",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          }).pipe(Effect.flip),
        ),
      );
      assert.equal(error._tag, "OrchestrationDispatchCommandError");
      if (error._tag === "OrchestrationDispatchCommandError") {
        assert.equal(error.unavailability, "temporary-failure");
      }
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );


  it.effect("rejects an unavailable bootstrap model through HTTP before dispatch", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );
      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([{ ...readyDefaultProvider, enabled: false }]),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:operate",
      });
      const response = yield* HttpClient.post("/api/orchestration/dispatch", {
        headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
        body: yield* HttpBody.json({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-http-bootstrap-unavailable-provider"),
          threadId: ThreadId.make("thread-http-bootstrap-unavailable-provider"),
          message: {
            messageId: MessageId.make("msg-http-bootstrap-unavailable-provider"),
            role: "user",
            text: "Start chat",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: defaultProjectId,
              title: "New chat",
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      });

      assert.equal(response.status, 400);
      const error = (yield* response.json) as Record<string, unknown>;
      assert.equal(error.reason, "invalid_command");
      assert.equal(error.detail, "codex is turned off in Settings > Providers.");
      assert.equal(error.unavailability, "temporary-failure");
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );


  it.effect(
    "lets an HTTP turn use an instance's own credential when the shared login is revoked",
    () =>
      Effect.gen(function* () {
        const dispatch = vi.fn<
          OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]
        >(() => Effect.succeed({ sequence: 1 }));
        // The subscription service reads its files once at startup.
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-http-credential-",
        });
        const { secretsDir } = yield* ServerConfig.deriveServerPaths(baseDir, undefined);
        const authPath = path.join(secretsDir, "subscription-auth.json");
        yield* fileSystem.makeDirectory(secretsDir, { recursive: true });
        yield* fileSystem.writeFileString(
          authPath,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({ "openai-codex": { type: "api-key", access: "sk-shared" } }),
        );
        yield* fileSystem.writeFileString(
          `${authPath}.health`,
          // @effect-diagnostics-next-line preferSchemaOverJson:off
          JSON.stringify({
            "openai-codex": {
              lastFailedRequest: { at: "2026-01-01T00:00:00.000Z", message: "Unauthorized" },
              failureKind: "revoked",
            },
          }),
        );
        yield* buildAppUnderTest({
          config: { baseDir },
          layers: {
            providerRegistry: { getProviders: Effect.succeed([readyDefaultProvider]) },
            serverSettings: {
              getSettings: Effect.succeed({
                ...DEFAULT_SERVER_SETTINGS,
                providerInstances: {
                  [defaultModelSelection.instanceId]: {
                    driver: ProviderDriverKind.make("codex"),
                    environment: [
                      { name: "OPENAI_API_KEY", value: "sk-instance", sensitive: true },
                    ],
                  },
                },
              }),
            },
            orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
          },
        });

        const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:operate",
        });
        const response = yield* HttpClient.post("/api/orchestration/dispatch", {
          headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
          body: yield* HttpBody.json({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-http-instance-credential"),
            threadId: ThreadId.make("thread-http-instance-credential"),
            message: {
              messageId: MessageId.make("msg-http-instance-credential"),
              role: "user",
              text: "Start chat",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                title: "New chat",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        });

        assert.equal(response.status, 200);
        assert.equal(dispatch.mock.calls.length, 1);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );


  it.effect("dispatches an accepted HTTP turn retry after provider availability changes", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("cmd-http-accepted-retry");
      const threadId = ThreadId.make("thread-http-accepted-retry");
      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 7 }),
      );
      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([{ ...readyDefaultProvider, enabled: false }]),
          },
          commandReceipts: {
            getByCommandId: () =>
              Effect.succeed(
                Option.some({
                  commandId,
                  aggregateKind: "thread",
                  aggregateId: threadId,
                  acceptedAt: "2026-01-01T00:00:00.000Z",
                  resultSequence: 7,
                  status: "accepted",
                  error: null,
                }),
              ),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:operate",
      });
      const response = yield* HttpClient.post("/api/orchestration/dispatch", {
        headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
        body: yield* HttpBody.json({
          type: "thread.turn.start",
          commandId,
          threadId,
          message: {
            messageId: MessageId.make("msg-http-accepted-retry"),
            role: "user",
            text: "Start chat",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: defaultProjectId,
              title: "New chat",
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      });

      assert.equal(response.status, 200);
      assert.equal(dispatch.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );


  it.effect("rejects a capped bot chat through HTTP before dispatch", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-http-bootstrap-capped");
      const bot = {
        ...makeChannelTestBot(),
        botId,
        imageProvider: null,
        usageCap: { unit: "tokens" as const, limit: 100 },
      } satisfies ProjectionBots.ProjectionBot;
      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );
      yield* buildAppUnderTest({
        layers: {
          providerRegistry: { getProviders: Effect.succeed([readyDefaultProvider]) },
          projectionBots: {
            getById: ({ botId: requested }) =>
              Effect.succeed(requested === botId ? Option.some(bot) : Option.none()),
          },
          botUsageLedger: {
            summarize: () =>
              Effect.succeed({
                botId,
                consumedTokens: 100,
                reservedTokens: 0,
                measurements: {
                  input: { tokens: 100, unavailableEntries: 0 },
                  output: { tokens: 0, unavailableEntries: 0 },
                  observer: { tokens: 0, unavailableEntries: 0 },
                  reflector: { tokens: 0, unavailableEntries: 0 },
                },
                entries: [],
              }),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:operate",
      });
      const response = yield* HttpClient.post("/api/orchestration/dispatch", {
        headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
        body: yield* HttpBody.json({
          type: "thread.turn.start",
          commandId: CommandId.make("cmd-http-bootstrap-capped"),
          threadId: ThreadId.make("thread-http-bootstrap-capped"),
          respondingBotId: BotId.make("bot-http-unrelated-responder"),
          message: {
            messageId: MessageId.make("msg-http-bootstrap-capped"),
            role: "user",
            text: "Start chat",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          bootstrap: {
            createThread: {
              projectId: defaultProjectId,
              botId,
              title: "Capped bot chat",
              modelSelection: defaultModelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: "main",
              worktreePath: null,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
          },
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
      });

      assert.equal(response.status, 400);
      const error = (yield* response.json) as Record<string, unknown>;
      assert.equal(error.unavailability, "usage-cap");
      assert.equal(error.repairAction, "usage");
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );


  it.effect("checks a new bot chat's usage cap before creating its thread", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-bootstrap-capped");
      const bot = {
        ...makeChannelTestBot(),
        botId,
        imageProvider: null,
        usageCap: { unit: "tokens" as const, limit: 100 },
      } satisfies ProjectionBots.ProjectionBot;
      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );
      yield* buildAppUnderTest({
        layers: {
          providerRegistry: { getProviders: Effect.succeed([readyDefaultProvider]) },
          projectionBots: {
            getById: ({ botId: requested }) =>
              Effect.succeed(requested === botId ? Option.some(bot) : Option.none()),
          },
          botUsageLedger: {
            summarize: () =>
              Effect.succeed({
                botId,
                consumedTokens: 100,
                reservedTokens: 0,
                measurements: {
                  input: { tokens: 100, unavailableEntries: 0 },
                  output: { tokens: 0, unavailableEntries: 0 },
                  observer: { tokens: 0, unavailableEntries: 0 },
                  reflector: { tokens: 0, unavailableEntries: 0 },
                },
                entries: [],
              }),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");
      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-bootstrap-capped-bot"),
            threadId: ThreadId.make("thread-bootstrap-capped-bot"),
            respondingBotId: BotId.make("bot-unrelated-responder"),
            message: {
              messageId: MessageId.make("msg-bootstrap-capped-bot"),
              role: "user",
              text: "Start chat",
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            bootstrap: {
              createThread: {
                projectId: defaultProjectId,
                botId,
                title: "Capped bot chat",
                modelSelection: defaultModelSelection,
                runtimeMode: "full-access",
                interactionMode: "default",
                branch: "main",
                worktreePath: null,
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            },
            createdAt: "2026-01-01T00:00:00.000Z",
          }).pipe(Effect.flip),
        ),
      );
      assert.equal(error._tag, "OrchestrationDispatchCommandError");
      if (error._tag === "OrchestrationDispatchCommandError") {
        assert.equal(error.unavailability, "usage-cap");
      }
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );});
