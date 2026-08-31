import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { AkeruBotUsageSnapshot } from "./akeruUsage.ts";

it.effect("decodes bot usage with unavailable provider totals", () =>
  Effect.gen(function* () {
    const snapshot = yield* Schema.decodeUnknownEffect(AkeruBotUsageSnapshot)({
      botId: "bot-1",
      consumedTokens: 12,
      reservedTokens: 32,
      measurements: {
        input: { tokens: 5, unavailableEntries: 0 },
        output: { tokens: 7, unavailableEntries: 0 },
        observer: { tokens: 0, unavailableEntries: 1 },
        reflector: { tokens: 0, unavailableEntries: 1 },
      },
      entries: [],
      usageCap: { unit: "tokens", limit: 1_000 },
      estimatedCost: { status: "unavailable", usd: null },
      subscriptionPool: { status: "unavailable", used: null, limit: null, unit: null },
    });

    assert.strictEqual(snapshot.usageCap?.limit, 1_000);
    assert.strictEqual(snapshot.estimatedCost.status, "unavailable");
  }),
);
