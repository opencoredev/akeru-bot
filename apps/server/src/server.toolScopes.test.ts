import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId, WS_METHODS } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { defaultDesktopBootstrapToken } from "./serverTestFixtures.ts";
import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  exchangeAccessToken,
  fetchEffect,
  getHttpServerUrl,
  getWsServerUrl,
  responseJsonEffect,
  withWsRpcClient,
} from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("refuses computer and voice controls to a read-scoped client", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const readToken = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });

      assert.equal(readToken.response.status, 200);

      const ticketResponse = yield* fetchEffect(
        yield* getHttpServerUrl("/api/auth/websocket-ticket"),
        {
          method: "POST",
          headers: { authorization: `Bearer ${readToken.body.access_token ?? ""}` },
        },
      );

      const ticketBody = yield* responseJsonEffect<{ readonly ticket: string }>(ticketResponse);
      const readWsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticketBody.ticket)}`;
      const threadId = ThreadId.make("thread-computer");

      const denied = yield* Effect.scoped(
        withWsRpcClient(readWsUrl, (client) =>
          Effect.all([
            Effect.flip(client[WS_METHODS.computerAcquire]({ threadId })),
            Effect.flip(client[WS_METHODS.computerStop]({ threadId })),
            Effect.flip(
              client[WS_METHODS.voiceConnect]({
                provider: "elevenlabs",
                apiKey: "replacement-key",
              }),
            ),
          ]),
        ),
      );

      assert.deepEqual(
        denied.map((error) => error._tag),
        [
          "EnvironmentAuthorizationError",
          "EnvironmentAuthorizationError",
          "EnvironmentAuthorizationError",
        ],
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
