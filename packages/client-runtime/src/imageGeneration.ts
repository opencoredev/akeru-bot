import {
  IMAGE_PROVIDER_IDS,
  type ImageGenerationSettings,
  type ImageGenerationSettingsPatch,
  type ImageProviderHealth,
  type ImageProviderId,
  type ImageProviderStatus,
} from "@t3tools/contracts";

import { createTranslator, type MessageKey, type TranslationParams } from "./i18n/index.ts";

type ImageGenerationTranslate = (message: MessageKey, params?: TranslationParams) => string;

const englishTranslate: ImageGenerationTranslate = createTranslator("en").t;

export const IMAGE_PROVIDER_LABELS: Readonly<Record<ImageProviderId, string>> = {
  chatgpt: "ChatGPT",
  grok: "Grok",
};

/** Subscription credential each image provider rides on; disconnecting it also signs out chat. */
export const IMAGE_PROVIDER_SUBSCRIPTIONS = {
  chatgpt: "openai-codex",
  grok: "xai",
} as const satisfies Record<ImageProviderId, string>;

export type ImageHealthBadgeVariant = "success" | "error" | "warning" | "secondary";

export interface ImageHealthDisplay {
  readonly label: string;
  readonly variant: ImageHealthBadgeVariant;
}

const FAILURE_LABELS: Readonly<Partial<Record<ImageProviderHealth, string>>> = {
  expired: "Expired",
  revoked: "Revoked",
  failed: "Failed",
  "failed-first-request": "First request failed",
};

export function isImageProviderEnabled(
  settings: ImageGenerationSettings,
  provider: ImageProviderId,
): boolean {
  return provider === "chatgpt" ? settings.chatgptEnabled : settings.grokEnabled;
}

/**
 * Health badge for one row. The enabled flag comes from local settings so a
 * toggle shows immediately; everything else comes from the server row. A row
 * only reads as healthy after a real health request passed.
 */
export function imageProviderHealthDisplay(
  status: ImageProviderStatus | undefined,
  enabled: boolean,
  loadFailed = false,
): ImageHealthDisplay {
  if (!status) {
    return loadFailed
      ? { label: "Unavailable", variant: "error" }
      : { label: "Checking", variant: "secondary" };
  }
  if (!status.connected) return { label: "Not connected", variant: "secondary" };
  if (!enabled) return { label: "Disabled", variant: "secondary" };
  const failure = FAILURE_LABELS[status.health];
  if (failure) return { label: failure, variant: "error" };
  if (status.health === "unsupported") return { label: "Unsupported", variant: "warning" };
  if (
    (status.health === "healthy" || status.health === "recovered") &&
    status.healthTest?.status === "passed"
  ) {
    return { label: status.health === "recovered" ? "Recovered" : "Healthy", variant: "success" };
  }
  return { label: "Not tested", variant: "warning" };
}

/** Clients pass their active translator; plain callers get English. */
export function imageProviderAccessLabel(
  status: ImageProviderStatus | undefined,
  t: ImageGenerationTranslate = englishTranslate,
): string {
  if (!status) return t("Checking subscription");
  const provider = IMAGE_PROVIDER_LABELS[status.provider];
  return status.connected
    ? t("{provider} subscription detected", { provider })
    : t("No {provider} subscription connected", { provider });
}

export function imageProviderOperationsLabel(status: ImageProviderStatus): string {
  return status.operations.includes("generate")
    ? "Supports image generation"
    : "No supported operations reported";
}

/** Only meaningful for a loaded row; a missing row is loading or unavailable, not empty. */
export function imageProviderGenerationLabel(
  status: ImageProviderStatus,
  formatTime: (iso: string) => string,
): string {
  return status.lastGenerationAt
    ? `Last image ${formatTime(status.lastGenerationAt)}`
    : "No images generated yet";
}

export function imageProviderHealthTestLabel(
  status: ImageProviderStatus,
  formatTime: (iso: string) => string,
): string {
  const test = status.healthTest;
  if (!test || test.status === "not-run") return "Health test not run";
  const verb = test.status === "passed" ? "passed" : "failed";
  return test.checkedAt
    ? `Health test ${verb} ${formatTime(test.checkedAt)}`
    : `Health test ${verb}`;
}

/** The enabled providers in fallback order. Providers missing from the saved order go last. */
export function effectiveFallbackOrder(settings: ImageGenerationSettings): ImageProviderId[] {
  const enabled = IMAGE_PROVIDER_IDS.filter((id) => isImageProviderEnabled(settings, id));
  const ordered = settings.fallbackOrder.filter((id) => enabled.includes(id));
  return [...new Set([...ordered, ...enabled])];
}

/** The provider new images use, or null when none is enabled. */
export function effectiveDefaultProvider(
  settings: ImageGenerationSettings,
): ImageProviderId | null {
  if (settings.defaultProvider && isImageProviderEnabled(settings, settings.defaultProvider)) {
    return settings.defaultProvider;
  }
  return effectiveFallbackOrder(settings)[0] ?? null;
}

/** Returns why an order cannot be saved, or null when it can. */
export function fallbackOrderError(
  order: ReadonlyArray<ImageProviderId>,
  settings: ImageGenerationSettings,
): string | null {
  if (order.length === 0) return "Choose at least one provider.";
  if (order.length > IMAGE_PROVIDER_IDS.length) return "The order lists too many providers.";
  if (new Set(order).size !== order.length) return "Each provider can appear only once.";
  const disabled = order.find((id) => !isImageProviderEnabled(settings, id));
  if (disabled) return `${IMAGE_PROVIDER_LABELS[disabled]} is turned off.`;
  return null;
}

/**
 * Patch for turning one provider on or off. It keeps the default and the
 * fallback order coherent so the optimistic settings match what the server
 * saves after normalizing.
 */
export function imageProviderTogglePatch(
  settings: ImageGenerationSettings,
  provider: ImageProviderId,
  enabled: boolean,
): ImageGenerationSettingsPatch {
  const next: ImageGenerationSettings = {
    ...settings,
    ...(provider === "chatgpt" ? { chatgptEnabled: enabled } : { grokEnabled: enabled }),
  };
  const order = effectiveFallbackOrder(next);
  const defaultProvider = effectiveDefaultProvider(next);
  return {
    ...(provider === "chatgpt" ? { chatgptEnabled: enabled } : { grokEnabled: enabled }),
    ...(defaultProvider !== settings.defaultProvider ? { defaultProvider } : {}),
    ...(order.length > 0 && order.join() !== settings.fallbackOrder.join()
      ? { fallbackOrder: order }
      : {}),
  };
}

/** Label for the bot editor's "use the global default" option. */
export function globalDefaultOptionLabel(settings: ImageGenerationSettings): string {
  const provider = effectiveDefaultProvider(settings);
  return provider
    ? `Use global default (${IMAGE_PROVIDER_LABELS[provider]})`
    : "Use global default (none enabled)";
}

/**
 * Bot editor option label. A bot can still pick a provider that is off or
 * disconnected, so the option says so instead of looking ready.
 */
export function botImageProviderOptionLabel(
  provider: ImageProviderId,
  settings: ImageGenerationSettings,
  status: ImageProviderStatus | undefined,
): string {
  const label = IMAGE_PROVIDER_LABELS[provider];
  if (status && !status.connected) return `${label} (not connected)`;
  if (!isImageProviderEnabled(settings, provider)) return `${label} (off)`;
  return label;
}
