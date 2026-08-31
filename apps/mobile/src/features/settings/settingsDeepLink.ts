import { parseSettingsDeepLinkId } from "@t3tools/client-runtime/settings-deep-link";

export type MobileSettingsHealthTarget = "local-execution" | "bot-inbox";

export function resolveMobileSettingsHealthTarget(href: string): MobileSettingsHealthTarget | null {
  const id = parseSettingsDeepLinkId(href);
  return id === "local-execution" || id === "bot-inbox" ? id : null;
}
