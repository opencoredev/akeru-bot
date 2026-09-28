import type {
  ProviderInstanceConfig,
  ServerProvider,
  ServerProviderUnavailability,
} from "@t3tools/contracts";

import { instanceUsesSavedCredential } from "../subscription-auth/runtime.ts";
import type { ProviderStatus, SubscriptionProviderId } from "../subscription-auth/service.ts";
import { providerUnavailabilityFromDetail } from "./providerSnapshot.ts";

// How long a recorded rate limit keeps blocking new turns when the provider
// did not report its own retry time.
const RATE_LIMIT_RETRY_WINDOW_MS = 60_000;

type RecordedFailure = {
  readonly at?: string;
  readonly message: string;
  readonly model?: string;
};

// A recorded request failure only gates new turns while it still applies. A
// model error blocks only the model that failed, so switching models recovers,
// and a rate limit lapses once its retry window passes.
const recordedFailureStillBlocks = (
  category: ServerProviderUnavailability,
  failure: RecordedFailure | undefined,
  nextRetryAt: string | undefined,
  model: string,
  now: number,
): boolean => {
  if (category === "temporary-failure") return false;
  if (category === "unsupported-model") return failure?.model === model;
  if (category !== "limit-reached") return true;
  const retryAt = nextRetryAt
    ? Date.parse(nextRetryAt)
    : failure?.at
      ? Date.parse(failure.at) + RATE_LIMIT_RETRY_WINDOW_MS
      : Number.NaN;
  return Number.isFinite(retryAt) && now < retryAt;
};

export interface ProviderPreflightVerdict {
  readonly category: ServerProviderUnavailability;
  readonly detail: string;
  readonly repairAction?: "providers" | "usage";
}

const SUBSCRIPTION_PROVIDER_BY_DRIVER: Record<string, SubscriptionProviderId> = {
  codex: "openai-codex",
  claudeAgent: "anthropic",
  grok: "xai",
  kimi: "kimi-for-coding",
  opencodeGo: "opencode-go",
};

/**
 * Decides whether a turn can start on a provider instance before any work is
 * dispatched. Returns undefined when the turn may proceed. The order matters:
 * a provider the user turned off reports that, not a stale probe failure.
 */
export const preflightProvider = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerId: string;
  readonly model: string;
  readonly providerInstanceConfig?: ProviderInstanceConfig;
  readonly subscriptionStatuses?: ReadonlyArray<ProviderStatus>;
  readonly subscriptionHealth?: (instanceId: string) =>
    | {
        readonly health: string;
        readonly lastFailedRequest?: RecordedFailure;
        readonly nextRetryAt?: string;
      }
    | undefined;
  readonly now: number;
}): ProviderPreflightVerdict | undefined => {
  const provider = input.providers.find((candidate) => candidate.instanceId === input.providerId);
  if (!provider) {
    return {
      category: "temporary-failure",
      detail: `Provider '${input.providerId}' is unavailable.`,
    };
  }
  const name = provider.displayName ?? provider.driver;
  if (!provider.enabled) {
    return {
      category: "temporary-failure",
      detail: provider.unavailableReason ?? `${name} is turned off in Settings > Providers.`,
      repairAction: "providers",
    };
  }
  const subscriptionId = SUBSCRIPTION_PROVIDER_BY_DRIVER[provider.driver];
  const subscription = input.subscriptionStatuses?.find(
    (status) => status.provider === subscriptionId,
  );
  const requestHealth = input.subscriptionHealth?.(provider.instanceId);
  const sharedCredential =
    subscriptionId !== undefined &&
    instanceUsesSavedCredential(subscriptionId, input.providerInstanceConfig);
  const sharedHealth = sharedCredential ? subscription?.health : undefined;
  const canRefreshExpiredLogin = sharedHealth === "expired" && subscription?.authMode === "oauth";
  const health =
    sharedHealth === "revoked" || (sharedHealth === "expired" && !canRefreshExpiredLogin)
      ? sharedHealth
      : (requestHealth?.health ??
        (provider.auth.status === "unauthenticated" && !canRefreshExpiredLogin
          ? sharedHealth
          : undefined));
  if (health === "missing" || health === "revoked") {
    return {
      category: health === "revoked" ? "expired-login" : "missing-login",
      detail: subscription?.reconnectAction ?? "Connect this provider.",
      repairAction: "providers",
    };
  }
  if (health === "expired") {
    return {
      category: "expired-login",
      detail: "Provider login has expired.",
      repairAction: "providers",
    };
  }
  if (health === "failed" || health === "failed-first-request") {
    const failure = requestHealth?.lastFailedRequest ?? subscription?.lastFailedRequest;
    const detail = failure?.message ?? "The provider request failed.";
    const category = providerUnavailabilityFromDetail(provider.driver, detail);
    const nextRetryAt = requestHealth ? requestHealth.nextRetryAt : subscription?.nextRetryAt;
    if (recordedFailureStillBlocks(category, failure, nextRetryAt, input.model, input.now)) {
      return withRepair(category, detail);
    }
  }
  if (
    provider.unavailability &&
    provider.unavailability !== "temporary-failure" &&
    !(canRefreshExpiredLogin && provider.unavailability === "expired-login")
  ) {
    return withRepair(
      provider.unavailability,
      provider.unavailabilityDetail ?? provider.message ?? "Provider access is unavailable.",
    );
  }
  if (
    !provider.installed ||
    (provider.availability === "unavailable" &&
      provider.status !== "error" &&
      !(canRefreshExpiredLogin && provider.unavailability === "expired-login"))
  ) {
    return {
      category: "temporary-failure",
      detail: provider.unavailableReason ?? "Provider is unavailable.",
      repairAction: "providers",
    };
  }
  if (provider.auth.status === "unauthenticated" && !canRefreshExpiredLogin) {
    return {
      category: "missing-login",
      detail: "Sign in to this provider before starting a chat.",
      repairAction: "providers",
    };
  }
  if (provider.models.length > 0 && !provider.models.some((model) => model.slug === input.model)) {
    return {
      category: "unsupported-model",
      detail: `Model '${input.model}' is not available for ${name}.`,
    };
  }
  return undefined;
};

const withRepair = (
  category: ServerProviderUnavailability,
  detail: string,
): ProviderPreflightVerdict =>
  category === "missing-login" || category === "expired-login"
    ? { category, detail, repairAction: "providers" }
    : category === "usage-cap"
      ? { category, detail, repairAction: "usage" }
      : { category, detail };
