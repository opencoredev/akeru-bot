import { ProviderDriverKind } from "@t3tools/contracts";

import type { Icon } from "../Icons";
import {
  SUBSCRIPTION_PROVIDERS,
  type SubscriptionProviderDefinition,
} from "./subscriptionProviders";

/**
 * One row on the Providers page and the subpage behind it. An entry pairs the
 * account a user signs in with (when the provider has one) with the runtime
 * drivers whose instances, models, and settings the subpage edits.
 */
export interface ProviderCatalogEntry {
  /** URL segment under `/settings/providers/`. */
  readonly slug: string;
  readonly label: string;
  readonly icon: Icon | string;
  readonly planHint: string;
  readonly description: string;
  readonly account: SubscriptionProviderDefinition | null;
  readonly drivers: ReadonlyArray<ProviderDriverKind>;
}

function subscriptionEntry(
  slug: string,
  accountId: SubscriptionProviderDefinition["id"],
  drivers: ReadonlyArray<string>,
): ProviderCatalogEntry {
  const account = SUBSCRIPTION_PROVIDERS.find((definition) => definition.id === accountId)!;
  return {
    slug,
    label: account.label,
    icon: account.icon,
    planHint: account.subscription,
    description: account.description,
    account,
    drivers: drivers.map((driver) => ProviderDriverKind.make(driver)),
  };
}

export const PROVIDER_CATALOG: ReadonlyArray<ProviderCatalogEntry> = [
  subscriptionEntry("chatgpt", "openai-codex", ["codex"]),
  subscriptionEntry("claude", "anthropic", ["claudeAgent"]),
  subscriptionEntry("grok", "xai", ["grok"]),
  subscriptionEntry("kimi-for-coding", "kimi-for-coding", ["kimi"]),
  subscriptionEntry("opencode-go", "opencode-go", ["opencodeGo"]),
];

export function providerCatalogEntry(slug: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.slug === slug);
}
