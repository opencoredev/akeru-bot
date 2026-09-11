import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { UsageDay, type UsageSummaryInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { afterEach, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageService from "./UsageService.ts";
import * as TranscriptReader from "./usageTranscriptReader.ts";

vi.mock("../subscription-auth/service.ts", () => ({
  SubscriptionAuthService: {
    forSecretsDir: () => ({ reload: () => {}, getPlanAccessToken: async () => undefined }),
  },
}));
vi.mock("./usagePlanLimits.ts", () => ({ readPlanLimits: async () => [] }));

afterEach(() => vi.restoreAllMocks());

const DAY = 24 * 60 * 60 * 1000;
const rateDocument = {
  "claude-fable-5": { input_cost_per_token: 0.001, output_cost_per_token: 0.002 },
};
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const input: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-09-07"),
  untilDay: UsageDay.make("2026-09-07"),
  timeZone: "UTC",
};
const step = {
  model: "claude-fable-5",
  totals: {
    uncachedInputTokens: 100,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 20,
    reasoningTokens: 0,
  },
  reportedCostUsd: null,
};
const transcript =
  encodeJson({
    type: "assistant",
    timestamp: "2026-09-07T04:05:13.944Z",
    sessionId: "session",
    message: {
      id: "message",
      model: "claude-fable-5",
      usage: { input_tokens: 100, output_tokens: 20 },
    },
  }) + "\n";

const makeFixture = Effect.fnUntraced(function* (
  options: {
    response?: Effect.Effect<Response>;
    diskRates?: { fetchedAtMs: number; document: unknown };
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "akeru-usage-test-" });
  const config = yield* ServerConfig.ServerConfig.pipe(
    Effect.provide(ServerConfig.layerTest("/tmp", baseDir)),
  );
  const claude = path.join(config.baseDir, "claude");
  const projects = path.join(claude, "projects");
  yield* fs.makeDirectory(projects, { recursive: true });
  const transcriptPath = path.join(projects, "session.jsonl");
  yield* fs.writeFileString(transcriptPath, transcript);
  const ratesPath = path.join(config.stateDir, "usage-model-rates.json");
  if (options.diskRates) yield* fs.writeFileString(ratesPath, encodeJson(options.diskRates));
  const persisted = yield* Deferred.make<void>();
  let fetches = 0;
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      fetches += 1;
      const response = yield* options.response ?? Effect.succeed(Response.json(rateDocument));
      return HttpClientResponse.fromWeb(request, response);
    }),
  );
  const service = yield* UsageService.make.pipe(
    Effect.provideService(ServerConfig.ServerConfig, config),
    Effect.provideService(HttpClient.HttpClient, client),
    Effect.provideService(FileSystem.FileSystem, {
      ...fs,
      writeFileString: (target, contents, settings) =>
        fs
          .writeFileString(target, contents, settings)
          .pipe(
            Effect.tap(() =>
              target === ratesPath ? Deferred.succeed(persisted, undefined) : Effect.void,
            ),
          ),
    }),
    Effect.provide(
      ServerSettings.layerTest({
        providers: {
          claudeAgent: { homePath: claude },
          codex: { homePath: path.join(config.baseDir, "codex") },
        },
      }),
    ),
  );
  return {
    service,
    fetches: () => fetches,
    persisted: Deferred.await(persisted),
    transcriptPath,
    fs,
  };
});

it.layer(NodeServices.layer)("UsageService single-flight", (it) => {
  it.effect("shares simultaneous cold summaries, transcript scans, and step pricing", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<Response>();
      const { service, fetches } = yield* makeFixture({
        response: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      });
      const walks = vi.spyOn(TranscriptReader, "listTranscriptFiles");
      const reads = vi.spyOn(TranscriptReader, "readTranscriptRecords");
      const summaries = yield* Effect.all(
        Array.from({ length: 8 }, () => service.readSummary(input)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      const prices = yield* Effect.all(
        Array.from({ length: 8 }, () => service.priceStepUsage(step)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      expect(fetches()).toBe(1);
      yield* Deferred.succeed(reply, Response.json(rateDocument));
      const results = yield* Fiber.join(summaries);
      expect((yield* Fiber.join(prices)).every((price) => price.costSource === "modelPriced")).toBe(
        true,
      );
      expect(results.every((result) => result === results[0])).toBe(true);
      expect(walks).toHaveBeenCalledTimes(1);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(results[0]!.pricing.status).toBe("fresh");
      expect(fetches()).toBe(1);
      yield* service.readSummary(input);
      expect(walks).toHaveBeenCalledTimes(2);
      expect(reads).toHaveBeenCalledTimes(1);
    }),
  );

  it.effect("keeps a shared scan alive when its first caller disconnects", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<Response>();
      const { service, fetches } = yield* makeFixture({
        response: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      });
      const first = yield* service.readSummary(input).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const remaining = yield* service.readSummary(input).pipe(Effect.forkChild);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(reply, Response.json(rateDocument));
      const summary = yield* Fiber.join(remaining);
      expect(summary.pricing.status).toBe("fresh");
      expect(summary.sources[0]!.scannedFiles).toBe(1);
      expect(fetches()).toBe(1);
    }),
  );

  it.effect("keeps a shared pricing refresh alive when its first step caller disconnects", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<Response>();
      const { service, fetches } = yield* makeFixture({
        response: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      });
      const first = yield* service.priceStepUsage(step).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const remaining = yield* service.priceStepUsage(step).pipe(Effect.forkChild);
      yield* Fiber.interrupt(first);
      yield* Deferred.succeed(reply, Response.json(rateDocument));
      expect((yield* Fiber.join(remaining)).costSource).toBe("modelPriced");
      expect(fetches()).toBe(1);
    }),
  );

  it.effect(
    "shares per-file parsing across different summary windows without sharing aggregates",
    () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const { service } = yield* makeFixture({
          diskRates: { fetchedAtMs: now, document: rateDocument },
        });
        const reads = vi.spyOn(TranscriptReader, "readTranscriptRecords");
        const results = yield* Effect.all(
          [
            service.readSummary(input),
            service.readSummary({
              ...input,
              sinceDay: UsageDay.make("2026-09-06"),
              timeZone: "America/New_York",
            }),
          ],
          { concurrency: "unbounded" },
        );
        expect(reads).toHaveBeenCalledTimes(1);
        expect(results[0]!.timeZone).toBe("UTC");
        expect(results[1]!.timeZone).toBe("America/New_York");
      }),
  );

  it.effect(
    "shares failures, backs off repeated HTTP and malformed responses, and resets after success",
    () =>
      Effect.gen(function* () {
        let response = () => new Response("offline", { status: 503 });
        const { service, fetches } = yield* makeFixture({
          response: Effect.sync(() => response()),
        });
        const failed = yield* Effect.all(
          Array.from({ length: 8 }, () => service.readSummary(input)),
          { concurrency: "unbounded" },
        );
        expect(fetches()).toBe(1);
        expect(failed[0]!.pricing.status).toBe("unavailable");
        yield* service.priceStepUsage(step);
        yield* TestClock.adjust(59_999);
        yield* service.priceStepUsage(step);
        expect(fetches()).toBe(1);
        yield* TestClock.adjust(1);
        response = () => Response.json({ invalid: {} });
        yield* service.priceStepUsage(step);
        expect(fetches()).toBe(2);
        yield* TestClock.adjust(119_999);
        yield* service.priceStepUsage(step);
        expect(fetches()).toBe(2);
        yield* TestClock.adjust(1);
        response = () => Response.json(rateDocument);
        expect((yield* service.priceStepUsage(step)).costSource).toBe("modelPriced");
        expect(fetches()).toBe(3);
        expect((yield* service.readSummary(input)).pricing.status).toBe("fresh");
        expect(fetches()).toBe(3);
      }),
  );

  it.effect("shares a timed-out fetch and waits for the failure backoff before retrying", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      let response: Effect.Effect<Response> = Effect.never;
      const { service, fetches } = yield* makeFixture({
        response: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.suspend(() => response)),
        ),
      });
      const prices = yield* Effect.all(
        Array.from({ length: 4 }, () => service.priceStepUsage(step)),
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* TestClock.adjust(10_000);
      expect((yield* Fiber.join(prices)).every((price) => price.costSource === "unpriced")).toBe(
        true,
      );
      expect((yield* service.readSummary(input)).pricing.status).toBe("unavailable");
      yield* TestClock.adjust(59_999);
      yield* service.priceStepUsage(step);
      expect(fetches()).toBe(1);
      response = Effect.succeed(Response.json(rateDocument));
      yield* TestClock.adjust(1);
      expect((yield* service.priceStepUsage(step)).costSource).toBe("modelPriced");
      expect(fetches()).toBe(2);
    }),
  );

  it.effect("interrupts a detached stale-pricing refresh when the service scope closes", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(2 * DAY);
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();
      const scope = yield* Scope.make();
      const { service, fetches } = yield* makeFixture({
        diskRates: { fetchedAtMs: 0, document: rateDocument },
        response: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(stopped, undefined)),
        ),
      }).pipe(Effect.provideService(Scope.Scope, scope));
      expect((yield* service.priceStepUsage(step)).costSource).toBe("modelPriced");
      yield* Deferred.await(started);
      yield* Scope.close(scope, Exit.void);
      yield* Deferred.await(stopped);
      expect(fetches()).toBe(1);
    }),
  );

  it.effect("serves stale prices immediately with cached status while one refresh is blocked", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(2 * DAY);
      const started = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<Response>();
      const { service, fetches, persisted } = yield* makeFixture({
        diskRates: { fetchedAtMs: 0, document: rateDocument },
        response: Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      });
      const summary = yield* service.readSummary(input);
      yield* Deferred.await(started);
      expect(summary.pricing).toMatchObject({
        status: "cached",
        fetchedAt: "1970-01-01T00:00:00.000Z",
        knownModels: 1,
      });
      const prices = yield* Effect.all(
        Array.from({ length: 8 }, () => service.priceStepUsage(step)),
        { concurrency: "unbounded" },
      );
      expect(prices.every((price) => price.costSource === "modelPriced")).toBe(true);
      expect(fetches()).toBe(1);
      yield* Deferred.succeed(reply, Response.json(rateDocument));
      yield* persisted;
      expect((yield* service.readSummary(input)).pricing.status).toBe("fresh");
    }),
  );

  it.effect(
    "marks a once-fresh table cached before failed refreshes and keeps its successful timestamp",
    () =>
      Effect.gen(function* () {
        let response = () => Response.json(rateDocument);
        const { service, fetches } = yield* makeFixture({
          response: Effect.sync(() => response()),
        });
        const fresh = yield* service.readSummary(input);
        yield* TestClock.adjust(DAY);
        response = () => new Response("offline", { status: 503 });
        const stale = yield* service.readSummary(input);
        expect(stale.pricing.status).toBe("cached");
        expect(stale.pricing.fetchedAt).toBe(fresh.pricing.fetchedAt);
        expect(stale.pricing.knownModels).toBe(1);
        yield* service.readSummary(input);
        expect(fetches()).toBe(2);
      }),
  );

  it.effect("does not cache failed transcript reads and reparses changed files", () =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const { service, transcriptPath, fs } = yield* makeFixture({
        diskRates: { fetchedAtMs: now, document: rateDocument },
      });
      const reads = vi.spyOn(TranscriptReader, "readTranscriptRecords").mockResolvedValueOnce(null);
      const failed = yield* service.readSummary(input);
      expect(failed.sources[0]!.scannedFiles).toBe(0);
      const retried = yield* service.readSummary(input);
      expect(retried.sources[0]!.scannedFiles).toBe(1);
      yield* fs.writeFileString(
        transcriptPath,
        transcript + transcript.replace('"message"', '"second"'),
      );
      yield* service.readSummary(input);
      expect(reads).toHaveBeenCalledTimes(3);
    }),
  );
});
