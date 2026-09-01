import type { SettingsSection } from "./settingsDialogStore";
import { parseSettingsDeepLinkId } from "@t3tools/client-runtime/settings-deep-link";

const destinations: Readonly<
  Record<
    string,
    { readonly section: SettingsSection; readonly label: string; readonly targetId?: string }
  >
> = {
  general: { section: "general", label: "General" },
  "local-execution": {
    section: "general",
    label: "General > Local execution",
    targetId: "local-execution",
  },
  appearance: { section: "appearance", label: "Appearance" },
  providers: { section: "providers", label: "Providers" },
  browser: { section: "browser", label: "Browser" },
  "bot-inbox": { section: "inbox", label: "Errors" },
  voice: { section: "voice", label: "Voice" },
  connections: { section: "connections", label: "Connections" },
  keybindings: { section: "keybindings", label: "Keybindings" },
  "source-control": { section: "source-control", label: "Source control" },
  diagnostics: { section: "diagnostics", label: "Diagnostics" },
};

export interface SettingsDeepLinkDestination {
  readonly section: SettingsSection;
  readonly targetId: string | null;
  readonly tooltip: string;
}

export function parseSettingsDeepLink(
  href: string | undefined,
): SettingsDeepLinkDestination | null {
  const id = parseSettingsDeepLinkId(href);
  if (id === null) return null;
  const destination = destinations[id];
  if (!destination) return null;
  return {
    section: destination.section,
    targetId: destination.targetId ?? null,
    tooltip: `Open Settings > ${destination.label}`,
  };
}
