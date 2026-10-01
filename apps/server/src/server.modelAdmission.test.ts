import * as Schema from "effect/Schema";
// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
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
import { assert, it } from "@effect/vitest";
import { assertTrue } from "@effect/vitest/utils";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpBody, HttpClient } from "effect/unstable/http";
import { vi } from "vite-plus/test";
import * as OrchestrationEngine from "./orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionBots from "./persistence/Services/ProjectionBots.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient, exchangeAccessToken } from "./serverTestClients.ts";
import {
  defaultDesktopBootstrapToken,
  makeDefaultOrchestrationThreadShell,
} from "./serverTestFixtures.ts";

it.describe("ws bot engine model routing preflight", () => {
  const now = "2026-01-01T00:00:00.000Z";

  const seedSubscriptionAuth = (secretsDir: string) => {
    // The auth service reads this file lazily; writing it before the app boots
    // marks every subscription provider as connected so preflight reaches the
    // model check instead of short-circuiting on a missing login.
    NodeFS.mkdirSync(secretsDir, { recursive: true });
    const credential = { type: "api-key", access: "test-key" };

    const data = Object.fromEntries(
      ["openai-codex", "anthropic", "xai", "kimi-for-coding", "opencode-go"].map((provider) => [
        provider,
        credential,
      ]),
    );

    NodeFS.writeFileSync(NodePath.join(secretsDir, "subscription-auth.json"), JSON.stringify(data));
  };

  const readyProvider = (
    models: ReadonlyArray<string>,
    instanceId = ProviderInstanceId.make("codex"),
    status: "ready" | "warning" | "error" = "ready",
  ) =>
    ({
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      displayName: "Codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status,
      auth: { status: "authenticated" },
      checkedAt: now,
      models: models.map((slug) => ({
        slug,
        name: slug,
        isCustom: false,
        capabilities: null,
      })),
      slashCommands: [],
      skills: [],
    }) as const;

  const bot = (
    botId: BotId,
    engine: { readonly provider: string; readonly model: string } | null,
  ) =>
    ({
      botId,
      name: "Preflight bot",
      title: "Preflight bot",
      label: null,
      description: null,
      disabledMcpServerIds: [],
      avatar: { kind: "dither" as const, seed: "preflight-bot" },
      engine,
      sandbox: "local" as const,
      runtimeMode: "full-access" as const,
      usageCap: null,
      imageProvider: null,
      voiceEnabled: false,
      groupId: null,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    }) satisfies ProjectionBots.ProjectionBot;

  let turnCommandCounter = 0;

  const turnStartCommand = (threadId: ThreadId, overrides: Schema.JsonObject = {}) => ({
    type: "thread.turn.start" as const,
    commandId: CommandId.make(`cmd-turn-${++turnCommandCounter}`),
    threadId,
    message: {
      messageId: MessageId.make(`msg-turn-${turnCommandCounter}`),
      role: "user" as const,
      text: "hello",
      attachments: [],
    },
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    createdAt: now,
    ...overrides,
  });

  it.effect("rejects bot.create when the model is not in the provider snapshot", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-ws-preflight-"));
      seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));
      yield* buildAppUnderTest({
        config: { baseDir },
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([readyProvider(["gpt-5.6-sol"])]),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "bot.create",
            commandId: CommandId.make("cmd-bot-create-bad-model"),
            botId: BotId.make("bot-bad-model"),
            name: "Bad model bot",
            title: "Bad model bot",
            avatar: { kind: "dither", seed: "bad-model" },
            engine: { provider: "codex", model: "not-a-model" },
            sandbox: "local",
            usageCap: null,
            groupId: null,
            createdAt: now,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Failure"));

      if (Predicate.isTagged(result, "Failure")) {
        assert.equal(result.failure._tag, "OrchestrationDispatchCommandError");
        assert.include(result.failure.message, "not-a-model");
        assert.equal(
          (result.failure as { readonly unavailability?: string }).unavailability,
          "unsupported-model",
        );
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect("rejects an HTTP bot.create when the model is not in the provider snapshot", () =>
    Effect.gen(function* () {
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-http-preflight-"));
      seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));

      const dispatch = vi.fn<OrchestrationEngine.OrchestrationEngineService["Service"]["dispatch"]>(
        () => Effect.succeed({ sequence: 1 }),
      );

      yield* buildAppUnderTest({
        config: { baseDir },
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([readyProvider(["gpt-5.6-sol"])]),
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
          type: "bot.create",
          commandId: CommandId.make("cmd-http-bot-create-bad-model"),
          botId: BotId.make("bot-http-bad-model"),
          name: "Bad model bot",
          title: "Bad model bot",
          avatar: { kind: "dither", seed: "bad-model" },
          engine: { provider: "codex", model: "not-a-model" },
          sandbox: "local",
          usageCap: null,
          groupId: null,
          createdAt: now,
        }),
      });

      assert.equal(response.status, 400);
      const error = (yield* response.json) as Schema.JsonObject;
      assert.equal(error.unavailability, "unsupported-model");
      assert.equal(dispatch.mock.calls.length, 0);
    }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect("lets bot.update pass when the saved engine is unchanged", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-stale-model");
      const engine = { provider: "codex", model: "dropped-model" };
      let sequence = 0;
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-ws-preflight-"));
      seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));
      yield* buildAppUnderTest({
        config: { baseDir },
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([readyProvider(["gpt-5.6-sol"])]),
          },
          projectionBots: {
            getById: ({ botId: requested }) =>
              Effect.succeed(requested === botId ? Option.some(bot(botId, engine)) : Option.none()),
          },
          orchestrationEngine: {
            dispatch: () => Effect.sync(() => ({ sequence: ++sequence })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand]({
            type: "bot.update",
            commandId: CommandId.make("cmd-bot-update-unchanged"),
            botId,
            name: "Renamed bot",
            engine,
          }),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Success"));

      if (Predicate.isTagged(result, "Success")) assert.equal(result.success.sequence, 1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect("rejects a bot turn when the saved model dropped from the catalog", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-stale-turn");
      const threadId = ThreadId.make("thread-stale-turn");
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-ws-preflight-"));
      seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));
      yield* buildAppUnderTest({
        config: { baseDir },
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([readyProvider(["gpt-5.6-sol"])]),
          },
          projectionBots: {
            getById: ({ botId: requested }) =>
              Effect.succeed(
                requested === botId
                  ? Option.some(bot(botId, { provider: "codex", model: "dropped-model" }))
                  : Option.none(),
              ),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, botId })),
              ),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](turnStartCommand(threadId)),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Failure"));

      if (Predicate.isTagged(result, "Failure")) {
        assert.equal(result.failure._tag, "OrchestrationDispatchCommandError");
        assert.include(result.failure.message, "dropped-model");
        assert.equal(
          (result.failure as { readonly unavailability?: string }).unavailability,
          "unsupported-model",
        );
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect("dispatches a bot turn when the catalog snapshot is unsettled", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-unsettled-catalog");
      const threadId = ThreadId.make("thread-unsettled-catalog");
      let sequence = 0;
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-ws-preflight-"));
      seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));
      yield* buildAppUnderTest({
        config: { baseDir },
        layers: {
          providerRegistry: {
            // A warning snapshot still carries only the built-in catalog, so a
            // saved custom model missing from it is not proof it is gone.
            getProviders: Effect.succeed([
              readyProvider(["gpt-5.6-sol"], ProviderInstanceId.make("codex"), "warning"),
            ]),
          },
          projectionBots: {
            getById: ({ botId: requested }) =>
              Effect.succeed(
                requested === botId
                  ? Option.some(bot(botId, { provider: "codex", model: "custom-model" }))
                  : Option.none(),
              ),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, botId })),
              ),
          },
          orchestrationEngine: {
            dispatch: () => Effect.sync(() => ({ sequence: ++sequence })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](turnStartCommand(threadId)),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Success"));

      if (Predicate.isTagged(result, "Success")) assert.equal(result.success.sequence, 1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect(
    "dispatches a turn when the command selection is unlisted on an unsettled catalog",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("thread-unsettled-command-model");
        let sequence = 0;
        const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-ws-preflight-"));
        seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));
        yield* buildAppUnderTest({
          config: { baseDir },
          layers: {
            providerRegistry: {
              // Web group turns forward the responder's saved engine as the
              // command modelSelection, so that path also must not fail on a
              // warning snapshot's built-in-only catalog.
              getProviders: Effect.succeed([
                readyProvider(["gpt-5.6-sol"], ProviderInstanceId.make("codex"), "warning"),
              ]),
            },
            projectionSnapshotQuery: {
              getThreadShellById: () =>
                Effect.succeed(
                  Option.some(makeDefaultOrchestrationThreadShell({ id: threadId, botId: null })),
                ),
            },
            orchestrationEngine: {
              dispatch: () => Effect.sync(() => ({ sequence: ++sequence })),
            },
          },
        });

        const wsUrl = yield* getWsServerUrl("/ws");

        const result = yield* Effect.scoped(
          withWsRpcClient(wsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](
              turnStartCommand(threadId, {
                modelSelection: {
                  instanceId: ProviderInstanceId.make("codex"),
                  model: "custom-model",
                },
              }),
            ),
          ).pipe(Effect.result),
        );

        assertTrue(Predicate.isTagged(result, "Success"));

        if (Predicate.isTagged(result, "Success")) assert.equal(result.success.sequence, 1);
      }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );

  it.effect("lets a group turn through when the last responder's model went stale", () =>
    Effect.gen(function* () {
      const staleBotId = BotId.make("bot-stale-responder");
      const healthyBotId = BotId.make("bot-healthy-responder");
      const groupId = GroupId.make("group-preflight");
      const threadId = ThreadId.make("thread-group-preflight");

      const bots = new Map<string, ProjectionBots.ProjectionBot>([
        [String(staleBotId), bot(staleBotId, { provider: "codex", model: "dropped-model" })],
        [String(healthyBotId), bot(healthyBotId, { provider: "codex", model: "gpt-5.6-sol" })],
      ]);

      let sequence = 0;
      const baseDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "akeru-ws-preflight-"));
      seedSubscriptionAuth(NodePath.join(baseDir, "userdata", "secrets"));
      yield* buildAppUnderTest({
        config: { baseDir },
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([readyProvider(["gpt-5.6-sol"])]),
          },
          projectionBots: {
            getById: ({ botId: requested }) =>
              Effect.succeed(Option.fromNullishOr(bots.get(String(requested)))),
          },
          projectionSnapshotQuery: {
            getThreadShellById: () =>
              Effect.succeed(
                Option.some(
                  makeDefaultOrchestrationThreadShell({
                    id: threadId,
                    botId: null,
                    groupId,
                    respondingBotId: staleBotId,
                  }),
                ),
              ),
          },
          orchestrationEngine: {
            dispatch: () => Effect.sync(() => ({ sequence: ++sequence })),
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[ORCHESTRATION_WS_METHODS.dispatchCommand](turnStartCommand(threadId)),
        ).pipe(Effect.result),
      );

      assertTrue(Predicate.isTagged(result, "Success"));

      if (Predicate.isTagged(result, "Success")) assert.equal(result.success.sequence, 1);
    }).pipe(Effect.provide(Layer.mergeAll(NodeHttpServer.layerTest, NodeServices.layer))),
  );
});
