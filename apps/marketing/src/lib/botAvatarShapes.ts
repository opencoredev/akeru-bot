// Blob avatar geometry, copied from apps/web/src/components/roster/BotAvatarView.tsx
// and roster.logic.ts. Shared by BotAvatar.astro (static markup) and
// botAvatarRuntime.ts (the frame loop), so the first paint matches the rest frame.

import { REST_FRAME, wrapOnBelt, type MotionFrame } from "./botAvatarMotion";

const BOT_BLOB_SHAPES = [
  "circle",
  "squircle",
  "square",
  "pill",
  "triangle",
  "hex",
  "cloud",
  "drop",
] as const;

export type BotBlobShape = (typeof BOT_BLOB_SHAPES)[number];

/** Reads a shape name from markup, such as the `data-avatar-shape` attribute. */
export function parseBotBlobShape(value: string | undefined): BotBlobShape | null {
  return BOT_BLOB_SHAPES.find((shape) => shape === value) ?? null;
}

/** Where the face sits on each body, and how large it draws. */
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
export const BODY: Record<BotBlobShape, string> = {
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

/** Two slanted capsule eyes, relative to the face center. */
const EYES = [
  { x: -13, y: 1, rotate: -16 },
  { x: 13, y: -1, rotate: -20 },
] as const;

/** Radius the face travels on when it spins around the body. */
const BELT_RADIUS = 44;

/** Places one eye for a motion frame, or returns null while it is behind the body. */
export function eyeTransform(shape: BotBlobShape, frame: MotionFrame, index: 0 | 1) {
  const face = FACE_LAYOUT[shape];
  const eye = EYES[index];
  const pull = 0.42 * frame.pull;
  const faceX = face.x + (50 - face.x) * pull;
  const faceY = face.y + (50 - face.y) * pull;
  let x = faceX + (eye.x + frame.gazeX) * face.scale;
  const y = faceY + (eye.y + frame.gazeY) * face.scale;
  let width = frame.eyeWidth * face.scale;

  if (frame.spin !== 0) {
    const wrapped = wrapOnBelt(x, 50, BELT_RADIUS, frame.spin);

    if (!wrapped) return null;
    x = wrapped.x;
    width *= wrapped.width;
  }

  const height = frame.eyeHeight[index] * face.scale;

  return `translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${eye.rotate}) scale(${width.toFixed(3)} ${height.toFixed(3)})`;
}

export const restEyeTransform = (shape: BotBlobShape, index: 0 | 1) =>
  eyeTransform(shape, REST_FRAME, index) ?? "";

export function bodyTransform(frame: MotionFrame) {
  return `translate(${frame.x.toFixed(2)}%, ${frame.y.toFixed(2)}%) rotate(${frame.roll.toFixed(2)}deg) scale(1, ${frame.scaleY.toFixed(4)})`;
}

/** Stable 0..1 offset per name, so a row of working bots does not bob in unison. */
export function botAvatarSeed(seed: string): number {
  let hash = 0;

  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;

  return (Math.abs(hash) % 1000) / 1000;
}
