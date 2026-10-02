import { themeColorToHex, type ThemeColorRole } from "../../themePalette";

export function getThemeRoleLabel(role: ThemeColorRole): string {
  const labels: Partial<Record<ThemeColorRole, string>> = {
    canvas: "Background",
    toolbar: "Toolbar background",
    toolbarForeground: "Toolbar text",
    toolbarBorder: "Toolbar border",
    toolbarControl: "Toolbar control",
    toolbarControlForeground: "Toolbar control text",
    toolbarControlHover: "Toolbar control hover",
    accent: "Accent color",
    errorForeground: "Error text",
    errorSurface: "Error background",
    warningForeground: "Warning text",
    warningSurface: "Warning background",
    updateForeground: "Update text",
    updateSurface: "Update background",
  };

  const label = labels[role];

  if (label) return label;

  return role.replace(/([A-Z])/g, " $1").replace(/^./, (character) => character.toUpperCase());
}

export type ThemeColorHsv = {
  h: number;
  s: number;
  v: number;
};

export function clampThemeColor(value: number, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

/**
 * The picker remains an sRGB/hex adapter over the OKLCH palette engine. Alpha
 * is preserved separately and re-attached on commit so adjusting hue or
 * brightness cannot change transparency.
 */
export function themePickerAlphaSuffix(value: string): string {
  const normalized = themeColorToHex(value) ?? "";
  const alpha = normalized.length === 9 ? normalized.slice(7) : "";

  return alpha === "ff" ? "" : alpha;
}

export function normalizeThemePickerColor(value: string): string {
  return (themeColorToHex(value) ?? "#000000").slice(0, 7);
}

export function themeHexToHsv(hex: string): ThemeColorHsv {
  const normalized = normalizeThemePickerColor(hex);
  const numeric = Number.parseInt(normalized.slice(1), 16);
  const red = ((numeric >> 16) & 255) / 255;
  const green = ((numeric >> 8) & 255) / 255;
  const blue = (numeric & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;

  if (delta !== 0) {
    if (max === red) {
      hue = ((green - blue) / delta) % 6;
    } else if (max === green) {
      hue = (blue - red) / delta + 2;
    } else {
      hue = (red - green) / delta + 4;
    }

    hue *= 60;

    if (hue < 0) hue += 360;
  }

  return {
    h: hue,
    s: max === 0 ? 0 : delta / max,
    v: max,
  };
}

export function themeHsvToHex(hue: number, saturation: number, value: number) {
  const normalizedHue = ((hue % 360) + 360) % 360;
  const chroma = value * saturation;
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1));
  const match = value - chroma;

  const [red, green, blue] =
    normalizedHue < 60
      ? [chroma, x, 0]
      : normalizedHue < 120
        ? [x, chroma, 0]
        : normalizedHue < 180
          ? [0, chroma, x]
          : normalizedHue < 240
            ? [0, x, chroma]
            : normalizedHue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];

  return `#${[red, green, blue]
    .map((channel) =>
      Math.round((channel + match) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

export function themeHexToRgb(hex: string) {
  const numeric = Number.parseInt(normalizeThemePickerColor(hex).slice(1), 16);

  return [numeric >> 16, (numeric >> 8) & 255, numeric & 255] as const;
}

export function themeRgbToHex(value: string): string | null {
  const normalized = value
    .trim()
    .replace(/^rgb\(\s*/i, "")
    .replace(/\s*\)$/, "");

  const channels = normalized
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(Number);

  if (
    channels.length !== 3 ||
    channels.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)
  ) {
    return null;
  }

  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function themeRgbValue(hex: string) {
  return themeHexToRgb(hex).join(", ");
}
