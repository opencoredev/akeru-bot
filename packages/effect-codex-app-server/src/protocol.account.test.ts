import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as CodexRpc from "./rpc.ts";
import * as CodexSchema from "./schema.ts";
import {
  decodeAccountTokenUsageResponse,
  decodeAccountRateLimitsResponse,
} from "./protocol.test-support.ts";

it.layer(NodeServices.layer)("effect-codex-app-server protocol", (it) => {
  it.effect("maps account usage responses to the upstream token usage schema", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/usage/read"],
        CodexSchema.V2GetAccountTokenUsageResponse,
      );
      const decoded = yield* decodeAccountTokenUsageResponse({
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
      assert.deepEqual(decoded, {
        dailyUsageBuckets: [{ startDate: "2026-06-10", tokens: 42 }],
        summary: { lifetimeTokens: 42 },
      });
    }),
  );

  it.effect("maps earned rate-limit reset credits from account rate-limit snapshots", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        CodexRpc.CLIENT_REQUEST_RESPONSES["account/rateLimits/read"],
        CodexSchema.V2GetAccountRateLimitsResponse,
      );

      const response = {
        rateLimits: {},
        rateLimitResetCredits: {
          availableCount: 2,
          credits: [
            {
              id: "RateLimitResetCredit_1",
              resetType: "codexRateLimits",
              status: "available",
              grantedAt: 1_781_654_400,
              expiresAt: 1_784_246_400,
              title: "Full reset",
              description: "Ready to redeem",
            },
            {
              id: "RateLimitResetCredit_2",
              resetType: "unknown",
              status: "unknown",
              grantedAt: 1_781_654_401,
              expiresAt: null,
            },
          ],
        },
      } as const;

      assert.deepEqual(yield* decodeAccountRateLimitsResponse(response), response);
      assert.deepEqual(
        yield* decodeAccountRateLimitsResponse({
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        }),
        {
          rateLimits: {},
          rateLimitResetCredits: { availableCount: 2, credits: null },
        },
      );
    }),
  );
});
