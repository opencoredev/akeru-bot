import type { ServerProvider, ServerProviderUnavailability } from "@t3tools/contracts";

import type { ProviderStatus } from "../subscription-auth/service.ts";
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

export const preflightProvider = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerId: string;
  readonly model: string;
  readonly subscriptionStatuses?: ReadonlyArray<ProviderStatus>;
  readonly subscriptionHealth?: (instanceId: string) =>
    | {
        readonly health: string;
        readonly lastFailedRequest?: RecordedFailure;
        readonly nextRetryAt?: string;
      }
    | undefined;
  readonly now: number;
}): { readonly category: ServerProviderUnavailability; readonly detail: string } | undefined => {
  const provider = input.providers.find((candidate) => candidate.instanceId === input.providerId);
  if (!provider) {
    return {
      category: "temporary-failure",
      detail: `Provider '${input.providerId}' is unavailable.`,
    };
  }
  const subscriptionProviderByDriver: Record<string, string> = {
    codex: "openai-codex",
    claudeAgent: "anthropic",
    grok: "xai",
    kimi: "kimi-for-coding",
    opencodeGo: "opencode-go",
  };
  const subscriptionId = subscriptionProviderByDriver[provider.driver];
  const subscription = input.subscriptionStatuses?.find(
    (status) => status.provider === subscriptionId,
  );
  const requestHealth = input.subscriptionHealth?.(provider.instanceId);
  const health =
    requestHealth?.health ??
    (provider.auth.status === "unauthenticated" ? subscription?.health : undefined);
  if (health === "missing" || health === "revoked") {
    return {
      category: health === "revoked" ? "expired-login" : "missing-login",
      detail: subscription?.reconnectAction ?? "Connect this provider.",
    };
  }
  if (health === "expired")
    return { category: "expired-login", detail: "Provider login has expired." };
  if (health === "failed" || health === "failed-first-request") {
    const failure = requestHealth?.lastFailedRequest ?? subscription?.lastFailedRequest;
    const detail = failure?.message ?? "The provider request failed.";
    const category = providerUnavailabilityFromDetail(provider.driver, detail);
    const nextRetryAt = requestHealth ? requestHealth.nextRetryAt : subscription?.nextRetryAt;
    if (recordedFailureStillBlocks(category, failure, nextRetryAt, input.model, input.now)) {
      return { category, detail };
    }
  }
  if (provider.unavailability && provider.unavailability !== "temporary-failure") {
    return {
      category: provider.unavailability,
      detail:
        provider.unavailabilityDetail ?? provider.message ?? "Provider access is unavailable.",
    };
  }
  if (
    !provider.enabled ||
    !provider.installed ||
    (provider.availability === "unavailable" && provider.status !== "error")
  ) {
    return {
      category: "temporary-failure",
      detail: provider.unavailableReason ?? "Provider is unavailable.",
    };
  }
  if (provider.auth.status === "unauthenticated") {
    return {
      category: "missing-login",
      detail: "Sign in to this provider before starting a chat.",
    };
  }
  if (provider.models.length > 0 && !provider.models.some((model) => model.slug === input.model)) {
    return {
      category: "unsupported-model",
      detail: `Model '${input.model}' is not available for ${provider.displayName ?? provider.driver}.`,
    };
  }
  return undefined;
};
