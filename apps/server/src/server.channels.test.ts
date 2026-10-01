// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ChannelBinding,
  ChannelConnectionId,
  CommandId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpBody, HttpClient } from "effect/unstable/http";
import * as ChannelRuntime from "./channels/ChannelRuntime.ts";

import { makeChannelTestBot, defaultDesktopBootstrapToken } from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import { exchangeAccessToken, getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("keeps channel management host-only and serves channel health over HTTP", () =>
    Effect.gen(function* () {
      const bot = makeChannelTestBot();
      yield* buildAppUnderTest({
        layers: {
          projectionSnapshotQuery: {
            getShellSnapshot: () =>
              Effect.succeed({
                snapshotSequence: 1,
                bots: [
                  {
                    ...bot,
                    channelBindings: [
                      {
                        botId: bot.id,
                        provider: "telegram" as const,
                        status: "needs-reconnect" as const,
                        externalIdentity: "@channel_bot",
                        connectedAt: "2026-01-01T00:00:00.000Z",
                        lastSucceededAt: "2026-01-01T00:05:00.000Z",
                        lastError: "The channel connection stopped. Reconnect to resume.",
                        failureCategory: "network" as const,
                        sentMessageIds: [],
                      },
                      {
                        botId: bot.id,
                        provider: "slack" as const,
                        status: "connected" as const,
                        externalIdentity: "channel-bot",
                        connectedAt: "2026-01-01T00:00:00.000Z",
                        lastSucceededAt: "2026-01-01T00:00:00.000Z",
                        sentMessageIds: [],
                      },
                    ],
                  },
                ],
                groups: [],
                delegations: [],
                projects: [],
                threads: [],
                updatedAt: "2026-01-01T00:00:00.000Z",
              }),
          },
        },
      });

      const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read orchestration:operate terminal:operate review:write",
      });

      const authorization = `Bearer ${tokenBody.access_token ?? ""}`;

      const command = {
        type: "channel.disconnect" as const,
        commandId: CommandId.make("cmd-channel-standard"),
        botId: bot.id,
        provider: "telegram" as const,
      };

      const httpDenied = yield* HttpClient.post("/api/orchestration/dispatch", {
        headers: { authorization },
        body: yield* HttpBody.json(command),
      });

      const httpDeniedBody = (yield* httpDenied.json) as { readonly requiredScope: string };
      assert.equal(httpDenied.status, 403);
      assert.equal(httpDeniedBody.requiredScope, "access:write");

      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization },
      });

      const ticketBody = (yield* ticketResponse.json) as { readonly ticket: string };
      const standardWsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticketBody.ticket)}`;

      const wsDenied = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(standardWsUrl, (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
          ),
        ),
      );

      assert.equal(wsDenied._tag, "OrchestrationDispatchCommandError");
      assert.equal(wsDenied.message, "Only the environment host can manage external channels.");

      // A standard client can still read health; a connected binding with no live transport
      // reads as needs-reconnect, and a stored failure keeps its category and last success.
      const shellResponse = yield* HttpClient.get("/api/orchestration/shell", {
        headers: { authorization },
      });

      const shell = (yield* shellResponse.json) as {
        readonly bots: ReadonlyArray<{ readonly channelBindings: ReadonlyArray<ChannelBinding> }>;
      };

      assert.equal(shellResponse.status, 200);
      const [telegram, slack] = shell.bots[0]?.channelBindings ?? [];
      assert.deepInclude(telegram, {
        status: "needs-reconnect",
        failureCategory: "network",
        lastSucceededAt: "2026-01-01T00:05:00.000Z",
        lastError: "The channel connection stopped. Reconnect to resume.",
      });
      assert.deepInclude(slack, {
        status: "needs-reconnect",
        lastSucceededAt: "2026-01-01T00:00:00.000Z",
      });
      assert.notProperty(slack, "failureCategory");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("sends a failed channel attach category over the WebSocket RPC", () =>
    Effect.gen(function* () {
      const bot = makeChannelTestBot();
      yield* buildAppUnderTest({
        layers: {
          channelRuntime: {
            channelBindingsForRuntime: (bindings) => bindings,
            attach: () =>
              Effect.fail(
                new ChannelRuntime.ChannelRuntimeError({
                  message: "The selected project is unavailable. Choose another project.",
                  category: "project",
                }),
              ),
          },
        },
      });

      const command = {
        type: "channel.attach" as const,
        commandId: CommandId.make("cmd-channel-attach-missing-project"),
        botId: bot.id,
        connectionId: ChannelConnectionId.make("connection-1"),
        projectId: ProjectId.make("missing-project"),
        provider: "telegram" as const,
      };

      const failure = yield* Effect.flip(
        Effect.scoped(
          withWsRpcClient(yield* getWsServerUrl("/ws"), (client) =>
            client[ORCHESTRATION_WS_METHODS.dispatchCommand](command),
          ),
        ),
      );

      if (!Predicate.isTagged(failure, "OrchestrationDispatchCommandError")) {
        throw new Error(`Expected channel dispatch error, received ${failure._tag}`);
      }

      assert.equal(failure.message, "The selected project is unavailable. Choose another project.");
      assert.equal(failure.channelFailureCategory, "project");
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
