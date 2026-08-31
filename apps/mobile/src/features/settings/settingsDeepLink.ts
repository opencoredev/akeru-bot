import { parseSettingsDeepLinkId } from "@t3tools/client-runtime/settings-deep-link";

export type MobileSettingsHealthTarget = "local-execution" | "bot-inbox";
export type MobileSettingsDestination =
  | { readonly kind: "root" }
  | { readonly kind: "screen"; readonly screen: "SettingsAppearance" | "SettingsEnvironments" }
  | { readonly kind: "health"; readonly target: MobileSettingsHealthTarget };

export function resolveMobileSettingsDestination(href: string): MobileSettingsDestination | null {
  const id = parseSettingsDeepLinkId(href);
  if (id === "general") return { kind: "root" };
  if (id === "appearance") return { kind: "screen", screen: "SettingsAppearance" };
  if (id === "connections") return { kind: "screen", screen: "SettingsEnvironments" };
  if (id === "local-execution" || id === "bot-inbox") {
    return { kind: "health", target: id };
  }
  return null;
}
