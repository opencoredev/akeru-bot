export const SETTINGS_DEEP_LINK_IDS = [
  "general",
  "local-execution",
  "appearance",
  "providers",
  "bot-inbox",
  "voice",
  "connections",
  "keybindings",
  "source-control",
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
    (url.protocol !== "t3code:" && url.protocol !== "t3code-dev:") ||
    url.hostname !== "app" ||
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
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
