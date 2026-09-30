import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_BASE_FONT_SIZE,
  normalizeBaseFontSize,
  resolveAppearance,
  resolveAppearancePreferences,
  resolveMarkdownFontSizes,
  resolveNativeMarkdownTypography,
  resolveTextScaleVariables,
  stepBaseFontSize,
} from "./appearancePreferences";

describe("appearancePreferences", () => {
  it("resolves defaults for empty stored preferences", () => {
    expect(resolveAppearancePreferences({})).toEqual({ baseFontSize: DEFAULT_BASE_FONT_SIZE });
    expect(resolveAppearance(resolveAppearancePreferences({}))).toEqual({
      baseFontSize: DEFAULT_BASE_FONT_SIZE,
    });
  });

  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("clamps the base font size", () => {
    expect(normalizeBaseFontSize(4)).toBe(11);
    expect(normalizeBaseFontSize(30)).toBe(22);
  });

  it("steps the base font size within bounds", () => {
    expect(stepBaseFontSize(11, -1)).toBe(11);
    expect(stepBaseFontSize(15, 1)).toBe(16);
  });

  it("scales markdown typography from the base size", () => {
    expect(resolveMarkdownFontSizes(15)).toMatchObject({
      m: 15,
      h1: 20,
      bodyLineHeight: 22,
      codeBlockFontSize: 12,
      codeBlockLineHeight: 18,
    });
  });

  it("returns the authored text scale at the 16pt default", () => {
    expect(DEFAULT_BASE_FONT_SIZE).toBe(16);

    const variables = resolveTextScaleVariables(DEFAULT_BASE_FONT_SIZE);
    expect(variables["--text-base"]).toBe(16);
    expect(variables["--text-base--line-height"]).toBe(23);
    expect(variables["--text-sm"]).toBe(14);
    expect(variables["--text-sm--line-height"]).toBe(19);
    expect(variables["--text-lg"]).toBe(18);
    expect(variables["--text-3xl"]).toBe(30);
  });

  it("scales every text variable proportionally with the base size", () => {
    const smallerVariables = resolveTextScaleVariables(15);
    expect(smallerVariables["--text-base"]).toBe(15);
    expect(smallerVariables["--text-sm"]).toBe(13);

    const variables = resolveTextScaleVariables(20);
    expect(variables["--text-base"]).toBe(20);
    expect(variables["--text-base--line-height"]).toBe(29);
    expect(variables["--text-sm"]).toBe(18);
    expect(variables["--text-xs"]).toBe(16);
    expect(variables["--text-lg"]).toBe(23);

    const smaller = resolveTextScaleVariables(11);
    expect(smaller["--text-base"]).toBe(11);
    expect(smaller["--text-3xs"]).toBeGreaterThanOrEqual(8);
    expect(smaller["--text-3xs--line-height"]).toBeGreaterThanOrEqual(10);
  });

  it("derives native markdown typography from the base size", () => {
    expect(resolveNativeMarkdownTypography(22)).toEqual({
      fontSize: 22,
      lineHeight: 32,
      headingFontSizes: [29, 26, 23, 21, 21, 21],
    });
  });
});
