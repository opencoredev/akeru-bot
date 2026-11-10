import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type EnvironmentHostDescriptor, WS_METHODS } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { exchangeAccessToken, getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";
import { defaultDesktopBootstrapToken, testEnvironmentDescriptor } from "./serverTestFixtures.ts";

const descriptor: EnvironmentHostDescriptor = {
  environmentId: testEnvironmentDescriptor.environmentId,
  label: testEnvironmentDescriptor.label,
  platform: { os: "darwin", arch: "arm64" },
  cpuCount: 10,
  load: {
    cpuUtilization: 0.2,
    availableMemoryBytes: 8,
    totalMemoryBytes: 16,
    sampleAgeMs: 1_200,
  },
  tools: ["git", "xcodebuild"],
  providers: [],
  projects: [],
  profile: { labels: ["xcode"], note: "Builds iOS apps.", placementWeight: "prefer" },
};

it.layer(NodeServices.layer)("server.getEnvironmentHost", (it) => {
  it.effect("serves the descriptor to a standard paired client", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        layers: { environmentHost: { describe: Effect.succeed(descriptor) } },
      });

      // Standard pairing scopes, without access:read: reading what a machine
      // can do is ordinary orchestration data.
      const { body: tokenBody } = yield* exchangeAccessToken(defaultDesktopBootstrapToken, {
        scope: "orchestration:read",
      });

      const ticketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: { authorization: `Bearer ${tokenBody.access_token ?? ""}` },
      });

      const ticketBody = yield* HttpClientResponse.schemaBodyJson(
        Schema.Struct({ ticket: Schema.String }),
      )(ticketResponse);

      const readOnlyWsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(ticketBody.ticket)}`;

      const served = yield* Effect.scoped(
        withWsRpcClient(readOnlyWsUrl, (client) => client[WS_METHODS.serverGetEnvironmentHost]({})),
      );

      assert.deepStrictEqual(served, descriptor);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
