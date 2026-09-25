import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { createDeviceCodePollState } from "../deviceCode.ts";
import { scriptedHttpClient } from "../testUtils/scriptedHttpClient.ts";
import { KimiOAuth, pollKimiDeviceLogin, type KimiDeviceLoginPending } from "./kimi.ts";

const DEVICE_ID = "0123456789abcdef0123456789abcdef";

const pending: KimiDeviceLoginPending = {
  deviceId: DEVICE_ID,
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  url: "https://www.kimi.com/device?code=ABCD-EFGH",
  instructions: "Enter code: ABCD-EFGH",
  state: createDeviceCodePollState({ intervalSeconds: 5, expiresInSeconds: 900, now: 0 }),
};

const pollWith = (response: Response) => {
  const { client } = scriptedHttpClient(() => response);
  return KimiOAuth.pollDeviceLogin(pending).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );
};

const tokens = { access_token: "access", refresh_token: "refresh", expires_in: 3600 };

describe("Kimi For Coding OAuth", () => {
  it("fails legacy pending logins without throwing", async () => {
    const legacy = {
      deviceCode: "legacy-device-code",
      userCode: "ABCD-EFGH",
      url: "https://auth.kimi.com/device",
      instructions: "Enter code: ABCD-EFGH",
      state: createDeviceCodePollState({ intervalSeconds: 5, expiresInSeconds: 900, now: 0 }),
    } as KimiDeviceLoginPending;

    await expect(pollKimiDeviceLogin(legacy)).resolves.toEqual({
      status: "failed",
      error: "Kimi For Coding login is missing its device identity. Restart the login.",
    });
  });

  it.effect("starts a login with device headers", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() =>
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://www.kimi.com/device",
          verification_uri_complete: "https://www.kimi.com/device?code=ABCD-EFGH",
        }),
      );
      const result = yield* KimiOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toMatchObject({
        deviceCode: "device-code",
        url: "https://www.kimi.com/device?code=ABCD-EFGH",
        state: { deadlineAt: 900_000, intervalMs: 5_000, slowDownResponses: 0 },
      });
      expect(result.deviceId).toMatch(/^[0-9a-f]{32}$/);
      expect(requests[0]?.headers["x-msh-device-id"]).toBe(result.deviceId);
    }),
  );

  it.effect("rejects a non-https verification URL", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() =>
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://www.kimi.com/device",
          verification_uri_complete: "http://www.kimi.com/device?code=ABCD-EFGH",
        }),
      );
      const error = yield* KimiOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "SubscriptionAuthResponseError",
        message: "Invalid Kimi For Coding device authorization response",
      });
    }),
  );

  it.effect("maps poll responses onto the device flow", () =>
    Effect.gen(function* () {
      expect(
        yield* pollWith(Response.json({ error: "authorization_pending" }, { status: 400 })),
      ).toMatchObject({ status: "pending", nextPollMs: 6_000 });
      expect(
        yield* pollWith(Response.json({ error: "slow_down", interval: 12 }, { status: 400 })),
      ).toMatchObject({ status: "pending", nextPollMs: 16_800 });
      expect(
        yield* pollWith(Response.json({ error: "expired_token" }, { status: 400 })),
      ).toEqual({
        status: "failed",
        error: "Kimi For Coding authorization expired. Restart the login.",
      });
      expect(
        yield* pollWith(Response.json({ error: "access_denied" }, { status: 400 })),
      ).toEqual({ status: "failed", error: "Kimi For Coding login was denied." });
      expect(
        yield* pollWith(
          Response.json({ error: "invalid_client", error_description: "bad" }, { status: 401 }),
        ),
      ).toEqual({
        status: "failed",
        error: "Kimi For Coding token request failed: 401 invalid_client: bad",
      });
    }),
  );

  it.effect("completes with credentials bound to the device", () =>
    Effect.gen(function* () {
      expect(yield* pollWith(Response.json(tokens))).toEqual({
        status: "complete",
        credentials: {
          access: "access",
          refresh: "refresh",
          expires: 3_600_000,
          deviceId: DEVICE_ID,
        },
      });
    }),
  );

  it.effect("retries a transient refresh failure with backoff", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient((_, index) =>
        index < 2 ? new Response("busy", { status: 503 }) : Response.json(tokens),
      );
      const fiber = yield* KimiOAuth.refreshToken("refresh", DEVICE_ID).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.forkChild,
      );
      yield* TestClock.adjust(0);
      expect(requests).toHaveLength(1);
      yield* TestClock.adjust("1 second");
      expect(requests).toHaveLength(2);
      yield* TestClock.adjust("1999 millis");
      expect(requests).toHaveLength(2);
      yield* TestClock.adjust("1 millis");
      expect(requests).toHaveLength(3);
      const credentials = yield* Fiber.join(fiber);
      expect(credentials).toMatchObject({ access: "access", deviceId: DEVICE_ID });
      expect(new URLSearchParams(requests[2]?.body).get("grant_type")).toBe("refresh_token");
    }),
  );

  it.effect("gives up after three refresh retries", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(
        () => new Response("busy", { status: 503 }),
      );
      const fiber = yield* KimiOAuth.refreshToken("refresh", DEVICE_ID).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("7 seconds");
      const error = yield* Fiber.join(fiber);
      expect(requests).toHaveLength(4);
      expect(error).toMatchObject({
        status: 503,
        message: "Kimi For Coding token refresh failed: 503",
      });
    }),
  );

  it.effect("does not retry a rejected refresh token", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() =>
        Response.json({ error: "invalid_grant" }, { status: 400 }),
      );
      const error = yield* KimiOAuth.refreshToken("refresh", DEVICE_ID).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(requests).toHaveLength(1);
      expect(error.message).toBe("Kimi For Coding token refresh failed: 400 invalid_grant");
    }),
  );

  it.effect("refuses to refresh without a device id", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() => Response.json(tokens));
      const error = yield* KimiOAuth.refreshToken("refresh", undefined).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(requests).toHaveLength(0);
      expect(error._tag).toBe("SubscriptionAuthInputError");
    }),
  );
});
