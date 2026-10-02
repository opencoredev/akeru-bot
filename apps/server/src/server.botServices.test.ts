import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  BotId,
  RoutineId,
  RoutineRunId,
  type RoutineRun,
  ThreadId,
  WS_METHODS,
} from "@akeru/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";
import * as ProjectionBots from "./persistence/Services/ProjectionBots.ts";
import { type BotUsageLedgerShape } from "./usage/BotUsageLedger.ts";

import { buildAppUnderTest } from "./serverTestApp.ts";
import { getWsServerUrl, withWsRpcClient } from "./serverTestClients.ts";

it.layer(NodeServices.layer)("server router seam", (it) => {
  it.effect("pages routine runs for one chat beyond the shell snapshot cap", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("routine-history-thread");
      const routineId = RoutineId.make("routine-history");

      const runs: RoutineRun[] = Array.from({ length: 151 }, (_, index) => ({
        id: RoutineRunId.make(`history-run-${index}`),
        routineId,
        procedureVersion: 1,
        trigger: "manual",
        scheduledFor: null,
        status: "completed",
        result: null,
        failure: null,
        usageRef: null,
        threadRef: threadId,
        startedAt: "2026-09-29T00:00:00.000Z",
        completedAt: "2026-09-29T00:01:00.000Z",
        createdAt: new Date(Date.UTC(2026, 8, 29, 0, index)).toISOString(),
        updatedAt: "2026-09-29T00:01:00.000Z",
      }));

      yield* buildAppUnderTest({
        layers: {
          routineRepository: {
            listThreadRuns: (id, beforeRunId) => {
              if (id !== threadId) return Effect.succeed({ runs: [], nextCursor: null });
              const start = beforeRunId ? runs.findIndex((run) => run.id === beforeRunId) + 1 : 0;
              const page = runs.slice(start, start + 100);

              return Effect.succeed({
                runs: page,
                nextCursor: start + page.length < runs.length ? (page.at(-1)?.id ?? null) : null,
              });
            },
          },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const first = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) => client[WS_METHODS.routinesListThreadRuns]({ threadId })),
      );

      assert.equal(first.runs.length, 100);
      assert.equal(first.nextCursor, runs[99]?.id);

      const second = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          client[WS_METHODS.routinesListThreadRuns]({ threadId, beforeRunId: first.nextCursor! }),
        ),
      );

      assert.deepEqual(
        [...first.runs, ...second.runs].map((run) => run.id),
        runs.map((run) => run.id),
      );
      assert.equal(second.nextCursor, null);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("publishes typed per-bot usage with the server-owned cap", () =>
    Effect.gen(function* () {
      const botId = BotId.make("bot-usage-rpc");
      const missingBotId = BotId.make("bot-usage-missing");

      const summarize = vi.fn<BotUsageLedgerShape["summarize"]>(() =>
        Effect.succeed({
          botId,
          consumedTokens: 1_500,
          reservedTokens: 32_000,
          measurements: {
            input: { tokens: 1_000, unavailableEntries: 1 },
            output: { tokens: 500, unavailableEntries: 1 },
            observer: { tokens: 120, unavailableEntries: 0 },
            reflector: { tokens: 80, unavailableEntries: 1 },
          },
          entries: [],
        }),
      );

      const bot = {
        botId,
        name: "Usage bot",
        title: "Usage bot",
        label: null,
        description: null,
        disabledMcpServerIds: [],
        avatar: { kind: "dither" as const, seed: "usage-bot" },
        engine: { provider: "codex-work", model: "gpt-5.6-sol" },
        sandbox: "local",
        runtimeMode: "approval-required" as const,
        usageCap: { unit: "tokens" as const, limit: 64_000 },
        imageProvider: null,
        voiceEnabled: false,
        groupId: null,
        archivedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      } satisfies ProjectionBots.ProjectionBot;

      yield* buildAppUnderTest({
        layers: {
          providerRegistry: {
            getProviders: Effect.succeed([{ instanceId: "codex-work", driver: "codex" } as never]),
          },
          projectionBots: {
            getById: ({ botId: requestedBotId }) =>
              Effect.succeed(requestedBotId === botId ? Option.some(bot) : Option.none()),
          },
          botUsageLedger: { summarize },
        },
      });

      const wsUrl = yield* getWsServerUrl("/ws");

      const result = yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const usage = yield* client[WS_METHODS.botUsage]({ botId });

            const missing = yield* client[WS_METHODS.botUsage]({ botId: missingBotId }).pipe(
              Effect.flip,
            );

            return { usage, missing };
          }),
        ),
      );

      assert.deepEqual(result.usage.usageCap, { unit: "tokens", limit: 64_000 });
      assert.equal(result.usage.consumedTokens, 1_500);
      assert.equal(result.usage.reservedTokens, 32_000);
      assert.deepEqual(result.usage.measurements, {
        input: { tokens: 1_000, unavailableEntries: 1 },
        output: { tokens: 500, unavailableEntries: 1 },
        observer: { tokens: 120, unavailableEntries: 0 },
        reflector: { tokens: 80, unavailableEntries: 1 },
      });
      assert.deepEqual(result.usage.estimatedCost, { status: "unavailable", usd: null });
      assert.deepEqual(result.usage.subscriptionPool, {
        status: "unavailable",
        used: null,
        limit: null,
        unit: null,
      });
      assert.equal(result.missing._tag, "AkeruBotUsageReadError");
      assert.deepEqual(summarize.mock.calls, [[botId]]);
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );

  it.effect("syncs connector incidents through botInbox.list", () =>
    Effect.gen(function* () {
      const bot = {
        botId: BotId.make("bot-akeru"),
        name: "Akeru",
        title: "Research bot",
        label: null,
        description: null,
        disabledMcpServerIds: [],
        avatar: { kind: "dither" as const, seed: "akeru" },
        engine: { provider: "grok", model: "grok-4.6" },
        sandbox: null,
        runtimeMode: "approval-required" as const,
        usageCap: null,
        imageProvider: null,
        voiceEnabled: false,
        groupId: null,
        archivedAt: null,
        createdAt: "2026-08-30T20:00:00.000Z",
        updatedAt: "2026-08-30T20:00:00.000Z",
      } satisfies ProjectionBots.ProjectionBot;

      const config = yield* buildAppUnderTest({
        layers: {
          projectionBots: {
            listAll: () => Effect.succeed([bot]),
          },
        },
      });

      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const authPath = path.join(config.secretsDir, "subscription-auth.json");
      yield* fileSystem.makeDirectory(config.secretsDir, { recursive: true });
      yield* fileSystem.writeFileString(
        authPath,
        JSON.stringify({ xai: { type: "oauth", access: "a", refresh: "r", expires: 4e12 } }),
      );
      yield* fileSystem.writeFileString(
        `${authPath}.health`,
        JSON.stringify({
          xai: {
            lastFailedRequest: {
              at: "2026-08-30T20:00:00.000Z",
              message: "The first request failed.",
            },
            failureKind: "request",
          },
        }),
      );

      const wsUrl = yield* getWsServerUrl("/ws");
      yield* Effect.scoped(
        withWsRpcClient(wsUrl, (client) =>
          Effect.gen(function* () {
            const failed = yield* client[WS_METHODS.botInboxList]({});
            assert.equal(failed.length, 1);
            assert.equal(failed[0]?.kind, "connector-failure");
            assert.equal(failed[0]?.status, "open");
            assert.equal(failed[0]?.botId, bot.botId);
            assert.equal(failed[0]?.lastFailure, "The first request failed.");

            yield* client[WS_METHODS.botInboxResolve]({ id: failed[0]!.id });
            assert.deepEqual(yield* client[WS_METHODS.botInboxList]({}), []);

            yield* fileSystem.writeFileString(
              `${authPath}.health`,
              JSON.stringify({
                xai: {
                  lastSuccessfulRequestAt: "2026-08-30T20:01:00.000Z",
                  lastFailedRequest: {
                    at: "2026-08-30T20:00:00.000Z",
                    message: "The first request failed.",
                  },
                  failureKind: "request",
                },
              }),
            );

            assert.deepEqual(yield* client[WS_METHODS.botInboxList]({}), []);

            yield* fileSystem.writeFileString(
              `${authPath}.health`,
              JSON.stringify({
                xai: {
                  lastFailedRequest: {
                    at: "2026-08-30T20:02:00.000Z",
                    message: "The first request failed.",
                  },
                  failureKind: "request",
                },
              }),
            );

            const reopened = yield* client[WS_METHODS.botInboxList]({});
            assert.equal(reopened.length, 1);
            assert.notEqual(reopened[0]?.id, failed[0]?.id);
          }),
        ),
      );
    }).pipe(Effect.provide(NodeHttpServer.layerTest)),
  );
});
