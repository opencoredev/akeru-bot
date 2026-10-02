import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as NodeFS from "node:fs";
import { fixture } from "./testUtils/subscriptionAuthStorage.ts";
import { makeTestSubscriptionAuthService } from "./testUtils/subscriptionAuthService.ts";

it.effect.each(["codex", "plan", "kimi"])(
  "refreshes persisted health during %s credential access",
  (access) =>
    Effect.gen(function* () {
      const { directory, authPath } = fixture();

      try {
        NodeFS.writeFileSync(
          authPath,
          JSON.stringify({
            "openai-codex": {
              type: "oauth",
              access: "access",
              refresh: "refresh",
              expires: Date.now() + 60_000,
              accountId: "account",
              connectionId: "connection",
            },
            "kimi-for-coding": {
              type: "oauth",
              access: "kimi-access",
              refresh: "kimi-refresh",
              expires: Date.now() + 60_000,
              deviceId: "0123456789abcdef0123456789abcdef",
            },
          }),
        );
        const reader = yield* Effect.promise(() => makeTestSubscriptionAuthService(authPath));
        const writer = yield* Effect.promise(() => makeTestSubscriptionAuthService(authPath));
        writer.recordRequestFailure(
          "openai-codex",
          "Token revoked",
          "2026-01-01T00:00:00.000Z",
          "revoked",
        );
        expect(reader.statuses().find((status) => status.provider === "openai-codex")?.health).toBe(
          "detected",
        );
        yield* Effect.promise(async () => {
          await Match.value(access).pipe(
            Match.when("codex", () => reader.getOpenAICodexAccess()),
            Match.when("plan", () => reader.getPlanAccess("openai-codex")),
            Match.orElse(() => reader.getKimiForCodingAccess()),
          );
        });
        expect(reader.statuses().find((status) => status.provider === "openai-codex")?.health).toBe(
          "revoked",
        );
      } finally {
        NodeFS.rmSync(directory, { recursive: true, force: true });
      }
    }),
);

it.effect("refreshes persisted health after a successful OAuth token refresh", () =>
  Effect.gen(function* () {
    const { directory, authPath } = fixture();

    try {
      NodeFS.writeFileSync(
        authPath,
        JSON.stringify({
          "openai-codex": {
            type: "oauth",
            access: "expired",
            refresh: "refresh",
            expires: 0,
            accountId: "account",
          },
        }),
      );
      const reader = yield* Effect.promise(() => makeTestSubscriptionAuthService(authPath));
      const writer = yield* Effect.promise(() => makeTestSubscriptionAuthService(authPath));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          writer.recordRequestFailure(
            "openai-codex",
            "Token revoked",
            "2026-01-01T00:00:00.000Z",
            "revoked",
          );

          return new Response(
            JSON.stringify({
              access_token: "refreshed",
              refresh_token: "rotated",
              expires_in: 3600,
            }),
            { status: 200 },
          );
        }),
      );
      expect(yield* Effect.promise(() => reader.getAccessToken("openai-codex"))).toBe("refreshed");
      expect(reader.statuses().find((status) => status.provider === "openai-codex")?.health).toBe(
        "revoked",
      );
    } finally {
      vi.unstubAllGlobals();
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  }),
);
