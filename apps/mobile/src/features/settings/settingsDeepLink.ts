import {
  parseSettingsDeepLinkId,
  type SettingsDeepLinkId,
} from "@t3tools/client-runtime/settings-deep-link";

export type MobileSettingsHealthTarget =
  | "local-execution"
  | "bot-inbox"
  | "providers"
  | "image-generation";

/**
 * Where a chat Settings chip lands on mobile. Mobile has fewer Settings screens
 * than desktop, so ids without a matching screen open the Settings home.
 */
export type MobileSettingsDestination =
  | { readonly kind: "health"; readonly target: MobileSettingsHealthTarget }
  | {
      readonly kind: "screen";
      readonly screen: "SettingsAppearance" | "SettingsEnvironments" | "SettingsArchive";
    }
  | { readonly kind: "home" };

const HOME: MobileSettingsDestination = { kind: "home" };

// Keyed by every shared id so a new Settings section needs an explicit mobile decision.
const destinations: Readonly<Record<SettingsDeepLinkId, MobileSettingsDestination>> = {
  general: HOME,
  "local-execution": { kind: "health", target: "local-execution" },
  appearance: { kind: "screen", screen: "SettingsAppearance" },
  keybindings: HOME,
  providers: { kind: "health", target: "providers" },
  channels: HOME,
  voice: HOME,
  "image-generation": { kind: "health", target: "image-generation" },
  browser: HOME,
  plugins: HOME,
  sandbox: HOME,
  privacy: HOME,
  "archived-chats": { kind: "screen", screen: "SettingsArchive" },
  connections: { kind: "screen", screen: "SettingsEnvironments" },
  "bot-inbox": { kind: "health", target: "bot-inbox" },
  diagnostics: HOME,
};

export function resolveMobileSettingsDestination(href: string): MobileSettingsDestination | null {
  const id = parseSettingsDeepLinkId(href);
  return id === null ? null : destinations[id];
}
