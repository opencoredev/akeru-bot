import type * as RpcGroup from "effect/unstable/rpc/RpcGroup";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import {
  AkeruBotUsageReadError,
  RoutineReadError,
  RoutineThreadReadError,
  type SubscriptionProviderId,
  WS_METHODS,
  WsRpcGroup,
} from "@akeru/contracts";

import type { WsConnection } from "./wsConnection.ts";

export const createWsBotServicesHandlers = ({
  projectionBots,
  botUsageLedger,
  routineRepository,
  providerRegistry,
  botInbox,
  usage,
  getAccessHealthSnapshot,
  observeRpcEffect,
}: Pick<
  WsConnection,
  | "projectionBots"
  | "botUsageLedger"
  | "routineRepository"
  | "providerRegistry"
  | "botInbox"
  | "usage"
  | "getAccessHealthSnapshot"
  | "observeRpcEffect"
>) =>
  ({
    [WS_METHODS.routinesListRuns]: (input) =>
      observeRpcEffect(
        WS_METHODS.routinesListRuns,
        routineRepository.listRuns(input.routineId).pipe(
          Effect.map((runs) => ({ runs })),
          Effect.mapError(
            (cause) =>
              new RoutineReadError({
                routineId: input.routineId,
                message: cause.message,
              }),
          ),
        ),
        { "rpc.aggregate": "routines" },
      ),

    [WS_METHODS.routinesListThreadRuns]: (input) =>
      observeRpcEffect(
        WS_METHODS.routinesListThreadRuns,
        routineRepository.listThreadRuns(input.threadId, input.beforeRunId).pipe(
          Effect.mapError(
            (cause) =>
              new RoutineThreadReadError({
                threadId: input.threadId,
                message: cause.message,
              }),
          ),
        ),
        { "rpc.aggregate": "routines" },
      ),

    [WS_METHODS.botInboxList]: (_input) =>
      observeRpcEffect(
        WS_METHODS.botInboxList,
        getAccessHealthSnapshot().pipe(
          Effect.map(({ inbox }) => inbox.filter((item) => item.status === "open")),
        ),
        { "rpc.aggregate": "bot" },
      ),

    [WS_METHODS.botInboxResolve]: ({ id }) =>
      observeRpcEffect(
        WS_METHODS.botInboxResolve,
        Effect.sync(() => {
          botInbox.resolveById(id);
        }),
        { "rpc.aggregate": "bot" },
      ),

    [WS_METHODS.botUsage]: (input) =>
      observeRpcEffect(
        WS_METHODS.botUsage,
        Effect.gen(function* () {
          const bot = yield* projectionBots.getById({ botId: input.botId }).pipe(
            Effect.mapError(
              (cause) =>
                new AkeruBotUsageReadError({
                  botId: input.botId,
                  detail: cause.message,
                }),
            ),
          );

          if (Option.isNone(bot)) {
            return yield* new AkeruBotUsageReadError({
              botId: input.botId,
              detail: `Bot ${input.botId} was not found.`,
            });
          }

          const summary = yield* botUsageLedger.summarize(input.botId).pipe(
            Effect.mapError(
              (cause) =>
                new AkeruBotUsageReadError({
                  botId: input.botId,
                  detail: cause.message,
                }),
            ),
          );

          const pricingTotals = yield* botUsageLedger
            .pricingTotals(input.botId)
            .pipe(
              Effect.mapError(
                (cause) =>
                  new AkeruBotUsageReadError({ botId: input.botId, detail: cause.message }),
              ),
            );

          const priced = yield* Effect.forEach(pricingTotals.models, (entry) =>
            usage.priceStepUsage({
              model: entry.model,
              totals: {
                uncachedInputTokens: Math.max(
                  0,
                  entry.inputTokens - entry.cachedInputTokens - entry.cacheCreationTokens,
                ),
                cachedInputTokens: entry.cachedInputTokens,
                cacheCreationTokens: entry.cacheCreationTokens,
                outputTokens: entry.outputTokens,
                reasoningTokens: Math.min(entry.reasoningTokens, entry.outputTokens),
              },
              reportedCostUsd: null,
            }),
          );

          const estimatedCost =
            pricingTotals.complete &&
            pricingTotals.models.length > 0 &&
            priced.every((entry) => entry.costSource !== "unpriced")
              ? {
                  status: "available" as const,
                  usd: priced.reduce((total, entry) => total + entry.costUsd, 0),
                }
              : { status: "unavailable" as const, usd: null };

          const driverConnection = {
            claude: "anthropic",
            claudeAgent: "anthropic",
            codex: "openai-codex",
            grok: "xai",
            kimi: "kimi-for-coding",
            opencode: "opencode-go",
            opencodeGo: "opencode-go",
          } satisfies Record<string, Exclude<SubscriptionProviderId, "cursor">>;

          const providers = yield* providerRegistry.getProviders;

          const driver = bot.value.engine
            ? (providers.find((provider) => provider.instanceId === bot.value.engine?.provider)
                ?.driver ?? bot.value.engine.provider)
            : undefined;

          const connection =
            driver === undefined
              ? undefined
              : Object.entries(driverConnection).find(([key]) => key === driver)?.[1];

          const planLimits =
            connection === undefined
              ? []
              : yield* usage
                  .readPlanLimits(connection)
                  .pipe(Effect.catchCause(() => Effect.succeed([])));

          const plan = planLimits[0];

          const window =
            plan?.status === "ok"
              ? (plan.windows.find(
                  (candidate: { readonly kind: string }) => candidate.kind === "session",
                ) ?? plan.windows[0])
              : undefined;

          const subscriptionPool = window
            ? {
                status: "available" as const,
                used: Math.round(window.usedPercent),
                limit: 100,
                unit: "percent",
              }
            : { status: "unavailable" as const, used: null, limit: null, unit: null };

          return {
            ...summary,
            estimatedCost,
            subscriptionPool,
          };
        }),
        { "rpc.aggregate": "bot" },
      ),
  }) satisfies Pick<
    RpcGroup.HandlersFrom<RpcGroup.Rpcs<typeof WsRpcGroup>>,
    | typeof WS_METHODS.routinesListRuns
    | typeof WS_METHODS.routinesListThreadRuns
    | typeof WS_METHODS.botInboxList
    | typeof WS_METHODS.botInboxResolve
    | typeof WS_METHODS.botUsage
  >;
