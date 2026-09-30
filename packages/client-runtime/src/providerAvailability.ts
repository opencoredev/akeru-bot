import type {
  OrchestrationThreadActivity,
  ServerProvider,
  ServerProviderUnavailability,
} from "@t3tools/contracts";

import { createTranslator, type MessageKey, type TranslationParams } from "./i18n/index.ts";

/**
 * Why a provider instance cannot run a turn right now. The server's turn
 * preflight uses the same order, so a client that shows a reason shows the one
 * the server would refuse with.
 */
export type ProviderAvailabilityReason =
  | ServerProviderUnavailability
  | "disabled"
  | "not-installed"
  | "missing-provider";

/** One next step. Clients map "providers" to Settings > Providers and "usage" to bot usage settings. */
export type ProviderAvailabilityAction = "providers" | "usage" | "feedback" | "none";

export interface ProviderAvailabilityPresentation {
  readonly title: string;
  readonly description: string;
  readonly technicalDetails: string;
  readonly action: ProviderAvailabilityAction;
}

export function providerAvailabilityReason(
  provider: ServerProvider | undefined,
  model?: string | null,
): ProviderAvailabilityReason | null {
  if (!provider) return "missing-provider";
  if (!provider.enabled) return "disabled";
  if (provider.unavailability && provider.unavailability !== "temporary-failure") {
    return provider.unavailability;
  }
  if (
    !provider.installed ||
    (provider.availability === "unavailable" && provider.status !== "error")
  ) {
    return "not-installed";
  }
  if (provider.auth.status === "unauthenticated") return "missing-login";
  if (
    model &&
    provider.models.length > 0 &&
    !provider.models.some((candidate) => candidate.slug === model)
  ) {
    return "unsupported-model";
  }
  if (provider.unavailability === "temporary-failure") return "temporary-failure";
  return null;
}

/** Translates presentation copy. Defaults to English so callers without a locale keep working. */
export type ProviderAvailabilityTranslate = (
  message: MessageKey,
  params?: TranslationParams,
) => string;

const englishTranslate: ProviderAvailabilityTranslate = createTranslator("en").t;

export function presentProviderUnavailability(
  input: {
    readonly reason: ProviderAvailabilityReason;
    /** Omit when the failure did not say which provider it came from. */
    readonly providerName?: string | null | undefined;
    readonly modelName?: string | null | undefined;
    readonly detail?: string | null | undefined;
  },
  t: ProviderAvailabilityTranslate = englishTranslate,
): ProviderAvailabilityPresentation {
  const provider = input.providerName;
  // Each sentence has its own key for an unknown provider, so no locale has to
  // splice a generic noun into a template written around a proper name.
  const named = (known: MessageKey, unknown: MessageKey, params: TranslationParams = {}) =>
    provider ? t(known, { ...params, provider }) : t(unknown, params);
  const technicalDetails = boundedDetail(input.detail);
  switch (input.reason) {
    case "missing-provider":
      return {
        title: named("{provider} is not set up", "The provider is not set up"),
        description: named(
          "Add {provider} in Settings > Providers, or pick another model for this bot.",
          "Add the provider in Settings > Providers, or pick another model for this bot.",
        ),
        technicalDetails,
        action: "providers",
      };
    case "disabled":
      return {
        title: named("{provider} is turned off", "The provider is turned off"),
        description: named(
          "Turn {provider} on in Settings > Providers, then send your message again.",
          "Turn the provider on in Settings > Providers, then send your message again.",
        ),
        technicalDetails,
        action: "providers",
      };
    case "not-installed":
      return {
        title: named("{provider} is not installed", "The provider is not installed"),
        description: named(
          "Install {provider} from Settings > Providers, or pick another model for this bot.",
          "Install the provider from Settings > Providers, or pick another model for this bot.",
        ),
        technicalDetails,
        action: "providers",
      };
    case "missing-login":
      return {
        title: named("{provider} is not connected", "The provider is not connected"),
        description: named(
          "Connect your {provider} account in Settings > Providers.",
          "Connect your provider account in Settings > Providers.",
        ),
        technicalDetails,
        action: "providers",
      };
    case "expired-login":
      return {
        title: named("{provider} sign-in expired", "Provider sign-in expired"),
        description: named(
          "Reconnect {provider} in Settings > Providers, then send your message again.",
          "Reconnect the provider in Settings > Providers, then send your message again.",
        ),
        technicalDetails,
        action: "providers",
      };
    case "unsupported-model":
      return {
        title: input.modelName
          ? named(
              "{model} is not available on {provider}",
              "{model} is not available on the provider",
              { model: input.modelName },
            )
          : named(
              "This model is not available on {provider}",
              "This model is not available on the provider",
            ),
        description: t("Pick another model for this bot."),
        technicalDetails,
        action: "none",
      };
    case "limit-reached":
      return {
        title: named("{provider} limit reached", "Provider limit reached"),
        description: named(
          "Your {provider} plan hit its usage or rate limit. Wait for it to reset, then send your message again.",
          "Your provider plan hit its usage or rate limit. Wait for it to reset, then send your message again.",
        ),
        technicalDetails,
        action: "none",
      };
    case "usage-cap":
      return {
        title: t("Akeru usage cap reached"),
        description: t("Raise this bot's usage cap in its settings to keep chatting."),
        technicalDetails,
        action: "usage",
      };
    case "temporary-failure":
      return {
        title: named("{provider} could not respond", "The provider could not respond"),
        description: t("Send your message again in a moment."),
        technicalDetails,
        action: "none",
      };
  }
}

/** One sentence for a disabled picker row or a Send tooltip. */
export function providerUnavailabilitySummary(
  input: Parameters<typeof presentProviderUnavailability>[0],
  t: ProviderAvailabilityTranslate = englishTranslate,
): string {
  const presentation = presentProviderUnavailability(input, t);
  return joinProviderUnavailability(presentation, t);
}

/** A presentation's title and next step as one sentence, punctuated for the locale. */
export function joinProviderUnavailability(
  presentation: Pick<ProviderAvailabilityPresentation, "title" | "description">,
  t: ProviderAvailabilityTranslate = englishTranslate,
): string {
  return t("{title}. {description}", {
    title: presentation.title,
    description: presentation.description,
  });
}

const TURN_FAILURE_KINDS = new Set(["provider.turn.start.failed", "runtime.error"]);

/**
 * The newest turn failure recorded in a chat's activity log, if it came after
 * the chat's latest user message. The activity is authoritative: the persisted
 * session keeps only the raw error text, not its category.
 */
export function latestTurnFailure(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  since?: string | null,
): {
  readonly detail: string;
  readonly unavailability: ServerProviderUnavailability | null;
} | null {
  // .sort() on a copy, not .toSorted(): Hermes doesn't ship the ES2023
  // change-by-copy array methods.
  const newestFirst = [...activities].sort(
    (left, right) =>
      (right.sequence ?? -1) - (left.sequence ?? -1) ||
      right.createdAt.localeCompare(left.createdAt),
  );
  for (const activity of newestFirst) {
    if (since && activity.createdAt < since) return null;
    if (!TURN_FAILURE_KINDS.has(activity.kind)) continue;
    const payload =
      activity.payload && typeof activity.payload === "object"
        ? (activity.payload as Record<string, unknown>)
        : {};
    const detail =
      typeof payload.detail === "string"
        ? payload.detail
        : typeof payload.message === "string"
          ? payload.message
          : activity.summary;
    return {
      detail,
      unavailability: isServerProviderUnavailability(payload.unavailability)
        ? payload.unavailability
        : null,
    };
  }
  return null;
}

const UNAVAILABILITY_VALUES = new Set<string>([
  "missing-login",
  "expired-login",
  "unsupported-model",
  "limit-reached",
  "usage-cap",
  "temporary-failure",
]);

/** Narrows an unknown wire value, such as an error field or activity payload, to a failure category. */
export function isServerProviderUnavailability(
  value: unknown,
): value is ServerProviderUnavailability {
  return typeof value === "string" && UNAVAILABILITY_VALUES.has(value);
}

function boundedDetail(detail: string | null | undefined): string {
  const firstLine = detail?.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.replace(/file:\/\/\/[^\s)]+/g, "file://…").slice(0, 600);
}
