export interface HsvColor {
  readonly h: number;
  readonly s: number;
  readonly v: number;
}

const HEX_COLOR = /^#?([\da-f]{6})$/i;

export function hexToHsv(value: string): HsvColor | null {
  const hex = HEX_COLOR.exec(value.trim())?.[1];
  if (!hex) return null;

  const numeric = Number.parseInt(hex, 16);
  const red = ((numeric >> 16) & 255) / 255;
  const green = ((numeric >> 8) & 255) / 255;
  const blue = (numeric & 255) / 255;
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;

  let hue = 0;
  if (delta !== 0) {
    if (max === red) hue = ((green - blue) / delta) % 6;
    else if (max === green) hue = (blue - red) / delta + 2;
    else hue = (red - green) / delta + 4;
    hue = (hue * 60 + 360) % 360;
  }

  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

export function hsvToHex({ h, s, v }: HsvColor): string {
  const channel = (offset: number) => {
    const k = (offset + h / 60) % 6;
    const value = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };

  return `#${channel(5)}${channel(3)}${channel(1)}`.toUpperCase();
}

export function clampColorFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function formatColorFieldValueText(color: HsvColor, hex: string): string {
  return `Saturation ${Math.round(color.s * 100)}%, brightness ${Math.round(color.v * 100)}%, ${hex}`;
}
