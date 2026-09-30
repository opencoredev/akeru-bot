import { isElectron } from "~/env";

export type SettingsPath =
  | "/settings/providers"
  | "/settings/channels"
  | "/settings/sandbox"
  | "/settings/browser"
  | "/settings/general"
  | "/settings/appearance"
  | "/settings/keybindings"
  | "/settings/image-generation"
  | "/settings/connections"
  | "/settings/privacy"
  | "/settings/advanced";

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
 * Every searchable setting, in result order. This catalog is the single
 * source of truth for anchor ids and visible titles: panels render both via
 * `searchableSetting`, so a retitle (or, later, a translation pass) happens
 * here once instead of separately in the panel and the index.
 */
export const SETTINGS_SEARCH_ITEMS = [
  {
    id: "language",
    title: "Language",
    to: "/settings/general",
    keywords: [
      "locale",
      "translation",
      "English",
      "system default",
      "device language",
      "Chinese",
      "中文",
      "简体中文",
    ],
  },
  {
    id: "color-scheme",
    title: "Color scheme",
    to: "/settings/appearance",
    // The Color scheme section carries the page's `appearance` anchor.
    targetId: "appearance",
  },
  {
    // The Themes section itself carries this id.
    id: "theme",
    title: "Themes",
    to: "/settings/appearance",
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
    targetId: "display",
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
    to: "/settings/sandbox",
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
    id: "memory-enabled",
    title: "Memory",
    to: "/settings/privacy",
    keywords: ["durable facts", "remember"],
  },
  {
    id: "memory-private-bot",
    title: "Private bot memory",
    to: "/settings/privacy",
    keywords: ["memory"],
  },
  {
    id: "memory-shared-project",
    title: "Save shared project memory automatically",
    to: "/settings/privacy",
    keywords: ["memory", "approval"],
  },
  {
    id: "local-execution",
    title: "Local execution",
    to: "/settings/sandbox",
  },
  {
    id: "voice-enabled",
    title: "Voice",
    to: "/settings/providers",
  },
  {
    id: "voice-provider",
    title: "Voice provider",
    to: "/settings/providers",
  },
  {
    id: "voice-selection",
    title: "Voice selection",
    to: "/settings/providers",
  },
  {
    id: "voice-openai-voice",
    title: "OpenAI API voice",
    to: "/settings/providers",
    keywords: ["realtime", "interrupt"],
  },
  {
    id: "voice-transcription-provider",
    title: "Transcription provider",
    to: "/settings/providers",
    keywords: ["speech to text", "OpenAI", "ElevenLabs", "Cartesia"],
  },
  {
    id: "voice-synthesis-provider",
    title: "Speech provider",
    to: "/settings/providers",
    keywords: ["text to speech", "OpenAI", "ElevenLabs", "Cartesia", "Fish Audio"],
  },
  {
    id: "voice-synthesis-voice",
    title: "Speech voice",
    to: "/settings/providers",
  },
  {
    id: "voice-api-connections",
    title: "Voice API connections",
    to: "/settings/providers",
    keywords: ["API key", "OpenAI", "ElevenLabs", "Cartesia", "Fish Audio", "billing"],
  },
  {
    id: "image-generation",
    title: "Image generation",
    to: "/settings/image-generation",
    keywords: ["images", "pictures", "ChatGPT", "Grok", "health test"],
  },
  {
    id: "image-provider-chatgpt",
    title: "ChatGPT images",
    to: "/settings/image-generation",
    keywords: ["image", "OpenAI", "subscription"],
  },
  {
    id: "image-provider-grok",
    title: "Grok images",
    to: "/settings/image-generation",
    keywords: ["image", "xAI", "subscription"],
  },
  {
    id: "image-default-provider",
    title: "Default image provider",
    to: "/settings/image-generation",
  },
  {
    id: "image-fallback-order",
    title: "Image fallback order",
    to: "/settings/image-generation",
    keywords: ["retry", "backup"],
  },
  {
    id: "voice-read-aloud",
    title: "Read new replies aloud",
    to: "/settings/providers",
    keywords: ["read aloud", "speech", "playback", "automatic readout"],
  },
  {
    id: "quit-confirmation",
    title: "Quit shortcut",
    to: "/settings/general",
    keywords: ["confirmation", "desktop", "exit", "direct", "hold", "double click", "press twice"],
    desktopOnly: true,
  },
  {
    id: "data-portability",
    title: "Data portability",
    to: "/settings/privacy",
  },
  {
    id: "background-activity",
    title: "Background work",
    to: "/settings/advanced",
    keywords: ["background activity", "battery", "performance"],
  },
  {
    id: "diagnostics",
    title: "Diagnostics",
    to: "/settings/advanced",
    keywords: ["errors", "failures", "troubleshooting", "logs"],
  },
  {
    id: "legacy-token-streaming",
    title: "Stream token by token (legacy)",
    to: "/settings/advanced",
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
    keywords: ["ChatGPT", "Codex", "Claude", "Grok", "Kimi", "OpenCode", "API key", "Subscription"],
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
    id: "bot-channels",
    title: "Bot channels",
    to: "/settings/channels",
    keywords: [
      "Channels",
      "Telegram",
      "iMessage",
      "Photon",
      "WhatsApp",
      "Slack",
      "Discord",
      "messaging",
      "webhook",
      "credentials",
    ],
  },
  {
    id: "remote-environments",
    title: "Remote environments",
    to: "/settings/connections",
  },
] as const satisfies ReadonlyArray<SettingsSearchItem>;

export type SettingsSearchItemId = (typeof SETTINGS_SEARCH_ITEMS)[number]["id"];

const SEARCH_ITEMS_BY_ID = Object.fromEntries(
  SETTINGS_SEARCH_ITEMS.map((item) => [item.id, item]),
) as Readonly<Record<SettingsSearchItemId, SettingsSearchItem>>;

/**
 * `id` and `title` props for the element a search item anchors to. Panels
 * spread (or pick from) this instead of restating the strings, so the catalog
 * and the rendered settings cannot drift apart. Pass the active translator so
 * the title follows the interface language.
 */
export function searchableSetting(
  id: SettingsSearchItemId,
  translate: (message: string) => string = (message) => message,
): {
  readonly id: string;
  readonly title: string;
} {
  const { id: anchorId, title } = SEARCH_ITEMS_BY_ID[id];
  return { id: anchorId, title: translate(title) };
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
  translateTitle: (title: string) => string = (title) => title,
): ReadonlyArray<SettingsSearchItem> {
  const normalizedQuery = normalizeSearchText(query);
  if (normalizedQuery.length === 0) return [];

  return items.filter(
    (item) =>
      (isElectron || item.desktopOnly !== true) &&
      [item.title, translateTitle(item.title), ...(item.keywords ?? [])].some((value) =>
        normalizeSearchText(value).includes(normalizedQuery),
      ),
  );
}
