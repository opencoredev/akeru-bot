import { createTranslator } from "@akeru/client-runtime/i18n";
import type { BotAvatar, BotBlobShape } from "./types";

export const BLOB_SHAPES: readonly BotBlobShape[] = [
  "circle",
  "squircle",
  "square",
  "pill",
  "triangle",
  "hex",
  "cloud",
  "drop",
];

type Translate = (message: string, params?: Record<string, string | number>) => string;

const englishTranslate: Translate = createTranslator("en").translate;

/** Accessible name for a blob shape button; the shape value itself stays a wire enum. */
export function blobShapeLabel(shape: BotBlobShape, t: Translate = englishTranslate): string {
  switch (shape) {
    case "circle":
      return t("Circle");
    case "squircle":
      return t("Squircle");
    case "square":
      return t("Square");
    case "pill":
      return t("Pill");
    case "triangle":
      return t("Triangle");
    case "hex":
      return t("Hexagon");
    case "cloud":
      return t("Cloud");
    case "drop":
      return t("Drop");
  }
}

export const BLOB_COLORS: readonly string[] = [
  "#FF4A5A",
  "#FF7A1F",
  "#FFA826",
  "#16C47A",
  "#1FBFAE",
  "#2E8EFF",
  "#9A68FF",
  "#FF4FA8",
  "#A0764F",
  "#8E8E93",
];

export const DEFAULT_BLOB_SHAPE: BotBlobShape = "circle";
export const DEFAULT_BLOB_COLOR = "#8E8E93";
const DARK_EYES = "#161616";
const LIGHT_EYES = "#FFFFFF";

/** The muted presets bots were saved with before the palette went vivid. */
const LEGACY_BLOB_COLORS: Record<string, string> = {
  "#E0645C": "#FF4A5A",
  "#E8883A": "#FF7A1F",
  "#D9A833": "#FFA826",
  "#5BA97B": "#16C47A",
  "#4E9BB8": "#1FBFAE",
  "#5B7FD4": "#2E8EFF",
  "#8B6FC9": "#9A68FF",
  "#C96FA8": "#FF4FA8",
  "#7A8699": "#8E8E93",
};

/** Normalizes a stored body color, moving retired presets onto the current palette. */
export function resolveBlobColor(value: unknown) {
  if (!isBotAvatarColor(value)) return DEFAULT_BLOB_COLOR;
  const color = value.toUpperCase();
  return LEGACY_BLOB_COLORS[color] ?? color;
}

function relativeLuminance(hexColor: string) {
  const channels = hexColor
    .slice(1)
    .match(/.{2}/g)
    ?.map((channel) => Number.parseInt(channel, 16) / 255);

  if (!channels || channels.length !== 3 || channels.some(Number.isNaN)) return null;

  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/**
 * How the eyes are drawn. Most bodies cut their eyes out so the surface shows
 * through. Near-white and near-black bodies would lose cutout eyes against a
 * matching surface, so they paint them in a contrasting ink instead.
 */
export function resolveBlobEyes(color: string): { kind: "cutout" } | { kind: "ink"; ink: string } {
  const luminance = isBotAvatarColor(color) ? relativeLuminance(color) : null;
  if (luminance === null) return { kind: "cutout" };
  if (luminance > 0.6) return { kind: "ink", ink: DARK_EYES };
  if (luminance < 0.02) return { kind: "ink", ink: LIGHT_EYES };
  return { kind: "cutout" };
}

/** A faint edge for light bodies that would otherwise fade into a light surface. */
export function resolveBlobOutline(color: string) {
  const luminance = isBotAvatarColor(color) ? relativeLuminance(color) : null;
  return luminance !== null && luminance > 0.7 ? "rgba(0, 0, 0, 0.14)" : null;
}

export function isBotAvatarColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

export function isBotBlobShape(value: string): value is BotBlobShape {
  return (BLOB_SHAPES as readonly string[]).includes(value);
}

/**
 * Every avatar kind resolves to a paintable blob so the roster never renders
 * an empty slot. Legacy dither avatars, which delegated bots and imports still
 * carry, become a blob picked from their seed so each bot keeps a stable,
 * distinct look. Image avatars and unknown blob shapes from persisted or
 * server data fall back to the default circle.
 */
export function resolveBlobRendering(avatar: BotAvatar | null | undefined): {
  shape: BotBlobShape;
  color: string;
} {
  if (avatar?.kind === "dither") {
    const hash = Math.abs(hashSeed(avatar.seed));
    return {
      shape: BLOB_SHAPES[hash % BLOB_SHAPES.length] ?? DEFAULT_BLOB_SHAPE,
      color:
        BLOB_COLORS[Math.floor(hash / BLOB_SHAPES.length) % BLOB_COLORS.length] ??
        DEFAULT_BLOB_COLOR,
    };
  }
  if (avatar?.kind !== "blob") {
    return { shape: DEFAULT_BLOB_SHAPE, color: DEFAULT_BLOB_COLOR };
  }
  // Unknown names (including the retired creature set) fall back to the
  // default circle rather than an empty slot.
  return {
    shape: isBotBlobShape(avatar.shape) ? avatar.shape : DEFAULT_BLOB_SHAPE,
    color: resolveBlobColor(avatar.color),
  };
}

/** Random blob avatar for a freshly created bot. `random` is injectable for tests. */
export function randomBotAvatar(
  random: () => number = Math.random,
): Extract<BotAvatar, { kind: "blob" }> {
  const shape = BLOB_SHAPES[Math.floor(random() * BLOB_SHAPES.length)] ?? DEFAULT_BLOB_SHAPE;
  const color = BLOB_COLORS[Math.floor(random() * BLOB_COLORS.length)] ?? DEFAULT_BLOB_COLOR;
  return { kind: "blob", shape, color };
}

/**
 * Stable 0–1 motion seed per bot, so a roster full of avatars never blinks or
 * glances in sync.
 */
export function botAvatarSeed(seed: string): number {
  return (Math.abs(hashSeed(seed)) % 1000) / 1000;
}

function hashSeed(seed: string) {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  return hash;
}
