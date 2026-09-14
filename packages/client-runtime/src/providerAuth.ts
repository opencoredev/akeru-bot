import {
  defaultInstanceIdForDriver,
  type ServerProvider,
  SubscriptionBaseUrl,
  type SubscriptionAuthStartInput,
  type SubscriptionProviderId,
  type SubscriptionProviderStatus,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PROVIDER_CONNECTIONS = [
  { id: "openai-codex", label: "ChatGPT" },
  { id: "anthropic", label: "Claude" },
  { id: "xai", label: "Grok" },
  { id: "kimi-for-coding", label: "Kimi For Coding" },
  { id: "opencode-go", label: "OpenCode Go" },
] as const satisfies ReadonlyArray<{ id: SubscriptionProviderId; label: string }>;

export function providerSupportsBaseUrl(provider: SubscriptionProviderId): boolean {
  return provider !== "xai" && provider !== "cursor";
}

export function providerUsesApiKey(status: SubscriptionProviderStatus | undefined): boolean {
  return status?.authMode === "api-key" || status?.provider === "opencode-go";
}

const isSubscriptionBaseUrl = Schema.is(SubscriptionBaseUrl);

export function apiKeyValidationError(key: string, baseUrl: string): string | null {
  if (!key.trim()) return "Enter an API key.";
  if (baseUrl.trim() && !isSubscriptionBaseUrl(baseUrl.trim())) {
    return "Use an HTTP or HTTPS base URL without credentials, a query, or a fragment.";
  }
  return null;
}

export function apiKeyStartInput(
  provider: SubscriptionProviderId,
  baseUrl: string,
): SubscriptionAuthStartInput {
  return {
    provider,
    authMode: "api-key",
    ...(providerSupportsBaseUrl(provider) && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
  };
}

export function providerConnectionLabel(status: SubscriptionProviderStatus): string {
  if (!status.connected) return "Not connected";
  return providerUsesApiKey(status) ? "API key saved" : "OAuth connected";
}

const SUBSCRIPTION_PROVIDER_BY_DRIVER: Readonly<Record<string, SubscriptionProviderId>> = {
  codex: "openai-codex",
  claudeAgent: "anthropic",
  cursor: "cursor",
  grok: "xai",
  kimi: "kimi-for-coding",
  opencodeGo: "opencode-go",
};

/**
 * Keep default built-in provider instances aligned with the connections the
 * user made inside Akeru. Host CLI credentials are intentionally not enough
 * to make an unconnected account appear in model pickers. Custom instances
 * remain governed by their own configured environment and provider probe.
 */
export function filterProvidersBySubscriptionConnection(
  providers: ReadonlyArray<ServerProvider>,
  statuses: ReadonlyArray<SubscriptionProviderStatus> | undefined,
): ReadonlyArray<ServerProvider> {
  if (!statuses) return providers;
  const connected = new Set(
    statuses.filter((status) => status.connected).map((status) => status.provider),
  );
  return providers.filter((provider) => {
    const subscriptionProvider = SUBSCRIPTION_PROVIDER_BY_DRIVER[String(provider.driver)];
    if (!subscriptionProvider) return true;
    if (provider.instanceId !== defaultInstanceIdForDriver(provider.driver)) return true;
    return connected.has(subscriptionProvider);
  });
}
