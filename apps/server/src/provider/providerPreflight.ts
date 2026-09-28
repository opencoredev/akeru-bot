import type { ServerProvider, ServerProviderUnavailability } from "@t3tools/contracts";

import type { ProviderStatus } from "../subscription-auth/service.ts";
import { providerUnavailabilityFromDetail } from "./providerSnapshot.ts";

export const preflightProvider = (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly providerId: string;
  readonly model: string;
  readonly subscriptionStatuses?: ReadonlyArray<ProviderStatus>;
  readonly subscriptionHealth?: (
    instanceId: string,
  ) =>
    | { readonly health: string; readonly lastFailedRequest?: { readonly message: string } }
    | undefined;
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
    const detail =
      requestHealth?.lastFailedRequest?.message ??
      subscription?.lastFailedRequest?.message ??
      "The provider request failed.";
    const category = providerUnavailabilityFromDetail(provider.driver, detail);
    if (category !== "temporary-failure") return { category, detail };
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
