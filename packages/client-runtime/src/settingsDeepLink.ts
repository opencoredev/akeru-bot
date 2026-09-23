/**
 * Every id a chat Settings chip may name, in Settings rail order. A new
 * Settings section adds its id here; the web and mobile destination maps are
 * keyed by this list, so the compiler points at each surface that must learn
 * the new id.
 */
export const SETTINGS_DEEP_LINK_IDS = [
  "general",
  "local-execution",
  "appearance",
  "keybindings",
  "providers",
  "channels",
  "voice",
  "image-generation",
  "browser",
  "plugins",
  "sandbox",
  "privacy",
  "connections",
  "source-control",
  "bot-inbox",
  "diagnostics",
] as const;

export type SettingsDeepLinkId = (typeof SETTINGS_DEEP_LINK_IDS)[number];

const settingsDeepLinkIds = new Set<string>(SETTINGS_DEEP_LINK_IDS);

export function parseSettingsDeepLinkId(href: string | undefined): SettingsDeepLinkId | null {
  if (!href) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (
    url.protocol !== "grokbot:" ||
    url.hostname !== "app" ||
    url.pathname !== "/v1/settings" ||
    url.hash !== "" ||
    [...url.searchParams.keys()].some((key) => key !== "id") ||
    url.searchParams.getAll("id").length > 1
  ) {
    return null;
  }
  const id = url.searchParams.get("id")?.trim() || "general";
  return settingsDeepLinkIds.has(id) ? (id as SettingsDeepLinkId) : null;
}

/** The in-app link a Settings chip opens, e.g. for "providers". */
export function settingsDeepLinkHref(id: SettingsDeepLinkId): string {
  return `grokbot://app/v1/settings?id=${id}`;
}

/**
 * True for any in-app link, valid or not. Clients never hand one to the OS or
 * a browser; an href that fails `parseSettingsDeepLinkId` renders inert.
 */
export function isAppDeepLink(href: string): boolean {
  return /^grokbot:/i.test(href.trim());
}
