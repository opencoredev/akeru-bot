import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  CommandId,
  GroupId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@akeru/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionBots from "./persistence/Services/ProjectionBots.ts";

import {
  makeChannelTestBot,
  readyDefaultProvider,
  makeDefaultOrchestrationThreadShell,
  defaultThreadId,
  defaultModelSelection,
  defaultDesktopBootstrapToken,
} from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient, exchangeAccessToken } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("checks the responding group bot's engine before dispatch", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-group-claude");
      const groupId = GroupId.make("group-model-preflight");

      const bot = {
        ...makeChannelTestBot(),
        botId,
        engine: { provider: "claudeAgent", model: "claude-sonnet" },
        imageProvider: null,
        groupId,
      } satisfies ProjectionBots.ProjectionBot;

      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([
              readyDefaultProvider,
              {
                ...readyDefaultProvider,
                instanceId: ProviderInstanceId.make("claudeAgent"),
                driver: ProviderDriverKind.make("claudeAgent"),
                enabled: false,
              },
            ]),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ groupId, botId: null })),
              ),
          },
          projectionBots: { getById: () => Effect.succeed(Option.some(bot)) },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const error = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-group-model-preflight"),
            threadId: defaultThreadId,
            message: {
              messageId: MessageId.make("msg-group-model-preflight"),
              role: "user",
              text: "Ask Claude",
              attachments: [],
            },
            respondingBotId: botId,
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
          }).pipe(Effect.flip),
        ),
      );

      assert.equal(error._tag, "OrchestrationDispatchCommandError");

      if (Predicate.isTagged(error, "OrchestrationDispatchCommandError")) {
        assert.equal(error.unavailability, "temporary-failure");
      }

      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  describe("group turns addressed by an @bot token", () => {
    const groupId = GroupId.make("group-mention-preflight");
    const bossId = BotId.make("bot-group-boss");
    const memberId = BotId.make("bot-group-member");
    const unavailableEngine = { provider: "claudeAgent", model: "claude-sonnet" };

    const makeGroupBot = (botId: BotId, engine: typeof unavailableEngine | null) =>
      ({
        ...makeChannelTestBot(),
        botId,
        engine,
        imageProvider: null,
        groupId,
      }) satisfies ProjectionBots.ProjectionBot;

    const buildGroupApp = (unavailable: BotId) =>
      Effect.gen(function* () {
        const dispatch = vi.fn<
          OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]
        >(() => Effect.succeed({ sequence: 1 }));

        const bots = new Map(
          [bossId, memberId].map((botId) => [
            botId,
            makeGroupBot(botId, botId === unavailable ? unavailableEngine : null),
          ]),
        );

        yield* buildAppUnderTest({
          layers: {
            providerRegistry: {
              getProviders: Effect.succeed([
                readyDefaultProvider,
                {
                  ...readyDefaultProvider,
                  instanceId: ProviderInstanceId.make("claudeAgent"),
                  driver: ProviderDriverKind.make("claudeAgent"),
                  enabled: false,
                },
              ]),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(makeDefaultOrchestrationThreadShell({ groupId, botId: null })),
                ),
            },
            projectionBots: {
              getById: ({ botId }) => Effect.succeed(Option.fromNullishOr(bots.get(botId))),
            },
            projectionGroups: {
              getById: () =>
                Effect.succeed(
                  Option.some({
                    groupId,
                    name: "Team",
                    bossBotId: bossId,
                    members: [
                      { kind: "bot" as const, botId: bossId, role: "boss" as const },
                      { kind: "bot" as const, botId: memberId, role: "specialist" as const },
                    ],
                    createdAt: "2026-01-01T00:00:00.000Z",
                    updatedAt: "2026-01-01T00:00:00.000Z",
                  }),
                ),
            },
            orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
          },
        });

        return dispatch;
      });

    const mentionTurn = (commandId: string) => ({
      type: "thread.turn.start" as const,
      commandId: CommandId.make(commandId),
      threadId: defaultThreadId,
      message: {
        messageId: MessageId.make(`msg-${commandId}`),
        role: "user" as const,
        text: `@bot:${memberId} run the tests`,
        attachments: [],
      },
      modelSelection: defaultModelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    it.effect("dispatches to a healthy mentioned member when the boss is unavailable", () =>
      Effect.gen(function* () {
        const dispatch = yield* buildGroupApp(bossId);
        const wsUrl = yield* getWsServerUrl("/ws");
        yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](mentionTurn("cmd-mention-healthy")),
          ),
        );
        assert.equal(dispatch.mock.calls.length, 1);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("checks the mentioned member rather than a healthy boss", () =>
      Effect.gen(function* () {
        const dispatch = yield* buildGroupApp(memberId);
        const wsUrl = yield* getWsServerUrl("/ws");

        const error = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              mentionTurn("cmd-mention-unavailable"),
            ).pipe(Effect.flip),
          ),
        );

        assert.equal(error._tag, "OrchestrationDispatchCommandError");
        assert.equal(dispatch.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );

    it.effect("checks the mentioned member over HTTP", () =>
      Effect.gen(function* () {
        const dispatch = yield* buildGroupApp(memberId);

        const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
          scope: "orchestration:operate",
        });

        const response = yield* HttpClient.post("/api/orchestration/dispatch", {
          headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
          body: yield* HttpBody.json(mentionTurn("cmd-http-mention-unavailable")),
        });

        assert.equal(response.status, 400);
        assert.equal(dispatch.mock.calls.length, 0);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  });

  it.effect("replays an accepted turn retry after its provider becomes unavailable", () =>
    Effect.gen(function* () {
      const commandId = CommandId.make("cmd-accepted-retry");
      const threadId = ThreadId.make("thread-accepted-retry");

      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 7 }),
      );

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([
              {
                ...readyDefaultProvider,
                enabled: false,
                status: "disabled" as const,
                availability: "unavailable" as const,
              },
            ]),
          },
          commandReceipts: {
            getByCommandId: () =>
              Effect.succeed(
                Option.some({
                  commandId,
                  aggregateKind: "thread" as const,
                  aggregateId: threadId,
                  acceptedAt: "2026-01-01T00:00:00.000Z",
                  resultSequence: 7,
                  status: "accepted" as const,
                  error: null,
                }),
              ),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId,
            threadId,
            message: {
              messageId: MessageId.make("msg-accepted-retry"),
              role: "user",
              text: "Retry",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );

      assert.equal(result.sequence, 7);
      assert.equal(dispatch.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("retries a turn after a transient provider failure", () =>
    Effect.gen(function* () {
      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([
              {
                ...readyDefaultProvider,
                status: "error" as const,
                availability: "unavailable" as const,
                unavailability: "temporary-failure" as const,
                unavailabilityDetail: "temporary gateway failure",
              },
            ]),
          },
          orchestrationEngine: { dispatch, readEvents: () => Stream.empty },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "thread.turn.start",
            commandId: CommandId.make("cmd-retry-transient-provider"),
            threadId: ThreadId.make("thread-retry-transient-provider"),
            message: {
              messageId: MessageId.make("msg-retry-transient-provider"),
              role: "user",
              text: "Try again",
              attachments: [],
            },
            modelSelection: defaultModelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            createdAt: "2026-01-01T00:00:00.000Z",
          }),
        ),
      );

      assert.equal(result.sequence, 1);
      assert.equal(dispatch.mock.calls.length, 1);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
