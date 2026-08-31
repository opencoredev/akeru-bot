import { AuthStandardClientScopes, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ClientCapabilities from "../platform/capabilities.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import * as RemoteEnvironmentAuthorization from "./service.ts";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const ENDPOINT = {
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
};
const DESCRIPTOR = {
  environmentId: ENVIRONMENT_ID,
  label: "Remote environment",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "0.0.0-test",
  capabilities: { repositoryIdentity: true },
};

function makeHarness(responses: ReadonlyArray<Response>) {
  const calls: Array<readonly [RequestInfo | URL, RequestInit]> = [];
  let responseIndex = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[responseIndex++];
    return response === undefined
      ? Promise.reject(new Error(`Unexpected fetch call to ${String(input)}`))
      : Promise.resolve(response);
  }) satisfies typeof fetch;
  const layer = RemoteEnvironmentAuthorization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        remoteHttpClientLayer(fetchFn),
        Layer.succeed(
          ClientCapabilities.ClientPresentation,
          ClientCapabilities.ClientPresentation.of({
            metadata: { label: "Akeru Bot Test", deviceType: "desktop", os: "test" },
            scopes: AuthStandardClientScopes,
          }),
        ),
      ),
    ),
  );
  return { calls, layer };
}

const websocketTicket = (ticket: string) =>
  Response.json({ ticket, expiresAt: "2026-06-06T01:00:00.000Z" });

describe("RemoteEnvironmentAuthorization", () => {
  it.effect("reuses a validated bearer descriptor while issuing fresh websocket tickets", () =>
    Effect.gen(function* () {
      const harness = makeHarness([
        Response.json(DESCRIPTOR),
        websocketTicket("first-ticket"),
        websocketTicket("second-ticket"),
      ]);

      const [first, second] = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
          });
        return [yield* authorize(), yield* authorize()] as const;
      }).pipe(Effect.provide(harness.layer));

      expect(first.socketUrl).toContain("wsTicket=first-ticket");
      expect(second.socketUrl).toContain("wsTicket=second-ticket");
      expect(
        harness.calls.filter(([url]) => String(url).endsWith("/.well-known/t3/environment")),
      ).toHaveLength(1);
      expect(
        harness.calls.filter(([url]) => String(url).endsWith("/api/auth/websocket-ticket")),
      ).toHaveLength(2);
    }),
  );

  it.effect("revalidates a bearer descriptor after the cache expires", () =>
    Effect.gen(function* () {
      const reassignedEnvironmentId = EnvironmentId.make("environment-2");
      const harness = makeHarness([
        Response.json(DESCRIPTOR),
        websocketTicket("first-ticket"),
        Response.json({ ...DESCRIPTOR, environmentId: reassignedEnvironmentId }),
      ]);

      const failure = yield* Effect.gen(function* () {
        const remote = yield* RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization;
        const authorize = () =>
          remote.authorizeBearer({
            expectedEnvironmentId: ENVIRONMENT_ID,
            httpBaseUrl: ENDPOINT.httpBaseUrl,
            wsBaseUrl: ENDPOINT.wsBaseUrl,
            bearerToken: "bearer-token",
          });
        yield* authorize();
        yield* TestClock.adjust("10 seconds");
        return yield* authorize().pipe(Effect.flip);
      }).pipe(Effect.provide(Layer.merge(harness.layer, TestClock.layer())));

      expect(failure).toEqual(
        expect.objectContaining({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
          detail: `Connected environment ${reassignedEnvironmentId} does not match ${ENVIRONMENT_ID}.`,
        }),
      );
    }),
  );
});
