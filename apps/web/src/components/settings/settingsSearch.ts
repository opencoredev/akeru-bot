import { isElectron } from "~/env";

export type SettingsPath =
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/providers"
  | "/settings/browser"
  | "/settings/channels"
  | "/settings/sandbox"
  | "/settings/voice"
  | "/settings/privacy"
  | "/settings/source-control"
  | "/settings/connections"
  | "/settings/archived";

export interface SettingsSearchItem {
  readonly id: string;
  readonly title: string;
  readonly to: SettingsPath;
  readonly targetId?: string;
  readonly keywords?: ReadonlyArray<string>;
  // Its row only renders in the desktop app, so a browser result would land on
  // an anchor that isn't there.
  readonly desktopOnly?: boolean;
}

/**
 * Section labels in sidebar order. The sidebar nav and the search-result
 * subtitles both render from this record, so each label exists once.
 */
export const SETTINGS_SECTION_LABELS: Readonly<Record<SettingsPath, string>> = {
  "/settings/general": "General",
  "/settings/appearance": "Appearance",
  "/settings/keybindings": "Keybindings",
  "/settings/providers": "Providers",
  "/settings/browser": "Browser",
  "/settings/channels": "Channels",
  "/settings/sandbox": "Sandbox",
  "/settings/voice": "Voice",
  "/settings/privacy": "Privacy",
  "/settings/source-control": "Source Control",
  "/settings/connections": "Connections",
  "/settings/archived": "Archive",
};

/**
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    // The scheme tiles sit at the top of the Appearance section.
    targetId: "appearance",
  },
  {
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
    // Theme cards live directly under the scheme tiles; the section is the
    // stable scroll destination for both.
    targetId: "appearance",
  },
  {
    // Prefixed because the slider control already owns the `appearance-contrast` id.
    id: "setting-appearance-contrast",
    title: "Contrast",
    to: "/settings/appearance",
  },
  {
    // Prefixed because the slider control already owns the `glass-opacity` id.
    id: "setting-glass-opacity",
    title: "Glass opacity",
    to: "/settings/appearance",
  },
  {
    id: "environment-identification",
    title: "Environment identification",
    to: "/settings/appearance",
    // The setting is stage-dependent, so its parent section is the stable destination.
    targetId: "appearance",
  },
  {
    id: "interface-font",
    title: "Interface font",
    to: "/settings/appearance",
  },
  {
    id: "prompt-font",
    title: "Prompt font",
    to: "/settings/appearance",
  },
  {
    id: "code-font",
    title: "Code font",
    to: "/settings/appearance",
  },
  {
    id: "terminal-font",
    title: "Terminal font",
    to: "/settings/appearance",
  },
  {
    id: "font-smoothing",
    title: "Font smoothing",
    to: "/settings/appearance",
  },
  {
    id: "word-wrap",
    title: "Word wrap",
    to: "/settings/appearance",
  },
  {
    id: "sandbox-browser-sharing",
    title: "Sandbox and browser sharing",
    to: "/settings/general",
  },
  {
    id: "time-format",
    title: "Time format",
    to: "/settings/general",
  },
  {
    id: "usage-refresh",
    title: "Usage refresh",
    to: "/settings/general",
  },
  {
    id: "hide-whitespace-changes",
    title: "Hide whitespace changes",
    to: "/settings/general",
  },
  {
    id: "skills-in-slash-menu",
    title: "Show skills in slash menu",
    to: "/settings/general",
  },
  {
    id: "privacy",
    title: "Privacy",
    to: "/settings/privacy",
  },
  {
    id: "anonymous-analytics",
    title: "Anonymous analytics",
    to: "/settings/privacy",
  },
  {
    id: "privacy-product-feedback",
    title: "Product feedback",
    to: "/settings/privacy",
  },
  {
    id: "privacy-voice-calls",
    title: "Voice calls",
    to: "/settings/privacy",
  },
  {
    id: "privacy-provider-update-checks",
    title: "Provider update checks",
    to: "/settings/privacy",
  },
  {
    id: "local-execution",
    title: "Local execution",
    to: "/settings/general",
  },
  {
    id: "voice-enabled",
    title: "Voice",
    to: "/settings/voice",
  },
  {
    id: "voice-provider",
    title: "Voice provider",
    to: "/settings/voice",
  },
  {
    id: "voice-selection",
    title: "Voice selection",
    to: "/settings/voice",
  },
  {
    id: "add-project-starts-in",
    title: "Add project starts in",
    to: "/settings/general",
  },
  {
    id: "quit-confirmation",
    title: "Hold to quit",
    to: "/settings/general",
    desktopOnly: true,
  },
  {
    id: "text-generation-model",
    title: "Fallback model",
    to: "/settings/general",
  },
  {
    id: "data-portability",
    title: "Data portability",
    to: "/settings/general",
  },
  {
    id: "analytics",
    title: "Analytics",
    to: "/settings/general",
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/general",
  },
  {
    id: "legacy-plan-mode",
    title: "Plan mode (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-token-streaming",
    title: "Stream token by token (legacy)",
    to: "/settings/general",
  },
  {
    id: "legacy-sidebar",
    title: "Sidebar (legacy)",
    to: "/settings/general",
  },
  {
    id: "keybindings",
    title: "Keybindings",
    to: "/settings/keybindings",
  },
  {
    id: "providers",
    title: "Providers",
    to: "/settings/providers",
  },
  {
    id: "sandbox",
    title: "Sandbox",
    to: "/settings/sandbox",
  },
  {
    id: "default-sandbox",
    title: "Default sandbox",
    to: "/settings/sandbox",
  },
  {
    id: "sandbox-auto-idle",
    title: "Sandbox auto-idle",
    to: "/settings/sandbox",
  },
  {
    id: "agent-browser-access",
    title: "Bot browser access",
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "browser-default-viewport",
    title: "Default browser viewport",
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "browser-default-zoom",
    title: "Default browser zoom",
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "browser-default-appearance",
    title: "Default browser appearance",
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "browser-auto-show-floating-preview",
    title: "Auto-show floating preview",
    to: "/settings/browser",
    targetId: "browser",
  },
  {
    id: "bot-channels",
    title: "Bot channels",
    to: "/settings/channels",
    keywords: ["Telegram", "iMessage", "Photon", "WhatsApp", "Slack", "Discord"],
  },
  {
    id: "source-control",
    title: "Source control",
    to: "/settings/source-control",
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    to: "/settings/connections",
  },
  {
    id: "archive",
    title: "Archived chats",
    to: "/settings/archived",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart.
 */
export function searchableSetting(id: SettingsSearchItemId): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title };
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function searchSettings(
  query: string,
  items: ReadonlyArray<SettingsSearchItem> = SETTINGS_SEARCH_ITEMS,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      [item.title, ...(item.keywords ?? [])].some((value) =>
        normalizeSearchText(value).includes(normalizedQuery),
      ),
  );
}
