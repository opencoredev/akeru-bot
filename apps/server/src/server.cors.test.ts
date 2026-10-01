// @effect-diagnostics globalDate:off nodeBuiltinImport:off
import * as Predicate from "effect/Predicate";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { WS_METHODS } from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HttpBody, HttpClient } from "effect/unstable/http";

import { buildAppUnderTest } from "./serverTestApp.ts";
import {
  exchangeAccessToken,
  getWsServerUrl,
  withWsRpcClient,
  crossOriginClientOrigin,
  assertBrowserApiCorsResponseHeaders,
  getHttpServerUrl,
  fetchEffect,
  responseJsonEffect,
  assertBrowserApiCorsPreflightHeaders,
} from "./serverTestClients.ts";
import { defaultDesktopBootstrapToken } from "./serverTestFixtures.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("does not allow management-only access tokens to operate the environment", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const { response: exchangeResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        { scope: "access:write" },
      );

      assert.equal(exchangeResponse.status, 200);
      assert.equal(tokenBody.scope, "access:write");
      assert.isDefined(tokenBody.access_token);

      const overbroadPairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({}),
      });

      const overbroadPairingBody = (yield* overbroadPairingResponse.json) as {
        readonly requiredScope: string;
      };

      const pairingResponse = yield* HttpClient.post("/api/auth/pairing-token", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
        body: yield* HttpBody.json({ scopes: ["access:write"] }),
      });

      const wsTicketResponse = yield* HttpClient.post("/api/auth/websocket-ticket", {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
        },
      });

      const wsTicketBody = (yield* wsTicketResponse.json) as { readonly ticket: string };
      assert.equal(overbroadPairingResponse.status, 403);
      assert.equal(overbroadPairingBody.requiredScope, "orchestration:read");
      assert.equal(pairingResponse.status, 200);
      assert.equal(wsTicketResponse.status, 200);
      const wsUrl = `${yield* getWsServerUrl("/ws", { authenticated: false })}?wsTicket=${encodeURIComponent(wsTicketBody.ticket)}`;

      const rpcError = yield* Effect.flip(
        Effect.scoped(withWsRpcClient(wsUrl, (client) => client[WS_METHODS.serverGetConfig]({}))),
      );

      assert.equal(rpcError._tag, "EnvironmentAuthorizationError");

      if (Predicate.isTagged(rpcError, "EnvironmentAuthorizationError")) {
        assert.equal(rpcError.requiredScope, "orchestration:read");
      }
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("includes CORS headers on remote auth success responses", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const origin = crossOriginClientOrigin;

      const { response: tokenResponse, body: tokenBody } = yield* exchangeAccessToken(
        defaultDesktopBootstrapToken,
        {
          headers: { origin },
        },
      );

      assert.equal(tokenResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(tokenResponse.headers);
      assert.equal(tokenBody.token_type, "Bearer");
      assert.equal(Predicate.isString(tokenBody.access_token), true);

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");

      const sessionResponse = yield* fetchEffect(sessionUrl, {
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });

      const sessionBody = yield* responseJsonEffect<{
        readonly authenticated: boolean;
        readonly sessionMethod?: string;
      }>(sessionResponse);

      assert.equal(sessionResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(sessionResponse.headers);
      assert.equal(sessionBody.authenticated, true);
      assert.equal(sessionBody.sessionMethod, "bearer-access-token");

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");

      const wsTicketResponse = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${tokenBody.access_token ?? ""}`,
          origin,
        },
      });

      const wsTicketBody = yield* responseJsonEffect<{
        readonly ticket: string;
      }>(wsTicketResponse);

      assert.equal(wsTicketResponse.status, 200);
      assertBrowserApiCorsResponseHeaders(wsTicketResponse.headers);
      assert.equal(Predicate.isString(wsTicketBody.ticket), true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect(
    "responds to remote auth websocket-ticket preflight requests with authorization CORS headers",
    () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest();

        const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");

        const response = yield* fetchEffect(wsTicketUrl, {
          method: "OPTIONS",
          headers: {
            origin: crossOriginClientOrigin,
            "access-control-request-method": "POST",
            "access-control-request-headers": "authorization",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers);
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows credentialed cloud link proof preflights from the configured dev UI", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest({
        config: { devUrl: new URL(crossOriginClientOrigin) },
      });

      const linkProofUrl = yield* getHttpServerUrl("/api/connect/link-proof");

      const response = yield* fetchEffect(linkProofUrl, {
        method: "OPTIONS",
        headers: {
          origin: crossOriginClientOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: crossOriginClientOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("allows configured development origins through ServerConfig", () =>
    Effect.gen(function* () {
      const tailnetOrigin = "https://host.example.ts.net";
      yield* buildAppUnderTest({
        config: {
          devUrl: new URL(crossOriginClientOrigin),
          devAllowedOrigins: [tailnetOrigin],
        },
      });

      const sessionUrl = yield* getHttpServerUrl("/api/auth/session");

      const response = yield* fetchEffect(sessionUrl, {
        method: "OPTIONS",
        headers: {
          origin: tailnetOrigin,
          "access-control-request-method": "GET",
          "access-control-request-headers": "content-type",
        },
      });

      assert.equal(response.status, 204);
      assertBrowserApiCorsPreflightHeaders(response.headers, {
        origin: tailnetOrigin,
        credentials: true,
      });
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  for (const desktopOrigin of ["akeru://app", "akeru-dev://app"]) {
    it.effect(`allows credentialed preflights from ${desktopOrigin} in development`, () =>
      Effect.gen(function* () {
        yield* buildAppUnderTest({
          config: { devUrl: new URL(crossOriginClientOrigin) },
        });

        const sessionUrl = yield* getHttpServerUrl("/api/auth/session");

        const response = yield* fetchEffect(sessionUrl, {
          method: "OPTIONS",
          headers: {
            origin: desktopOrigin,
            "access-control-request-method": "GET",
            "access-control-request-headers": "content-type",
          },
        });

        assert.equal(response.status, 204);
        assertBrowserApiCorsPreflightHeaders(response.headers, {
          origin: desktopOrigin,
          credentials: true,
        });
      }).pipe(Effect.provide(NodeHttpServer.layerTest)),
    );
  }

  it.effect("includes CORS headers on remote websocket-ticket auth failures", () =>
    Effect.gen(function* () {
      yield* buildAppUnderTest();

      const wsTicketUrl = yield* getHttpServerUrl("/api/auth/websocket-ticket");

      const response = yield* fetchEffect(wsTicketUrl, {
        method: "POST",
        headers: {
          origin: crossOriginClientOrigin,
        },
      });

      const body = yield* responseJsonEffect<{
        readonly _tag?: string;
        readonly code?: string;
        readonly reason?: string;
        readonly traceId?: string;
      }>(response);

      assert.equal(response.status, 401);
      assertBrowserApiCorsResponseHeaders(response.headers);
      assert.equal(body._tag, "EnvironmentAuthInvalidError");
      assert.equal(body.code, "auth_invalid");
      assert.equal(body.reason, "missing_credential");
      assert.equal(Predicate.isString(body.traceId), true);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
