import { ProviderDriverKind } from "@akeru/contracts";

import { CustomApiIcon, type Icon } from "../Icons";
import {
  SUBSCRIPTION_PROVIDERS,
  subscriptionProviderTargetId,
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
  {
    slug: "custom-api",
    label: "Custom API",
    icon: CustomApiIcon,
    planHint: "OpenAI-compatible endpoint",
    description: "Bring any OpenAI-compatible API: set a base URL and pick its models.",
    account: null,
    drivers: [ProviderDriverKind.make("customOpenai")],
  },
];

export function providerCatalogEntry(slug: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.slug === slug);
}

/** The entry a built-in driver signs in through, e.g. Claude for `claudeAgent`. */
export function providerCatalogEntryForDriver(
  driver: string | null | undefined,
): ProviderCatalogEntry | undefined {
  return driver
    ? PROVIDER_CATALOG.find((entry) => entry.drivers.some((candidate) => candidate === driver))
    : undefined;
}

/** The Settings target that opens an entry's own page, used by repair buttons. */
export function providerCatalogTargetId(entry: ProviderCatalogEntry): string {
  return entry.account ? subscriptionProviderTargetId(entry.account.id) : `provider-${entry.slug}`;
}

/** The provider page a Settings target opens, so a repair link lands on that provider. */
export function providerCatalogSlugFromSettingsTarget(target: string | null): string | null {
  if (!target) return null;

  return PROVIDER_CATALOG.find((entry) => providerCatalogTargetId(entry) === target)?.slug ?? null;
}
