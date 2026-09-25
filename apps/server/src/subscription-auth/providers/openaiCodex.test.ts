import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { fakeJwt, scriptedHttpClient } from "../testUtils/scriptedHttpClient.ts";
import { type CodexDeviceLoginPending, CodexOAuth } from "./openaiCodex.ts";

const pending: CodexDeviceLoginPending = {
  deviceAuthId: "device-auth",
  userCode: "ABCD-EFGH",
  url: "https://auth.openai.com/codex/device",
  instructions: "Enter code: ABCD-EFGH",
  intervalMs: 5_000,
  deadlineAt: 900_000,
};

// The pre-migration code built these bodies with URLSearchParams in this field order.
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const exchangeBody = new URLSearchParams({
  grant_type: "authorization_code",
  client_id: CLIENT_ID,
  code: "code",
  code_verifier: "verifier",
  redirect_uri: "https://auth.openai.com/deviceauth/callback",
}).toString();
const refreshBody = new URLSearchParams({
  grant_type: "refresh_token",
  refresh_token: "old-refresh",
  client_id: CLIENT_ID,
}).toString();

const tokens = (claims: Record<string, unknown>) => ({
  id_token: fakeJwt(claims),
  access_token: fakeJwt({}),
  refresh_token: "refresh",
  expires_in: 3600,
});

describe("OpenAI Codex device login", () => {
  it.effect("starts a login with the usercode fallback and a string interval", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() =>
        Response.json({ device_auth_id: "device-auth", usercode: "ABCD-EFGH", interval: "8" }),
      );
      const result = yield* CodexOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({ ...pending, intervalMs: 8_000 });
      expect(requests[0]?.headers["user-agent"]).toBe("akeru");
      expect(requests[0]?.json).toMatchObject({ originator: "akeru" });
    }),
  );

  it.effect("fails to start when the response has no user code", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => Response.json({ device_auth_id: "device-auth" }));
      const error = yield* CodexOAuth.startDeviceLogin().pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error.message).toBe(
        "OpenAI Codex device authorization response missing required fields",
      );
    }),
  );

  it.effect("keeps polling on 403 and 404", () =>
    Effect.gen(function* () {
      for (const status of [403, 404]) {
        const { client } = scriptedHttpClient(() => new Response("", { status }));
        const result = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(result).toEqual({ status: "pending", nextPollMs: 5_000 });
      }
    }),
  );

  it.effect("exchanges the device code and reads the account id from the id token", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient((request) =>
        request.url.endsWith("/deviceauth/token")
          ? Response.json({ authorization_code: "code", code_verifier: "verifier" })
          : Response.json(tokens({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })),
      );
      const result = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toMatchObject({
        status: "complete",
        credentials: { refresh: "refresh", expires: 3_600_000, accountId: "acct" },
      });
      expect(requests[1]?.body).toBe(exchangeBody);
    }),
  );

  it.effect("fails when no token carries an account id", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient((request) =>
        request.url.endsWith("/deviceauth/token")
          ? Response.json({ authorization_code: "code", code_verifier: "verifier" })
          : Response.json(tokens({})),
      );
      const result = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({
        status: "failed",
        error: "Failed to extract ChatGPT account id from OpenAI Codex token",
      });
    }),
  );

  it.effect("fails a rejected token exchange", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient((request) =>
        request.url.endsWith("/deviceauth/token")
          ? Response.json({ authorization_code: "code", code_verifier: "verifier" })
          : new Response("bad", { status: 400 }),
      );
      const result = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({ status: "failed", error: "Token exchange failed" });
    }),
  );

  it.effect("reports other poll statuses", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => new Response("gone", { status: 410 }));
      const result = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({
        status: "failed",
        error: "OpenAI Codex device authorization failed: 410 gone",
      });
    }),
  );

  it.effect("fails without polling after the deadline", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() => new Response("", { status: 403 }));
      yield* TestClock.adjust(900_000);
      const result = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(requests).toHaveLength(0);
      expect(result).toEqual({
        status: "failed",
        error: "OpenAI Codex device authorization timed out after 15 minutes",
      });
    }),
  );

  it.effect("times out a stalled poll", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => Effect.never);
      const fiber = yield* CodexOAuth.pollDeviceLogin(pending).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("30 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe("OpenAI Codex device authorization poll timed out after 30s");
    }),
  );

  it.effect("refresh keeps the stored account id when the tokens carry none", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() => Response.json(tokens({})));
      const result = yield* CodexOAuth.refreshToken({
        access: "old",
        refresh: "old-refresh",
        expires: 0,
        accountId: "stored",
      }).pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(result).toMatchObject({ refresh: "refresh", accountId: "stored" });
      expect(requests[0]?.body).toBe(refreshBody);
    }),
  );

  it.effect("refresh reports a revoked token with its status", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(
        () => new Response('{"error":"invalid_grant"}', { status: 401 }),
      );
      const error = yield* CodexOAuth.refreshToken({
        access: "old",
        refresh: "old-refresh",
        expires: 0,
      }).pipe(Effect.provideService(HttpClient.HttpClient, client), Effect.flip);
      expect(error.message).toBe('OpenAI Codex token refresh failed: 401 {"error":"invalid_grant"}');
    }),
  );
});
