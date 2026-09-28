import { MOBILE_TYPOGRAPHY } from "./typography";

export const DEFAULT_BASE_FONT_SIZE = MOBILE_TYPOGRAPHY.body.fontSize;
export const MIN_BASE_FONT_SIZE = 11;
export const MAX_BASE_FONT_SIZE = 22;
export const BASE_FONT_SIZE_STEP = 1;

/** User-configurable appearance preferences as stored. */
export interface AppearancePreferences {
  readonly baseFontSize: number;
}

/** Effective appearance values. */
export interface ResolvedAppearance {
  readonly baseFontSize: number;
}

export interface ResolvedMarkdownFontSizes {
  readonly s: number;
  readonly m: number;
  readonly h1: number;
  readonly h2: number;
  readonly h3: number;
  readonly h4: number;
  readonly h5: number;
  readonly h6: number;
  readonly bodyLineHeight: number;
  readonly codeBlockFontSize: number;
  readonly codeBlockLineHeight: number;
}

export interface NativeMarkdownTypography {
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly headingFontSizes: readonly [number, number, number, number, number, number];
}

export function normalizeBaseFontSize(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_BASE_FONT_SIZE;
  }

  return Math.min(MAX_BASE_FONT_SIZE, Math.max(MIN_BASE_FONT_SIZE, Math.round(value)));
}

interface StoredAppearancePreferences {
  readonly baseFontSize?: number | null | undefined;
  /** Legacy key from before base font size existed; migrated to baseFontSize. */
  readonly markdownFontSize?: number | null | undefined;
}

export function resolveAppearancePreferences(
  stored: StoredAppearancePreferences | null | undefined,
): AppearancePreferences {
  return {
    baseFontSize: normalizeBaseFontSize(stored?.baseFontSize ?? stored?.markdownFontSize),
  };
}

export function resolveAppearance(preferences: AppearancePreferences): ResolvedAppearance {
  return { baseFontSize: preferences.baseFontSize };
}

export function resolveMarkdownFontSizes(baseFontSize: number): ResolvedMarkdownFontSizes {
  const m = normalizeBaseFontSize(baseFontSize);
  const scale = m / DEFAULT_BASE_FONT_SIZE;
  const codeBlockFontSize = Math.max(10, Math.round(13 * scale));

  return {
    s: Math.max(10, Math.round(14 * scale)),
    m,
    h1: Math.max(16, Math.round(21 * scale)),
    h2: Math.max(14, Math.round(19 * scale)),
    h3: Math.max(13, Math.round(17 * scale)),
    h4: Math.max(12, Math.round(15 * scale)),
    h5: Math.max(12, Math.round(15 * scale)),
    h6: Math.max(12, Math.round(15 * scale)),
    bodyLineHeight: Math.max(18, Math.round(MOBILE_TYPOGRAPHY.body.lineHeight * scale)),
    codeBlockFontSize,
    codeBlockLineHeight: codeBlockFontSize + 6,
  };
}

/**
 * Maps the Uniwind `--text-*` theme variables (see global.css) to the
 * MOBILE_TYPOGRAPHY roles they were authored from. Keep in sync with both.
 */
const TEXT_SCALE_VARIABLE_ROLES = {
  "--text-3xs": MOBILE_TYPOGRAPHY.micro,
  "--text-2xs": MOBILE_TYPOGRAPHY.caption,
  "--text-xs": MOBILE_TYPOGRAPHY.label,
  "--text-sm": MOBILE_TYPOGRAPHY.footnote,
  "--text-base": MOBILE_TYPOGRAPHY.body,
  "--text-lg": MOBILE_TYPOGRAPHY.headline,
  "--text-xl": MOBILE_TYPOGRAPHY.title,
  "--text-2xl": MOBILE_TYPOGRAPHY.largeTitle,
  "--text-3xl": MOBILE_TYPOGRAPHY.display,
} as const;

/**
 * Scaled values for every `--text-*` size and line-height variable, ready to
 * pass to `Uniwind.updateCSSVariables`. All className-based text (`text-sm`,
 * `text-base`, ...) re-resolves live when these are injected.
 */
export function resolveTextScaleVariables(baseFontSize: number): Record<string, number> {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  const variables: Record<string, number> = {};

  for (const [name, role] of Object.entries(TEXT_SCALE_VARIABLE_ROLES)) {
    variables[name] = Math.max(8, Math.round(role.fontSize * scale));
    variables[`${name}--line-height`] = scaledTypographyLineHeight(role, baseFontSize);
  }

  return variables;
}

/**
 * The line height a MOBILE_TYPOGRAPHY role renders at under the given base
 * font size — the same value resolveTextScaleVariables injects for the role's
 * `--text-*--line-height` variable. For layout code that must predict
 * text-driven heights (e.g. the thread feed's fixed item sizes) instead of
 * measuring them.
 */
export function scaledTypographyLineHeight(
  role: { readonly lineHeight: number },
  baseFontSize: number,
): number {
  const scale = normalizeBaseFontSize(baseFontSize) / DEFAULT_BASE_FONT_SIZE;
  return Math.max(10, Math.round(role.lineHeight * scale));
}

export function resolveNativeMarkdownTypography(baseFontSize: number): NativeMarkdownTypography {
  const fontSizes = resolveMarkdownFontSizes(baseFontSize);
  return {
    fontSize: fontSizes.m,
    lineHeight: fontSizes.bodyLineHeight,
    headingFontSizes: [
      fontSizes.h1,
      fontSizes.h2,
      fontSizes.h3,
      fontSizes.h4,
      fontSizes.h5,
      fontSizes.h6,
    ],
  };
}

export function stepBaseFontSize(current: number, direction: -1 | 1): number {
  const next = direction === -1 ? current - BASE_FONT_SIZE_STEP : current + BASE_FONT_SIZE_STEP;
  return normalizeBaseFontSize(next);
}
