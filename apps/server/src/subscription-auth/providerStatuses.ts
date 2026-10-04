import type { SubscriptionAccountState } from "./accountState.ts";
import { codexPlanFromToken } from "./providers/openaiCodex.ts";
import type { BotId, ProviderInstanceId } from "@akeru/contracts";
import * as DateTime from "effect/DateTime";
import * as Predicate from "effect/Predicate";
import type { CredentialStoreState } from "./credentialStore.ts";
import {
  SUBSCRIPTION_PROVIDER_IDS,
  HEALTH_CHECK_STALE_MS,
  lastGoodWarning,
  storeErrorStatus,
  credentialKey,
  accountScope,
  credentialAt,
  type SubscriptionProviderId,
  type ProviderHealthData,
  type ProviderStatus,
} from "./serviceTypes.ts";

export function statusForKey(
  credentialState: CredentialStoreState,
  healthData: ProviderHealthData,
  provider: SubscriptionProviderId,
  key: string,
  dependentBots: ReadonlyArray<{
    readonly id: BotId;
    readonly name: string;
    readonly provider: SubscriptionProviderId;
  }>,
  now: number,
  instanceId?: ProviderInstanceId,
): ProviderStatus {
  const { data, loadError, loadErrorAt, servingLastGood } = credentialState;
  const damagedAt = loadErrorAt ?? DateTime.formatIso(DateTime.makeUnsafe(now));

  const credentialWarning =
    loadError && servingLastGood
      ? { at: damagedAt, message: lastGoodWarning(loadError) }
      : undefined;

  if (loadError && !servingLastGood) {
    return storeErrorStatus(provider, { at: damagedAt, message: loadError.message }, dependentBots);
  }

  const credential = credentialAt(data, key);
  const health = healthData[key];
  const expired = credential?.type === "oauth" && credential.expires <= now;

  const failedAfterSuccess =
    health?.lastFailedRequest !== undefined &&
    (health.lastSuccessfulRequestAt === undefined ||
      health.lastFailedRequest.at >= health.lastSuccessfulRequestAt);

  const recovered =
    health?.lastSuccessfulRequestAt !== undefined &&
    health.lastFailedRequest !== undefined &&
    health.lastSuccessfulRequestAt > health.lastFailedRequest.at;

  const checking =
    health?.healthCheckStartedAt !== undefined &&
    now - Date.parse(health.healthCheckStartedAt) < HEALTH_CHECK_STALE_MS;

  const state = !credential
    ? "missing"
    : failedAfterSuccess
      ? health?.failureKind === "revoked"
        ? "revoked"
        : health?.lastSuccessfulRequestAt
          ? "failed"
          : "failed-first-request"
      : expired
        ? "expired"
        : recovered
          ? "recovered"
          : health?.lastSuccessfulRequestAt
            ? "healthy"
            : "detected";

  const accountLabel =
    credential?.type === "oauth"
      ? [credential.email, credential.accountId].find(
          (value): value is string => Predicate.isString(value) && value.trim().length > 0,
        )
      : undefined;

  const plan =
    credential?.type === "oauth"
      ? ((Predicate.isString(credential.plan) ? credential.plan : undefined) ??
        (provider === "openai-codex" ? codexPlanFromToken(credential.access) : undefined))
      : undefined;

  return {
    provider,
    ...(plan ? { plan } : {}),
    ...(instanceId ? { instanceId } : {}),
    connected: credential !== undefined,
    ...(accountLabel ? { accountLabel } : {}),
    ...(credential ? { authMode: credential.type } : {}),
    ...(credential?.type === "api-key" && credential.baseUrl
      ? { baseUrl: credential.baseUrl }
      : {}),
    ...(credential?.type === "oauth" ? { expiresAt: credential.expires } : {}),
    health: state,
    ...(credential && checking ? { healthChecking: true } : {}),
    ...(health?.lastSuccessfulRequestAt
      ? { lastSuccessfulRequestAt: health.lastSuccessfulRequestAt }
      : {}),
    ...(health?.lastFailedRequest ? { lastFailedRequest: health.lastFailedRequest } : {}),
    ...(health?.nextRetryAt ? { nextRetryAt: health.nextRetryAt } : {}),
    ...(credentialWarning ? { credentialWarning } : {}),
    reconnectAction:
      credential?.type === "api-key" || provider === "opencode-go"
        ? credential
          ? "Replace API key"
          : "Connect API key"
        : credential
          ? "Reconnect account"
          : "Connect account",
    healthTest: health?.healthTest ?? { status: "not-run" },
    ...(health?.oauthCheck ? { oauthCheck: health.oauthCheck } : {}),
    dependentBots: dependentBots.flatMap((bot) =>
      bot.provider === provider ? [{ id: bot.id, name: bot.name }] : [],
    ),
    dependentRoutines: [],
  };
}

export function providerStatuses(
  state: CredentialStoreState,
  healthData: ProviderHealthData,
  dependentBots: ReadonlyArray<{
    readonly id: BotId;
    readonly name: string;
    readonly provider: SubscriptionProviderId;
  }>,
  now: number,
  instanceId?: ProviderInstanceId,
  keyForProvider: (provider: SubscriptionProviderId) => string = (provider) =>
    credentialKey(provider, instanceId),
): ProviderStatus[] {
  return SUBSCRIPTION_PROVIDER_IDS.map((provider) =>
    statusForKey(
      state,
      healthData,
      provider,
      keyForProvider(provider),
      dependentBots,
      now,
      instanceId,
    ),
  );
}

export function linkedAccountStatuses(
  state: CredentialStoreState,
  healthData: ProviderHealthData,
  accounts: SubscriptionAccountState,
  now: number,
): ProviderStatus[] {
  if (state.loadError && !state.servingLastGood) return [];

  return SUBSCRIPTION_PROVIDER_IDS.flatMap((provider) => {
    const active = accounts.activeAccountKey(provider, now);

    return accounts.linkedAccountIds(provider).map((accountId) => {
      const key = credentialKey(provider, accountScope(accountId));

      return {
        ...statusForKey(state, healthData, provider, key, [], now),
        accountId,
        active: key === active,
      };
    });
  });
}
