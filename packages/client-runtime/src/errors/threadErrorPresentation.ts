import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderDriverKind,
  type ServerProviderUnavailability,
} from "@t3tools/contracts";

import {
  presentProviderUnavailability,
  type ProviderAvailabilityPresentation,
  type ProviderAvailabilityReason,
} from "../providerAvailability.ts";

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
  return PROVIDER_DISPLAY_NAMES[id.toLowerCase() as ProviderDriverKind] ?? id;
}

function boundedTechnicalDetails(error: string): string {
  const firstLine = error.split("\n", 1)[0]?.trim() ?? error.trim();
  const withoutStack = firstLine.replace(/\s+at\s+[A-Za-z_$][\s\S]*$/, "").trim();
  const withoutLocalPaths = withoutStack.replace(/file:\/\/\/[^\s)]+/g, "file://…");
  return withoutLocalPaths.slice(0, 600);
}

export function presentThreadError(
  error: string,
  context: ThreadErrorContext = {},
): ThreadErrorPresentation {
  const present = (
    reason: ProviderAvailabilityReason,
    name: string | null | undefined = context.providerName,
    detail = boundedTechnicalDetails(error),
  ) =>
    presentProviderUnavailability({
      reason,
      providerName: name,
      modelName: context.modelName,
      detail,
    });

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

  if (/Bot '[^']+' is archived/.test(error)) {
    return {
      title: "This bot is archived",
      description: "Restore it from the roster to chat with it again.",
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  if (/rate.?limit|usage limit|too many requests|quota exceeded/i.test(error)) {
    return present("limit-reached");
  }

  if (/not authenticated|authentication required|unauthorized|invalid api key/i.test(error)) {
    return present("missing-login");
  }

  if (/network|connection|socket|fetch failed|disconnected/i.test(error)) {
    return {
      title: "Connection interrupted",
      description: "Check the environment connection, then send your message again.",
      technicalDetails: boundedTechnicalDetails(error),
      action: "none",
    };
  }

  return {
    title: "The bot couldn’t finish that request",
    description:
      "Try sending it again. If it keeps happening, send feedback with the technical details.",
    technicalDetails: boundedTechnicalDetails(error),
    action: "feedback",
  };
}
