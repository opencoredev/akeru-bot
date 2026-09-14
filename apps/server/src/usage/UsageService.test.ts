import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AkeruUsageReservationId,
  BotId,
  ProviderDriverKind,
  ThreadId,
  type AkeruUsageEntry,
  type SubscriptionProviderId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, describe, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ProviderUsageHistory } from "./ProviderUsageHistory.ts";
import * as UsageService from "./UsageService.ts";

vi.mock("../subscription-auth/service.ts", () => ({
  SubscriptionAuthService: {
    forSecretsDir: () => ({
      reload: () => {},
      statuses: () => [],
      getPlanAccessToken: async () => undefined,
    }),
  },
}));
vi.mock("./usagePlanLimits.ts", () => ({ readPlanLimits: async () => [] }));

afterEach(() => vi.restoreAllMocks());

const rateDocument = {
  "test-model": { input_cost_per_token: 0.001, output_cost_per_token: 0.002 },
};
const pricedStep = {
  model: "test-model",
  totals: {
    uncachedInputTokens: 100,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
  },
  reportedCostUsd: null,
};

const makeFixture = Effect.fnUntraced(function* (response: Effect.Effect<Response>) {
  const fs = yield* FileSystem.FileSystem;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-usage-test-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest("/tmp", baseDir)),
  );
  let fetches = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      fetches += 1;
      return HttpClientResponse.fromWeb(request, yield* response);
    }),
  );
  const service = yield* UsageService.make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(
      ProviderUsageHistory,
      ProviderUsageHistory.of({ readReported: () => Effect.succeed([]) }),
    ),
  );
  return { service, fetches: () => fetches };
});

function entry(provider: string): AkeruUsageEntry {
  return {
    reservationId: AkeruUsageReservationId.make(`usage-${provider}`),
    sourceKey: `turn:${provider}`,
    botId: BotId.make("bot-1"),
    threadId: ThreadId.make("thread-1"),
    turnId: null,
    category: "turn",
    state: "reported",
    reservedTokens: 200,
    inputTokens: 100,
    outputTokens: 20,
    reasoningTokens: 5,
    provider: ProviderDriverKind.make(provider),
    model: "test-model",
    unavailableReason: null,
    createdAt: "2026-09-13T12:00:00.000Z",
    settledAt: "2026-09-13T12:00:01.000Z",
  };
}

describe("usageRecordFromEntry", () => {
  it("drops ledger usage when its provider is not connected in Akeru", () => {
    expect(UsageService.usageRecordFromEntry(entry("codex"), new Set())).toBeNull();
  });

  it.each([
    ["claudeAgent", "anthropic", "claude"],
    ["codex", "openai-codex", "codex"],
    ["cursor", "cursor", "cursor"],
    ["grok", "xai", "grok"],
    ["kimi", "kimi-for-coding", "kimi"],
    ["opencode", "opencode-go", "opencode"],
    ["opencodeGo", "opencode-go", "opencode"],
  ] as const)("maps %s usage through its %s connection", (driver, connection, provider) => {
    const connected = new Set<SubscriptionProviderId>([connection]);
    expect(UsageService.usageRecordFromEntry(entry(driver), connected)).toMatchObject({
      provider,
      model: "test-model",
      sessionId: "thread-1",
      totals: { uncachedInputTokens: 100, outputTokens: 20, reasoningTokens: 5 },
    });
  });
});

it.layer(NodeServices.layer)("UsageService pricing", (it) => {
  it.effect("reads the usage ledger's filesystem identity", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-usage-volume-" });
      const databasePath = `${directory}/state.sqlite`;
      yield* fs.writeFileString(databasePath, "fixture");

      expect(yield* UsageService.readUsageStoreVolumeId(fs, databasePath)).toMatch(/^\d+:\d+$/);
      expect(yield* UsageService.readUsageStoreVolumeId(fs, `${directory}/missing.sqlite`)).toBe(
        "",
      );
    }),
  );

  it.effect("shares simultaneous cold pricing fetches", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<Response>();
      const { service, fetches } = yield* makeFixture(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      );
      const prices = yield* Effect.all(
        Array.from({ length: 8 }, () => service.priceStepUsage(pricedStep)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(fetches()).toBe(1);
      yield* Deferred.succeed(reply, Response.json(rateDocument));
      expect((yield* Fiber.join(prices)).every((price) => price.costSource === "modelPriced")).toBe(
        true,
      );
      expect(fetches()).toBe(1);
    }),
  );

  it.effect("backs off a failed refresh before retrying", () =>
    Effect.gen(function* () {
      let response = () => new Response("offline", { status: 503 });
      const { service, fetches } = yield* makeFixture(Effect.sync(() => response()));
      expect((yield* service.priceStepUsage(pricedStep)).costSource).toBe("unpriced");
      yield* TestClock.adjust(59_999);
      yield* service.priceStepUsage(pricedStep);
      expect(fetches()).toBe(1);
      response = () => Response.json(rateDocument);
      yield* TestClock.adjust(1);
      expect((yield* service.priceStepUsage(pricedStep)).costSource).toBe("modelPriced");
      expect(fetches()).toBe(2);
    }),
  );
});
