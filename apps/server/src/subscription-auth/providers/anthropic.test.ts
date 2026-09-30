import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/unstable/http";
import { describe } from "vite-plus/test";

import { scriptedHttpClient } from "../testUtils/scriptedHttpClient.ts";
import { AnthropicOAuth } from "./anthropic.ts";

const tokens = { access_token: "access", refresh_token: "refresh", expires_in: 3600 };

describe("Anthropic OAuth", () => {
  it.effect("exchanges a pasted code#state for credentials", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() => Response.json(tokens));
      const result = yield* AnthropicOAuth.completeLogin("the-code#verifier", "verifier").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(result).toEqual({ access: "access", refresh: "refresh", expires: 3_300_000 });
      expect(requests[0]?.json).toMatchObject({
        grant_type: "authorization_code",
        code: "the-code",
        code_verifier: "verifier",
      });
    }),
  );

  it.effect("rejects a mismatched state before any request", () =>
    Effect.gen(function* () {
      const { client, requests } = scriptedHttpClient(() => Response.json(tokens));
      const error = yield* AnthropicOAuth.completeLogin("the-code#other", "verifier").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(requests).toHaveLength(0);
      expect(error).toMatchObject({
        _tag: "SubscriptionAuthInputError",
        message: "Invalid authorization state",
      });
    }),
  );

  it.effect("reports a rejected refresh with its status", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => new Response("invalid_grant", { status: 400 }));
      const error = yield* AnthropicOAuth.refreshToken("refresh").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error).toMatchObject({
        _tag: "SubscriptionAuthRequestError",
        status: 400,
        message: "Anthropic token refresh failed: 400 invalid_grant",
      });
    }),
  );

  it.effect("rejects a token response with missing fields", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => Response.json({ access_token: "access" }));
      const error = yield* AnthropicOAuth.refreshToken("refresh").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
      );
      expect(error._tag).toBe("SubscriptionAuthResponseError");
    }),
  );

  it.effect("times out a stalled token request", () =>
    Effect.gen(function* () {
      const { client } = scriptedHttpClient(() => Effect.never);
      const fiber = yield* AnthropicOAuth.refreshToken("refresh").pipe(
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.flip,
        Effect.forkChild,
      );
      yield* TestClock.adjust("15 seconds");
      const error = yield* Fiber.join(fiber);
      expect(error.message).toBe("Anthropic token refresh timed out after 15s");
    }),
  );
});
