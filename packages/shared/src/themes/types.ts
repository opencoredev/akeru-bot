export const BUILT_IN_THEME_IDS = [
  "akeru-noir",
  "akeru-paper",
  "akeru-chat",
  "grove",
  "ocean",
  "ember",
  "iris",
] as const;

/** The mobile app's own hand-tuned palette, which is not part of the built-in library. */
export const MOBILE_DEFAULT_THEME_ID = "akeru-classic";

/**
 * Every palette the mobile app can render. Declared here so host-side tooling
 * (the app-store screenshot harness) can validate a requested theme without
 * importing React Native application code.
 */
export const MOBILE_THEME_IDS = [MOBILE_DEFAULT_THEME_ID, ...BUILT_IN_THEME_IDS] as const;

export type BuiltInThemeId = (typeof BUILT_IN_THEME_IDS)[number];

export type MobileThemeId = (typeof MOBILE_THEME_IDS)[number];

export type ThemeAppearance = "light" | "dark";

/** Product roles shared by web CSS, React Native tokens, and native surfaces. */
export const THEME_COLOR_ROLES = [
  "canvas",
  "chrome",
  "toolbar",
  "toolbarForeground",
  "toolbarBorder",
  "toolbarControl",
  "toolbarControlForeground",
  "toolbarControlHover",
  "surface",
  "surfaceRaised",
  "surfaceOverlay",
  "text",
  "textMuted",
  "border",
  "input",
  "focus",
  "accent",
  "accentForeground",
  "secondary",
  "secondaryForeground",
  "muted",
  "mutedForeground",
  "placeholder",
  "secondaryLabel",
  "iconMuted",
  "error",
  "errorForeground",
  "errorSurface",
  "warning",
  "warningForeground",
  "warningSurface",
  "update",
  "updateForeground",
  "updateSurface",
  "accentSurface",
  "accentSurfaceForeground",
  "messageSurface",
  "messageForeground",
  "messageAction",
  "messageActionForeground",
  "messageActionHover",
  "codeBackground",
  "codeForeground",
  "sidebar",
  "sidebarForeground",
  "sidebarMutedForeground",
  "sidebarControlSurface",
  "sidebarRowHover",
  "sidebarRowActive",
  "sidebarRowSelected",
  "sidebarBorder",
  "terminalBackground",
  "terminalForeground",
  "terminalCursor",
  "terminalSelection",
  "terminalScrollbar",
  "terminalScrollbarHover",
] as const;

export type ThemeColorRole = (typeof THEME_COLOR_ROLES)[number];

export type ThemeColors = Readonly<Record<ThemeColorRole, string>>;

export type ThemeVariants = Readonly<Partial<Record<ThemeAppearance, ThemeColors>>>;

export type ThemeDefinition = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  colors: ThemeColors;
  variants?: ThemeVariants;
  /** Groups related imported variants into one library card. */
  collection?: Readonly<{ id: string; label: string }>;
  /** Allows reviewed built-ins to render product artwork over their sidebar. */
  sidebarArtwork?: boolean;
  /** Generated from the guided editor's canvas and accent roles. */
  managed?: boolean;
}>;
