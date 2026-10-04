import * as Predicate from "effect/Predicate";
import type { SubscriptionProviderId, UsageProviderPlanLimits } from "@akeru/contracts";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import {
  type LiveSubscriptionProviderId,
  PLAN_PROVIDER_ORDER,
  type GetPlanAccess,
} from "./usagePlanTypes.ts";
import { fetchProvider } from "./usagePlanFetch.ts";

const PLAN_LIMIT_TTL = Duration.minutes(5);

// Failure backoff is the cache TTL: a failed or unavailable read keeps serving
// the last good windows and is not retried until this shorter expiry lapses.
const PLAN_LIMIT_FAILURE_BACKOFF = Duration.minutes(1);

type CachedPlanLimits = {
  readonly limits: UsageProviderPlanLimits;
  readonly fresh: boolean;
};

function makePlanLimitCache(getPlanAccess: GetPlanAccess) {
  const lastGoodPlanLimits = new Map<string, UsageProviderPlanLimits>();
  const providerKeys = new Map<LiveSubscriptionProviderId, string>();

  const connections = new Map<
    string,
    { readonly accessToken: string; readonly provider: LiveSubscriptionProviderId }
  >();

  const cache = Cache.makeWith<string, CachedPlanLimits>(
    (key) =>
      Effect.promise(async () => {
        const connection = connections.get(key);

        if (connection === undefined) throw new Error("Plan account is disconnected.");
        const { provider, accessToken } = connection;

        try {
          const fresh = await fetchProvider(provider, accessToken);

          if (fresh !== null) {
            if (providerKeys.get(provider) === key) lastGoodPlanLimits.set(key, fresh);

            return { limits: fresh, fresh: true };
          }
        } catch {
          // Keep the last good windows during provider failures.
        }

        return {
          limits: lastGoodPlanLimits.get(key) ?? emptyConnectedLimits(provider),
          fresh: false,
        };
      }),
    {
      capacity: PLAN_PROVIDER_ORDER.length * 2,
      timeToLive: (exit) =>
        Predicate.isTagged(exit, "Success") && exit.value.fresh
          ? PLAN_LIMIT_TTL
          : PLAN_LIMIT_FAILURE_BACKOFF,
    },
  );

  // A disconnected provider, or one reconnected with a different account, drops its cached and
  // last-good meters instead of serving the old account's windows for the rest of the TTL.
  return Effect.map(cache, (entries) => {
    const forget = (key: string) => {
      lastGoodPlanLimits.delete(key);
      connections.delete(key);

      return Cache.invalidate(entries, key);
    };

    return {
      read: (provider: LiveSubscriptionProviderId) =>
        Effect.promise(() => getPlanAccess(provider).catch(() => null)).pipe(
          Effect.flatMap((access) =>
            Effect.gen(function* () {
              const previous = providerKeys.get(provider);

              if (access === undefined) {
                providerKeys.delete(provider);

                if (previous !== undefined) yield* forget(previous);

                return null;
              }

              // Without a known stored account, no cached meters can be attributed to it.
              if (access === null) return emptyConnectedLimits(provider);
              const key = `${provider}:${access.accountId}`;

              if (previous !== undefined && previous !== key) yield* forget(previous);
              providerKeys.set(provider, key);

              // A temporarily unavailable token keeps this same account's last good meters.
              if (access.accessToken === null)
                return lastGoodPlanLimits.get(key) ?? emptyConnectedLimits(provider);
              connections.set(key, { accessToken: access.accessToken, provider });

              return (yield* Cache.get(entries, key)).limits;
            }),
          ),
        ),
    };
  });
}

function emptyConnectedLimits(provider: LiveSubscriptionProviderId): UsageProviderPlanLimits {
  return {
    provider,
    status: "ok",
    plan: null,
    message: null,
    windows: [],
  };
}

export function planLimitsReader(getPlanAccess: GetPlanAccess) {
  return Effect.map(
    makePlanLimitCache(getPlanAccess),
    (cache) => (provider?: SubscriptionProviderId) =>
      Effect.all(
        (provider === undefined ? PLAN_PROVIDER_ORDER : [provider]).map((selected) =>
          cache.read(selected),
        ),

        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((results) =>
          results.filter((entry): entry is UsageProviderPlanLimits => entry !== null),
        ),
      ),
  );
}

export function readPlanLimitsEffect(getPlanAccess: GetPlanAccess) {
  return Effect.flatMap(planLimitsReader(getPlanAccess), (read) => read());
}

export async function readPlanLimits(getPlanAccess: GetPlanAccess) {
  return Effect.runPromise(readPlanLimitsEffect(getPlanAccess));
}

export type { PlanAccess } from "./usagePlanTypes.ts";

export type { GetPlanAccess } from "./usagePlanTypes.ts";

export { parseClaudeUsage } from "./usagePlanParsers.ts";

export { parseCodexUsage } from "./usagePlanParsers.ts";

export { parseGrokUsage } from "./usagePlanParsers.ts";

export { parseKimiUsage } from "./usagePlanParsers.ts";
