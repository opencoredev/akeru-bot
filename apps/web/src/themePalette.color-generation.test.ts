import { describe, expect, it } from "vite-plus/test";
import {
  parseThemeFile,
  createManagedThemeColors,
  createVividThemeColors,
  getDefaultThemeColors,
  themeColorToHex,
  THEME_FILE_VERSION,
} from "./themePalette";
import { asHex, contrastRatio, canonical } from "./themePalette.test-support";

describe("theme color generation", () => {
  it("derives a readable palette from extreme simple-editor colors", () => {
    const light = createManagedThemeColors("light", "#111827", "#ffff00");
    const dark = createManagedThemeColors("dark", "#ffffff", "#ffff00");
    const darkDefaults = getDefaultThemeColors("dark");

    expect(asHex(light.canvas)).not.toBe("#111827");
    expect(asHex(dark.canvas)).not.toBe("#ffffff");
    expect(contrastRatio(light.accent, light.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accent, dark.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.textMuted, light.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.textMuted, dark.canvas)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(light.textMuted, light.canvas)).toBeLessThan(5.5);
    expect(contrastRatio(dark.textMuted, dark.canvas)).toBeLessThan(5.5);
    expect(contrastRatio(light.textMuted, light.canvas)).toBeCloseTo(4.705, 1);
    expect(contrastRatio(dark.textMuted, dark.canvas)).toBeCloseTo(5.082, 1);
    expect(light.secondaryLabel).toBe(light.textMuted);
    expect(dark.secondaryLabel).toBe(dark.textMuted);
    expect(contrastRatio(light.accentForeground, light.accent)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(dark.accentForeground, dark.accent)).toBeGreaterThanOrEqual(4.5);
    // Status colors fall back to T3 Code's standard red and amber rather than
    // the flagship palette's, so no generated theme inherits a brand tint.
    const channels = (value: string) =>
      [1, 3, 5].map((index) => Number.parseInt(asHex(value).slice(index, index + 2), 16)) as [
        number,
        number,
        number,
      ];
    for (const colors of [light, dark]) {
      const [errorRed, errorGreen, errorBlue] = channels(colors.error);
      // Red leads by a wide margin; the old default was a pink whose blue sat
      // close behind its red.
      expect(errorRed).toBeGreaterThan(errorGreen * 2);
      expect(errorRed).toBeGreaterThan(errorBlue * 2);
      expect(contrastRatio(colors.error, "#ffffff")).toBeGreaterThanOrEqual(2.5);
      expect(contrastRatio(colors.errorForeground, colors.errorSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      const [warnRed, warnGreen, warnBlue] = channels(colors.warning);
      expect(warnRed).toBeGreaterThan(warnBlue);
      expect(warnGreen).toBeGreaterThan(warnBlue);
    }
    expect(asHex(dark.error)).not.toBe(asHex(darkDefaults.error));
  });

  it("derives readable, distinctive vivid palettes from exact seeds", () => {
    const seeds: ReadonlyArray<["light" | "dark", string, string]> = [
      ["light", "#f4f9f2", "#1d8a4e"],
      ["dark", "#101a2c", "#4f8fe8"],
      ["dark", "#211a23", "#df5398"],
      ["light", "#fdf6ec", "#c2571b"],
      // Inverted canvases: the palette follows the picked color, not the slot.
      ["light", "#111827", "#8ab4f8"],
      ["dark", "#f5ecf5", "#a84370"],
    ];
    for (const [appearance, canvas, accent] of seeds) {
      const colors = createVividThemeColors(appearance, canvas, accent);
      // Exact seeds are honored.
      expect(colors.canvas).toMatch(/^oklch\(/);
      expect(colors.accent).toMatch(/^oklch\(/);
      expect(asHex(colors.canvas)).toBe(canvas);
      expect(asHex(colors.accent)).toBe(accent);
      // Readability is solved per surface.
      expect(contrastRatio(colors.text, colors.canvas)).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.textMuted, colors.canvas)).toBeLessThan(5.5);
      expect(contrastRatio(colors.mutedForeground, colors.muted)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.placeholder, colors.surfaceRaised)).toBeGreaterThanOrEqual(4.5);
      expect(colors.secondaryLabel).toBe(colors.textMuted);
      expect(contrastRatio(colors.accentForeground, colors.accent)).toBeGreaterThanOrEqual(4.5);
      expect(
        contrastRatio(colors.messageActionForeground, colors.messageAction),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(colors.messageForeground, colors.messageSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.secondaryForeground, colors.secondary)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.sidebarForeground, colors.sidebar)).toBeGreaterThanOrEqual(4.5);
      // The companion action is a distinct voice, not the accent again.
      expect(colors.messageAction).not.toBe(colors.accent);
      // Update family follows the theme, not the default palette.
      expect(asHex(colors.update)).toBe(accent);
    }
  });

  it("keys status colors off the canvas, not the appearance slot", () => {
    // Inverted seeds: a dark canvas in the light slot must still get the dark
    // status pair, or the alert foreground lands on a dark surface unreadable.
    const inverted = [
      createVividThemeColors("light", "#111827", "#8ab4f8"),
      createVividThemeColors("dark", "#f5ecf5", "#a84370"),
      createManagedThemeColors("light", "#0d1117", "#69b1ff", { exactSeeds: true }),
      createManagedThemeColors("dark", "#fdfdfd", "#c2571b", { exactSeeds: true }),
    ];
    for (const colors of inverted) {
      expect(contrastRatio(colors.errorForeground, colors.errorSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(contrastRatio(colors.warningForeground, colors.warningSurface)).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("decodes literal CSS color formats into OKLCH without dropping alpha", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Translucent",
      appearance: "light",
      colors: {
        canvas: "oklch(62% 0.2 280deg / 50%)",
        accent: "#abcd",
        focus: "rgb(10 20 30 / 50%)",
        error: "hsl(350 80% 50%)",
        warning: "hwb(45 10% 20%)",
        update: "lab(60% 40 30)",
        messageAction: "lch(60% 50 120)",
        sidebar: "oklab(0.6 0.1 -0.1)",
        terminalCursor: "color(display-p3 0.8 0.2 0.3)",
        terminalSelection: "rebeccapurple",
        terminalScrollbar: "transparent",
        terminalScrollbarHover: "rgb(10 20 30 / none)",
      },
    });

    expect(theme.colors.canvas).toBe("oklch(0.62 0.2 280 / 0.5)");
    expect(theme.colors.accent).toBe(canonical("#abcd"));
    expect(themeColorToHex(theme.colors.accent)).toBe("#aabbccdd");
    expect(themeColorToHex(theme.colors.focus)).toBe("#0a141e80");
    expect(themeColorToHex(theme.colors.terminalSelection)).toBe("#663399");
    expect(theme.colors.terminalScrollbar).toBe("oklch(0 0 0 / 0)");
    expect(themeColorToHex(theme.colors.terminalScrollbarHover)).toBe("#0a141e00");
    for (const role of [
      "error",
      "warning",
      "update",
      "messageAction",
      "sidebar",
      "terminalCursor",
    ] as const) {
      expect(theme.colors[role]).toMatch(/^oklch\(/);
    }
  });

  it("gamut maps extreme finite OKLCH chroma from theme files", () => {
    const theme = parseThemeFile({
      version: THEME_FILE_VERSION,
      name: "Extreme chroma",
      appearance: "light",
      colors: { accent: "oklch(0.5 1e303 0)" },
    });

    expect(theme.colors.accent).toBe("oklch(0.5 1e+303 0)");
    expect(themeColorToHex(theme.colors.accent)).toBe("#b5005e");
  });
});
