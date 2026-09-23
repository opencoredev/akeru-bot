import type {
  OrchestrationThreadActivity,
  ServerProvider,
  ServerProviderUnavailability,
} from "@t3tools/contracts";

import { translate as translateMessage, type TranslationParams } from "./i18n/index.ts";

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

/** A client's active translator. The default renders English. */
export type ProviderAvailabilityTranslate = (message: string, params?: TranslationParams) => string;

const english: ProviderAvailabilityTranslate = (message, params) =>
  translateMessage("en", message, params);

export function presentProviderUnavailability(input: {
  readonly reason: ProviderAvailabilityReason;
  /** Omit when the failure did not say which provider it came from. */
  readonly providerName?: string | null | undefined;
  readonly modelName?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly translate?: ProviderAvailabilityTranslate | undefined;
}): ProviderAvailabilityPresentation {
  const translate = input.translate ?? english;
  const known = input.providerName;
  // Subject, mid-sentence, possessive, and title forms for a known or unknown provider.
  const name = known ?? translate("The provider");
  const who = known ?? translate("the provider");
  const yours = known
    ? translate("your {provider}", { provider: known })
    : translate("your provider");
  const label = known ?? translate("Provider");
  const technicalDetails = boundedDetail(input.detail);
  switch (input.reason) {
    case "missing-provider":
      return {
        title: translate("{provider} is not set up", { provider: name }),
        description: translate(
          "Add {provider} in Settings > Providers, or pick another model for this bot.",
          { provider: who },
        ),
        technicalDetails,
        action: "providers",
      };
    case "disabled":
      return {
        title: translate("{provider} is turned off", { provider: name }),
        description: translate(
          "Turn {provider} on in Settings > Providers, then send your message again.",
          { provider: who },
        ),
        technicalDetails,
        action: "providers",
      };
    case "not-installed":
      return {
        title: translate("{provider} is not installed", { provider: name }),
        description: translate(
          "Install {provider} from Settings > Providers, or pick another model for this bot.",
          { provider: who },
        ),
        technicalDetails,
        action: "providers",
      };
    case "missing-login":
      return {
        title: translate("{provider} is not connected", { provider: name }),
        description: translate("Connect {account} account in Settings > Providers.", {
          account: yours,
        }),
        technicalDetails,
        action: "providers",
      };
    case "expired-login":
      return {
        title: translate("{provider} sign-in expired", { provider: label }),
        description: translate(
          "Reconnect {provider} in Settings > Providers, then send your message again.",
          { provider: who },
        ),
        technicalDetails,
        action: "providers",
      };
    case "unsupported-model":
      return {
        title: input.modelName
          ? translate("{model} is not available on {provider}", {
              model: input.modelName,
              provider: who,
            })
          : translate("This model is not available on {provider}", { provider: who }),
        description: translate("Pick another model for this bot."),
        technicalDetails,
        action: "none",
      };
    case "limit-reached":
      return {
        title: translate("{provider} limit reached", { provider: label }),
        description: translate(
          "Your {provider} plan hit its usage or rate limit. Wait for it to reset, then send your message again.",
          { provider: known ?? translate("provider") },
        ),
        technicalDetails,
        action: "none",
      };
    case "usage-cap":
      return {
        title: translate("Akeru usage cap reached"),
        description: translate("Raise this bot's usage cap in its settings to keep chatting."),
        technicalDetails,
        action: "usage",
      };
    case "temporary-failure":
      return {
        title: translate("{provider} could not respond", { provider: name }),
        description: translate("Send your message again in a moment."),
        technicalDetails,
        action: "none",
      };
  }
}

/** One sentence for a disabled picker row or a Send tooltip. */
export function providerUnavailabilitySummary(
  input: Parameters<typeof presentProviderUnavailability>[0],
): string {
  const presentation = presentProviderUnavailability(input);
  return (input.translate ?? english)("{title}. {description}", {
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
  const newestFirst = activities.toSorted(
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
