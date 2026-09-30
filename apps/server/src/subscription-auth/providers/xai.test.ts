import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { createDeviceCodePollState } from "../deviceCode.ts";
import { scriptedHttpClient } from "../testUtils/scriptedHttpClient.ts";
import { type XAIDeviceLoginPending, XAIOAuth } from "./xai.ts";

const pending: XAIDeviceLoginPending = {
  deviceCode: "device-code",
  userCode: "ABCD-EFGH",
  url: "https://accounts.x.ai/device",
  instructions: "Enter code: ABCD-EFGH",
  state: createDeviceCodePollState({ intervalSeconds: 5, expiresInSeconds: 600, now: 0 }),
};

const pollWith = (response: Response) => {
  const { client } = scriptedHttpClient(() => response);
  return XAIOAuth.pollDeviceLogin(pending).pipe(
    Effect.provideService(HttpClient.HttpClient, client),
  );
};

describe("xAI device login", () => {
  it.effect("starts a login with the complete verification URL", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() =>
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.x.ai/device",
          verification_uri_complete: "https://accounts.x.ai/device?code=ABCD-EFGH",
          interval: 7,
          expires_in: 300,
        }),
      );
      yield* TestClock.adjust(1_000);
      const result = yield* XAIOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({
        deviceCode: "device-code",
        userCode: "ABCD-EFGH",
        url: "https://accounts.x.ai/device?code=ABCD-EFGH",
        instructions: "Enter code: ABCD-EFGH",
        state: { deadlineAt: 301_000, intervalMs: 7_000, slowDownResponses: 0 },
      });
      expect(requests[0]?.headers["content-type"]).toBe("application/x-www-form-urlencoded");
      expect(new URLSearchParams(requests[0]?.body).get("client_id")).toBeTruthy();
    }),
  );

  it.effect("rejects a non-https verification URL", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() =>
        Response.json({
          device_code: "device-code",
          user_code: "ABCD-EFGH",
          verification_uri: "http://accounts.x.ai/device",
        }),
      );
      const error = yield* XAIOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error._tag).toBe("SubscriptionAuthResponseError");
      expect(error.message).toContain("non-https verification_uri");
    }),
  );

  it.effect("reports the status when starting fails", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => new Response("nope", { status: 401 }));
      const error = yield* XAIOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "SubscriptionAuthRequestError",
        status: 401,
        message: "Failed to initiate xAI device authorization: 401 nope",
      });
    }),
  );

  it.effect("keeps polling while authorization is pending", () =>
    Effect.gen(function* () {
      const result = yield* pollWith(
        Response.json({ error: "authorization_pending" }, { status: 400 }),
      );
      expect(result).toMatchObject({ status: "pending", nextPollMs: 6_000 });
    }),
  );

  it.effect("honours the interval sent with slow_down", () =>
    Effect.gen(function* () {
      const result = yield* pollWith(
        Response.json({ error: "slow_down", interval: 15 }, { status: 400 }),
      );
      expect(result).toMatchObject({
        status: "pending",
        nextPollMs: 21_000,
        pending: { state: { intervalMs: 15_000, slowDownResponses: 1 } },
      });
    }),
  );

  it.effect("fails when the user denies access", () =>
    Effect.gen(function* () {
      const result = yield* pollWith(Response.json({ error: "access_denied" }, { status: 400 }));
      expect(result).toEqual({ status: "failed", error: "xAI authorization was denied" });
    }),
  );

  it.effect("reports unknown poll errors with status and body", () =>
    Effect.gen(function* () {
      const result = yield* pollWith(new Response("upstream broke", { status: 502 }));
      expect(result).toEqual({
        status: "failed",
        error: "xAI device authorization failed: 502 upstream broke",
      });
    }),
  );

  it.effect("completes with credentials", () =>
    Effect.gen(function* () {
      const result = yield* pollWith(
        Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 }),
      );
      expect(result).toEqual({
        status: "complete",
        credentials: { access: "access", refresh: "refresh", expires: 3_300_000 },
      });
    }),
  );

  it.effect("times out a stalled poll", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => Effect.never);
      const fiber = yield* XAIOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe("xAI device token poll timed out after 30s");
    }),
  );

  it.effect("keeps the previous refresh token when refresh omits one", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => Response.json({ access_token: "next" }));
      const result = yield* XAIOAuth.refreshToken("previous").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({ access: "next", refresh: "previous", expires: 3_300_000 });
    }),
  );
});
