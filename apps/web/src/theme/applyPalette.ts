import {
  type ThemeAppearance,
  type ThemeColorRole,
  type ThemeColors,
} from "@akeru/shared/themePalettes";
import { isThemeColor } from "./colorMath";
import { type ThemePreference } from "./themeTypes";
import { getThemeDefinition, getThemeColorsForMode } from "./themeDefinitions";
import { legacyThemeMode } from "./themeIdentity";

const themePreviewListeners = new Set<() => void>();

let themePreviewSidebarArtwork: boolean | null = null;

export function getThemePreviewSidebarArtwork(): boolean | null {
  return themePreviewSidebarArtwork;
}

export function subscribeToThemePreview(listener: () => void): () => void {
  themePreviewListeners.add(listener);

  return () => themePreviewListeners.delete(listener);
}

function setThemePreviewSidebarArtwork(next: boolean | null): void {
  if (themePreviewSidebarArtwork === next) return;
  themePreviewSidebarArtwork = next;

  for (const listener of themePreviewListeners) listener();
}

const APP_THEME_VARIABLES: Readonly<Record<ThemeColorRole, string>> = {
  canvas: "--app-theme-canvas",
  chrome: "--app-theme-chrome",
  toolbar: "--app-theme-toolbar",
  toolbarForeground: "--app-theme-toolbar-foreground",
  toolbarBorder: "--app-theme-toolbar-border",
  toolbarControl: "--app-theme-toolbar-control",
  toolbarControlForeground: "--app-theme-toolbar-control-foreground",
  toolbarControlHover: "--app-theme-toolbar-control-hover",
  surface: "--app-theme-surface",
  surfaceRaised: "--app-theme-surface-raised",
  surfaceOverlay: "--app-theme-surface-overlay",
  text: "--app-theme-text",
  textMuted: "--app-theme-text-muted",
  border: "--app-theme-border",
  input: "--app-theme-input",
  focus: "--app-theme-focus",
  accent: "--app-theme-accent",
  accentForeground: "--app-theme-accent-foreground",
  secondary: "--app-theme-secondary",
  secondaryForeground: "--app-theme-secondary-foreground",
  muted: "--app-theme-muted",
  mutedForeground: "--app-theme-muted-foreground",
  placeholder: "--app-theme-placeholder",
  secondaryLabel: "--app-theme-secondary-label",
  iconMuted: "--app-theme-icon-muted",
  error: "--app-theme-error",
  errorForeground: "--app-theme-error-foreground",
  errorSurface: "--app-theme-error-surface",
  warning: "--app-theme-warning",
  warningForeground: "--app-theme-warning-foreground",
  warningSurface: "--app-theme-warning-surface",
  update: "--app-theme-update",
  updateForeground: "--app-theme-update-foreground",
  updateSurface: "--app-theme-update-surface",
  accentSurface: "--app-theme-accent-surface",
  accentSurfaceForeground: "--app-theme-accent-surface-foreground",
  messageSurface: "--app-theme-message-surface",
  messageForeground: "--app-theme-message-foreground",
  messageAction: "--app-theme-message-action",
  messageActionForeground: "--app-theme-message-action-foreground",
  messageActionHover: "--app-theme-message-action-hover",
  codeBackground: "--app-theme-code-background",
  codeForeground: "--app-theme-code-foreground",
  sidebar: "--app-theme-sidebar",
  sidebarForeground: "--app-theme-sidebar-foreground",
  sidebarMutedForeground: "--app-theme-sidebar-muted-foreground",
  sidebarControlSurface: "--app-theme-sidebar-control-surface",
  sidebarRowHover: "--app-theme-sidebar-row-hover",
  sidebarRowActive: "--app-theme-sidebar-row-active",
  sidebarRowSelected: "--app-theme-sidebar-row-selected",
  sidebarBorder: "--app-theme-sidebar-border",
  terminalBackground: "--app-theme-terminal-background",
  terminalForeground: "--app-theme-terminal-foreground",
  terminalCursor: "--app-theme-terminal-cursor",
  terminalSelection: "--app-theme-terminal-selection-background",
  terminalScrollbar: "--app-theme-terminal-scrollbar",
  terminalScrollbarHover: "--app-theme-terminal-scrollbar-hover",
};

export function getThemeColorVariable(role: ThemeColorRole): string {
  return APP_THEME_VARIABLES[role];
}

/** Marks the document as wearing an unsaved draft rather than a stored theme. */
export const THEME_PREVIEW_ID = "__preview";

/**
 * Paint a draft palette onto the live app without installing it, so the editor
 * can be judged against the real interface instead of a miniature. Callers
 * restore the stored theme (refreshTheme) when the draft goes away.
 */
export function applyThemeColorPreview(colors: ThemeColors, appearance: ThemeAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;

  if (!root?.style) return;

  // Drafts become user-controlled themes when saved, so their preview keeps
  // the fixed stage artwork hidden even when it was seeded from a built-in.
  setThemePreviewSidebarArtwork(false);
  root.dataset.themeId = THEME_PREVIEW_ID;
  root.classList.toggle("dark", appearance === "dark");

  for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
    // A half-typed hex keeps the last good value instead of blanking the role.
    if (isThemeColor(value)) root.style.setProperty(APP_THEME_VARIABLES[role], value);
  }
}

export function applyThemePalette(theme: ThemePreference, appearance?: ThemeAppearance): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;

  if (!root?.style) return;

  setThemePreviewSidebarArtwork(null);
  const palette = getThemeDefinition(theme);

  if (palette) {
    root.dataset.themeId = palette.id;
    const mode = appearance ?? legacyThemeMode(theme) ?? palette.appearance;
    const colors = getThemeColorsForMode(palette, mode) ?? palette.colors;

    for (const [role, value] of Object.entries(colors) as Array<[ThemeColorRole, string]>) {
      root.style.setProperty(APP_THEME_VARIABLES[role], value);
    }

    return;
  }

  delete root.dataset.themeId;

  for (const variable of Object.values(APP_THEME_VARIABLES)) {
    root.style.removeProperty(variable);
  }
}
