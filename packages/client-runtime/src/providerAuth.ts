import {
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
  const mode = providerUsesApiKey(status) ? "API key saved" : "OAuth connected";
  const health = status.health?.replaceAll("-", " ");
  return health ? `${mode} · ${health}` : mode;
}
