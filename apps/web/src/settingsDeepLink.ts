import type { MessageKey } from "@t3tools/client-runtime/i18n";
import type { SettingsSection } from "./settingsDialogStore";
import {
  parseSettingsDeepLinkId,
  type SettingsDeepLinkId,
} from "@t3tools/client-runtime/settings-deep-link";

// Keyed by every shared id so a new Settings section cannot ship without a web destination.
const destinations: Readonly<
  Record<
    SettingsDeepLinkId,
    { readonly section: SettingsSection; readonly label: MessageKey; readonly targetId?: string }
  >
> = {
  general: { section: "general", label: "General" },
  "local-execution": {
    section: "general",
    label: "General > Local execution",
    targetId: "local-execution",
  },
  appearance: { section: "appearance", label: "Appearance" },
  keybindings: { section: "keybindings", label: "Keybindings" },
  providers: { section: "providers", label: "Providers" },
  channels: { section: "channels", label: "Bot channels" },
  voice: { section: "voice", label: "Voice" },
  "image-generation": { section: "image-generation", label: "Image generation" },
  browser: { section: "browser", label: "Browser" },
  plugins: { section: "plugins", label: "Plugins" },
  sandbox: { section: "sandbox", label: "Sandbox" },
  privacy: { section: "privacy", label: "Privacy" },
  connections: { section: "connections", label: "Connections" },
  "bot-inbox": { section: "inbox", label: "Bot inbox" },
  diagnostics: { section: "diagnostics", label: "Diagnostics" },
};

export interface SettingsDeepLinkDestination {
  readonly section: SettingsSection;
  readonly targetId: string | null;
  /** Catalog label for the destination, shown as "Open Settings > {label}". */
  readonly label: MessageKey;
}

export function parseSettingsDeepLink(
  href: string | undefined,
): SettingsDeepLinkDestination | null {
  const id = parseSettingsDeepLinkId(href);
  if (id === null) return null;
  const destination = destinations[id];
  return {
    section: destination.section,
    targetId: destination.targetId ?? null,
    label: destination.label,
  };
}
