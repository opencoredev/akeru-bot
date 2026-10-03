import {
  PROVIDER_ACCOUNT_NAMES,
  isProviderDriverKind,
  type ServerProviderUnavailability,
} from "@akeru/contracts";

import {
  presentProviderUnavailability,
  type ProviderAvailabilityPresentation,
  type ProviderAvailabilityTranslate,
  type ProviderAvailabilityReason,
} from "../providerAvailability.ts";
import { createTranslator } from "../i18n/index.ts";

/**
 * Turns a raw provider or orchestration error into chat-facing copy shared by
 * web and mobile. Only an unexplained failure asks for feedback; known causes
 * name their own fix.
 */
export type ThreadErrorPresentation = ProviderAvailabilityPresentation;

/** What the server knew about a failure beyond its text. */
export interface ThreadErrorContext {
  readonly unavailability?: ServerProviderUnavailability | null | undefined;
  readonly providerName?: string | null | undefined;
  readonly modelName?: string | null | undefined;
}

function providerName(id: string): string {
  // A legacy message may name the driver in any case, such as "Codex".
  const driver = isProviderDriverKind(id) ? id : id.toLowerCase();

  return isProviderDriverKind(driver) ? (PROVIDER_ACCOUNT_NAMES[driver] ?? id) : id;
}

function boundedTechnicalDetails(error: string): string {
  const firstLine = error.split("\n", 1)[0]?.trim() ?? error.trim();
  const withoutStack = firstLine.replace(/\s+at\s+[A-Za-z_$][\s\S]*$/, "").trim();
  const withoutLocalPaths = withoutStack.replace(/file:\/\/\/[^\s)]+/g, "file://…");

  return withoutLocalPaths.slice(0, 600);
}

const englishTranslate: ProviderAvailabilityTranslate = createTranslator("en").t;

export function presentThreadError(
  error: string,
  context: ThreadErrorContext = {},
  t: ProviderAvailabilityTranslate = englishTranslate,
): ThreadErrorPresentation {
  const present = (
    reason: ProviderAvailabilityReason,
    name: string | null | undefined = context.providerName,
    detail = boundedTechnicalDetails(error),
  ) =>
    presentProviderUnavailability(
      {
        reason,
        providerName: name,
        modelName: context.modelName,
        detail,
      },
      t,
    );

  // A temporary failure is the server's catch-all, so the text below can
  // still say more about it than the category can.
  if (context.unavailability && context.unavailability !== "temporary-failure") {
    return present(context.unavailability);
  }

  const disabledProvider = error.match(/Provider instance ['"]([^'"]+)['"] is disabled/i);

  if (disabledProvider?.[1]) {
    return present(
      "disabled",
      context.providerName ?? providerName(disabledProvider[1]),
      `Provider instance “${disabledProvider[1]}” is disabled.`,
    );
  }

  // Older servers said "is not available" for both a missing sign-in and a
  // deleted instance; "not set up" fits either.
  const missingProvider = error.match(
    /Provider instance ['"]([^'"]+)['"] is not (?:set up|available)/i,
  );

  if (missingProvider?.[1]) {
    return present("missing-provider", context.providerName ?? providerName(missingProvider[1]));
  }

  if (/Bot '[^']+' is archived/.test(error)) {
    return {
      title: t("This bot is archived"),
      description: t("Restore it from the roster to chat with it again."),
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  if (/rate.?limit|usage limit|too many requests|quota exceeded/i.test(error)) {
    return present("limit-reached");
  }

  if (
    /not authenticated|authentication required|unauthorized|invalid api key|^Connect .+ in Settings/i.test(
      error,
    )
  ) {
    return present("missing-login");
  }

  // A provider set up with its own credentials: signing in to an account
  // won't fix it, so name what the instance is missing.
  const provider = context.providerName;

  const missingCredential = error.match(/This .+ instance needs (.+?) for the Akeru harness/);

  if (missingCredential?.[1]) {
    const requirement = missingCredential[1];

    return {
      title: provider
        ? t("{provider} needs {requirement}", { provider, requirement })
        : t("The provider needs {requirement}", { requirement }),
      description: t(
        "Add it to this provider in Settings > Providers, then send your message again.",
      ),
      technicalDetails: boundedTechnicalDetails(error),
      action: "providers",
    };
  }

  if (/Custom .+ credentials are not supported/.test(error)) {
    return {
      title: provider
        ? t("{provider} can't use custom credentials", { provider })
        : t("The provider can't use custom credentials"),
      description: t(
        "Use your account in Settings > Providers, or pick another model for this bot.",
      ),
      technicalDetails: boundedTechnicalDetails(error),
      action: "providers",
    };
  }

  if (/network|connection|socket|fetch failed|disconnected/i.test(error)) {
    return {
      title: t("Connection interrupted"),
      description: t("Check the environment connection, then send your message again."),
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  return {
    title: t("The bot couldn’t finish that request"),
    description: t(
      "Try sending it again. If it keeps happening, send feedback with the technical details.",
    ),
    technicalDetails: boundedTechnicalDetails(error),
    action: "feedback",
  };
}
