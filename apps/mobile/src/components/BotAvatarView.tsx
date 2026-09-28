import type { BotAvatar } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState } from "react";
import { View } from "react-native";
import Svg, { Mask, Path, Rect } from "react-native-svg";

/**
 * Native port of the web roster's flat bot avatars (BotAvatarView.tsx in
 * apps/web): the same 100×100 body geometry and slanted capsule eyes, drawn
 * statically. Native rows never animate; a looping avatar would repaint the
 * list on every frame. Dither and image avatars fall back to a blob so a
 * roster slot is never empty.
 */

type BotBlobShape =
  | "circle"
  | "squircle"
  | "square"
  | "pill"
  | "triangle"
  | "hex"
  | "cloud"
  | "drop";

/** What the bot is doing. Only the eye shape carries it; nothing moves. */
export type BotAvatarState = "idle" | "working" | "needs-you";

const DEFAULT_BLOB_SHAPE: BotBlobShape = "circle";
const DEFAULT_BLOB_COLOR = "#8E8E93";
const DARK_EYES = "#161616";
const LIGHT_EYES = "#FFFFFF";

const BLOB_SHAPES: ReadonlyArray<BotBlobShape> = [
  "circle",
  "squircle",
  "square",
  "pill",
  "triangle",
  "hex",
  "cloud",
  "drop",
];

const BLOB_COLORS: readonly string[] = [
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

/**
 * Where the face sits on the 100×100 viewBox. It looks up and to the right;
 * bottom-heavy shapes (triangle, drop) carry it lower and smaller.
 */
const FACE_LAYOUT: Record<BotBlobShape, { x: number; y: number; scale: number }> = {
  circle: { x: 66, y: 40, scale: 1.1 },
  squircle: { x: 64, y: 42, scale: 1.1 },
  square: { x: 66, y: 40, scale: 1.1 },
  pill: { x: 64, y: 46, scale: 1 },
  triangle: { x: 50, y: 64, scale: 0.85 },
  hex: { x: 64, y: 42, scale: 1.1 },
  cloud: { x: 62, y: 50, scale: 1 },
  drop: { x: 57, y: 62, scale: 1 },
};

/** Flat body geometry on a 100×100 viewBox. Each shape fills the frame. */
const BODY: Record<BotBlobShape, string> = {
  circle: "M4 50A46 46 0 1 1 96 50A46 46 0 1 1 4 50Z",
  squircle:
    "M96.8 50C97.5 55.5 97.4 62 95.3 67.3C93.3 72.6 89.2 78.2 84.6 81.9C80 85.5 73.4 87.9 67.6 89.1C61.8 90.4 55.6 89.9 50 89.4C44.4 88.9 39.1 87.7 33.8 86C28.5 84.3 23 82.4 18.3 79.2C13.7 76 8.7 71.7 5.9 66.8C3.1 62 1.3 55.6 1.4 50C1.5 44.4 3.6 38.3 6.3 33.3C9 28.3 13.3 23.8 17.7 20.2C22 16.5 27.3 13.4 32.7 11.4C38.1 9.4 44.2 8.1 50 8.1C55.8 8.2 62 9.5 67.2 11.7C72.4 13.9 77.2 17.5 81.2 21.2C85.2 25 88.6 29.5 91.2 34.3C93.8 39.1 96.1 44.5 96.8 50Z",
  square: "M30 6H70C88 6 94 12 94 30V70C94 88 88 94 70 94H30C12 94 6 88 6 70V30C6 12 12 6 30 6Z",
  pill: "M34 19H66A31 31 0 0 1 66 81H34A31 31 0 0 1 34 19Z",
  triangle: "M35.6 28.3Q50 2 64.4 28.3L89.9 75.1Q98 90 81 90L19 90Q2 90 10.1 75.1Z",
  hex: "M42.2 5.5Q50 1 57.8 5.5L84.6 21Q92.4 25.5 92.4 34.5L92.4 65.5Q92.4 74.5 84.6 79L57.8 94.5Q50 99 42.2 94.5L15.4 79Q7.6 74.5 7.6 65.5L7.6 34.5Q7.6 25.5 15.4 21Z",
  cloud:
    "M31 80.7A20 20 0 1 1 16.7 43.4A22 22 0 0 1 53.4 22.3A19 19 0 0 1 82.3 43A20 20 0 0 1 69 80.7A24 24 0 0 1 31 80.7Z",
  drop: "M42.6 12.4Q50 3 57.4 12.4L78.2 38.7A36 36 0 1 1 21.8 38.7Z",
};

/** The two slanted capsule eyes, relative to the face origin. */
const EYES = [
  { x: -13, y: 1, rotate: -16 },
  { x: 13, y: -1, rotate: -20 },
] as const;

/** How tall the eyes stand. Working squints at the work; needs-you widens. */
const EYE_HEIGHT: Record<BotAvatarState, number> = {
  idle: 1,
  working: 0.58,
  "needs-you": 1.18,
};

function isBotBlobShape(value: string): value is BotBlobShape {
  return (BLOB_SHAPES as readonly string[]).includes(value);
}

function isBotAvatarColor(value: unknown): value is string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value);
}

function relativeLuminance(hexColor: string): number | null {
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

/** Normalizes a stored body color, moving retired presets onto the current palette. */
function resolveBlobColor(value: unknown): string {
  if (!isBotAvatarColor(value)) return DEFAULT_BLOB_COLOR;
  const color = value.toUpperCase();
  return LEGACY_BLOB_COLORS[color] ?? color;
}

/**
 * How the eyes are drawn. Most bodies cut their eyes out so the surface shows
 * through; near-white and near-black bodies paint them in a contrasting ink.
 */
function resolveBlobEyes(color: string): { kind: "cutout" } | { kind: "ink"; ink: string } {
  const luminance = isBotAvatarColor(color) ? relativeLuminance(color) : null;
  if (luminance === null) return { kind: "cutout" };
  if (luminance > 0.6) return { kind: "ink", ink: DARK_EYES };
  if (luminance < 0.02) return { kind: "ink", ink: LIGHT_EYES };
  return { kind: "cutout" };
}

/** A faint edge for light bodies that would otherwise fade into a light surface. */
function resolveBlobOutline(color: string): string | null {
  const luminance = isBotAvatarColor(color) ? relativeLuminance(color) : null;
  return luminance !== null && luminance > 0.7 ? "rgba(0, 0, 0, 0.14)" : null;
}

function hashSeed(seed: string): number {
  let hash = 5381;
  for (let index = 0; index < seed.length; index += 1) {
    hash = ((hash << 5) + hash + seed.charCodeAt(index)) | 0;
  }
  return hash;
}

/** Every avatar kind resolves to a paintable blob (dither/image fall back). */
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
  return {
    shape: isBotBlobShape(avatar.shape) ? avatar.shape : DEFAULT_BLOB_SHAPE,
    color: resolveBlobColor(avatar.color),
  };
}

function eyeTransform(shape: BotBlobShape, state: BotAvatarState, index: 0 | 1): string {
  const face = FACE_LAYOUT[shape];
  const eye = EYES[index];
  const x = face.x + eye.x * face.scale;
  const y = face.y + eye.y * face.scale;
  return `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${eye.rotate}) scale(${face.scale.toFixed(3)} ${(EYE_HEIGHT[state] * face.scale).toFixed(3)})`;
}

function Eyes({ shape, state, ink }: { shape: BotBlobShape; state: BotAvatarState; ink: string }) {
  return (
    <>
      {([0, 1] as const).map((index) => (
        <Rect
          key={index}
          x={-4.2}
          y={-8.8}
          width={8.4}
          height={17.6}
          rx={4.2}
          fill={ink}
          transform={eyeTransform(shape, state, index)}
        />
      ))}
    </>
  );
}

/**
 * Renders a bot avatar at a caller-supplied size, statically (no looping
 * animation — that repaints the whole list on high-refresh displays). Image
 * avatars render their stored picture; every other kind resolves to a blob.
 */
export function BotAvatarView(props: {
  readonly avatar: BotAvatar | null | undefined;
  readonly size: number;
  readonly state?: BotAvatarState;
}) {
  if (props.avatar?.kind === "image" && props.avatar.assetPath.length > 0) {
    return (
      <BotImageAvatar assetPath={props.avatar.assetPath} size={props.size} state={props.state} />
    );
  }
  return <BotBlobAvatar avatar={props.avatar} size={props.size} state={props.state} />;
}

/**
 * A bot's uploaded picture. `assetPath` is a self-contained data URL written
 * by the avatar picker, so there is no environment URL to resolve. The blob
 * sits underneath and takes over if the picture cannot be decoded, so a
 * roster slot is never empty.
 */
function BotImageAvatar(props: {
  readonly assetPath: string;
  readonly size: number;
  readonly state?: BotAvatarState;
}) {
  const [failedPath, setFailedPath] = useState<string | null>(null);
  if (failedPath === props.assetPath) {
    return <BotBlobAvatar avatar={null} size={props.size} state={props.state} />;
  }
  return (
    <View style={{ height: props.size, width: props.size }}>
      <BotBlobAvatar avatar={null} size={props.size} state={props.state} />
      <Image
        source={{ uri: props.assetPath }}
        accessibilityIgnoresInvertColors
        cachePolicy="memory-disk"
        contentFit="cover"
        onError={() => setFailedPath(props.assetPath)}
        style={{
          borderRadius: props.size / 2,
          height: props.size,
          left: 0,
          position: "absolute",
          top: 0,
          width: props.size,
        }}
      />
    </View>
  );
}

function BotBlobAvatar(props: {
  readonly avatar: BotAvatar | null | undefined;
  readonly size: number;
  readonly state?: BotAvatarState;
}) {
  const { shape, color } = resolveBlobRendering(props.avatar);
  const state = props.state ?? "idle";
  const eyes = resolveBlobEyes(color);
  const outline = resolveBlobOutline(color);
  const body = BODY[shape];
  const maskId = `bot-eyes-${shape}-${color.slice(1)}-${state}`;
  return (
    <View style={{ height: props.size, width: props.size }}>
      <Svg height={props.size} viewBox="0 0 100 100" width={props.size}>
        {eyes.kind === "ink" ? (
          <>
            {outline ? <Path d={body} fill="none" stroke={outline} strokeWidth={3} /> : null}
            <Path d={body} fill={color} />
            <Eyes shape={shape} state={state} ink={eyes.ink} />
          </>
        ) : (
          <>
            <Mask id={maskId} maskUnits="userSpaceOnUse" x={-10} y={-10} width={120} height={120}>
              <Rect x={-10} y={-10} width={120} height={120} fill="#fff" />
              <Eyes shape={shape} state={state} ink="#000" />
            </Mask>
            <Path d={body} fill={color} mask={`url(#${maskId})`} />
          </>
        )}
      </Svg>
    </View>
  );
}

/**
 * Deterministic blob avatar for threads without a configured bot: the same
 * seed (provider driver or thread id) always yields the same body, so rows
 * stay stable across renders and sessions.
 */
export function seededBlobAvatar(seed: string): BotAvatar {
  const positive = Math.abs(hashSeed(seed));
  return {
    kind: "blob",
    shape: BLOB_SHAPES[positive % BLOB_SHAPES.length]!,
    color: BLOB_COLORS[Math.floor(positive / BLOB_SHAPES.length) % BLOB_COLORS.length]!,
  };
}
