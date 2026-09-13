import { useMemo, type CSSProperties } from "react";

import { cn } from "~/lib/utils";
import { generateDitherIdenticon, identiconPathData } from "./dither.logic";
import { blinkDelayMs, resolveBlobEyeColor, resolveBlobRendering } from "./roster.logic";
import type { BotAvatar, BotBlobShape } from "./types";

/**
 * Animation states a bot avatar can play. `idle` blinks; `working` loops
 * while a turn runs; `needs-you` calls the user over; `success` runs once on
 * a clean finish. The matching keyframes live in index.css under "Bot
 * avatars".
 */
export type BotAnimationState = "idle" | "working" | "needs-you" | "success";

/**
 * Where the face sits on the 100×100 viewBox. Bottom-heavy shapes (triangle,
 * drop) carry the face lower; small bodies (pill, cloud) shrink it a touch.
 */
const FACE_LAYOUT: Record<BotBlobShape, { y: number; scale: number }> = {
  circle: { y: 50, scale: 1 },
  squircle: { y: 50, scale: 1 },
  square: { y: 50, scale: 1 },
  pill: { y: 50, scale: 0.88 },
  triangle: { y: 63, scale: 0.85 },
  hex: { y: 51, scale: 0.95 },
  cloud: { y: 57, scale: 0.88 },
  drop: { y: 63, scale: 0.85 },
};

/**
 * Blob geometry on a 100×100 viewBox. Soft corners come from a round-joined
 * stroke in the fill color, so every shape reads as one solid blob.
 */
function BlobShape({ shape, color }: { shape: BotBlobShape; color: string }) {
  const soft = { fill: color, stroke: color, strokeWidth: 10, strokeLinejoin: "round" } as const;
  switch (shape) {
    case "circle":
      // Hand-wobbled circle so the body reads organic, not geometric.
      return (
        <path
          d="M96 51 C96 64 92.6 74.4 84.6 82.2 C76.6 90 64 96 51 96 C38 96 26.2 91 18.2 83 C10.2 75 4 63 4 50 C4 37 9.4 25.4 18.4 17.6 C27.4 9.8 39 4 52 4 C65 4 76.4 10 84.4 18 C92.4 26 96 38 96 51 Z"
          fill={color}
        />
      );
    case "squircle":
      return (
        <path
          d="M50 2 C86 2 98 14 98 50 C98 86 86 98 50 98 C14 98 2 86 2 50 C2 14 14 2 50 2 Z"
          fill={color}
        />
      );
    case "square":
      return <rect x="5" y="5" width="90" height="90" rx="16" fill={color} />;
    case "pill":
      return <rect x="2" y="22" width="96" height="56" rx="28" fill={color} />;
    case "triangle":
      return <path d="M50 10 L92 88 L8 88 Z" {...soft} />;
    case "hex":
      return <path d="M50 4 L90 27 L90 73 L50 96 L10 73 L10 27 Z" {...soft} />;
    case "cloud":
      return (
        <path d="M30 82 A17 17 0 0 1 26 49 A22 22 0 0 1 66 35 A19 19 0 0 1 74 82 Z" {...soft} />
      );
    case "drop":
      return (
        <path d="M50 6 C50 6 86 46 86 64 A36 36 0 1 1 14 64 C14 46 50 6 50 6 Z" fill={color} />
      );
  }
}

/**
 * Two slanted ink-bar eyes, swapped per state. Working shortens the bars into
 * a focused face. Needs-you raises and spreads them. Success closes them into
 * happy arcs.
 */
function Eyes({ state, color }: { state: BotAnimationState; color: string }) {
  switch (state) {
    case "working":
      return (
        <>
          <rect
            x="-13.5"
            y="0"
            width="9"
            height="10"
            rx="4.5"
            transform="rotate(14 -9 5)"
            fill={color}
          />
          <rect
            x="4.5"
            y="0"
            width="9"
            height="10"
            rx="4.5"
            transform="rotate(14 9 5)"
            fill={color}
          />
        </>
      );
    case "needs-you":
      return (
        <>
          <rect
            x="-15.5"
            y="-14"
            width="9"
            height="26"
            rx="4.5"
            transform="rotate(10 -11 0)"
            fill={color}
          />
          <rect
            x="6.5"
            y="-14"
            width="9"
            height="26"
            rx="4.5"
            transform="rotate(10 11 0)"
            fill={color}
          />
        </>
      );
    case "success":
      return (
        <>
          <path
            d="M-17 1 Q-11 -9 -5 1"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            fill="none"
          />
          <path
            d="M5 1 Q11 -9 17 1"
            stroke={color}
            strokeWidth="4"
            strokeLinecap="round"
            fill="none"
          />
        </>
      );
    case "idle":
      return (
        <>
          <rect
            x="-14"
            y="-10"
            width="9"
            height="20"
            rx="4.5"
            transform="rotate(14 -9.5 0)"
            fill={color}
          />
          <rect
            x="5"
            y="-10"
            width="9"
            height="20"
            rx="4.5"
            transform="rotate(14 9.5 0)"
            fill={color}
          />
        </>
      );
  }
}

/**
 * The face. A nested svg owns the blink so scaleY uses that svg's viewBox,
 * not a <g> fill-box that collapses as the eyes close and strobes the avatar.
 */
function Face({
  shape,
  state,
  color,
}: {
  shape: BotBlobShape;
  state: BotAnimationState;
  color: string;
}) {
  const { y, scale } = FACE_LAYOUT[shape];
  return (
    <g transform={`translate(50 ${y}) scale(${scale})`}>
      <svg
        className="bot-eyes"
        x="-22"
        y="-18"
        width="44"
        height="36"
        viewBox="-22 -18 44 36"
        overflow="visible"
        aria-hidden
      >
        <Eyes state={state} color={color} />
      </svg>
    </g>
  );
}

/**
 * Dither Kit identicon rendered from the seed alone: no stored bitmap, the
 * generator is deterministic. One background rect and one path keep it a
 * two-element SVG at every size.
 */
function DitherAvatar({ seed, className }: { seed: string; className?: string | undefined }) {
  const identicon = useMemo(() => generateDitherIdenticon(seed), [seed]);
  return (
    <svg
      viewBox={`0 0 ${identicon.size} ${identicon.size}`}
      aria-hidden
      className={cn("shrink-0 select-none rounded-full", className)}
      data-avatar-dither={seed}
    >
      <rect width={identicon.size} height={identicon.size} fill={identicon.background} />
      <path
        d={identiconPathData(identicon)}
        fill={identicon.foreground}
        shapeRendering="crispEdges"
      />
    </svg>
  );
}

/**
 * Renders any bot avatar at a caller-supplied size. Image avatars paint the
 * asset; dither avatars render their seeded identicon; blob avatars get a
 * face. Malformed data falls back to the default blob. `name` seeds the blink
 * phase so bots blink out of sync; `state` picks the animation the CSS plays.
 */
export function BotAvatarView({
  avatar,
  name,
  state = "idle",
  className,
}: {
  avatar: BotAvatar;
  name: string;
  state?: BotAnimationState;
  className?: string;
}) {
  if (avatar.kind === "dither") {
    return <DitherAvatar seed={avatar.seed} className={className} />;
  }

  if (avatar.kind === "image" && avatar.assetPath.length > 0) {
    return (
      <img
        src={avatar.assetPath}
        alt=""
        aria-hidden
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  }

  const { shape, color } = resolveBlobRendering(avatar);
  const eyeColor = resolveBlobEyeColor(color);
  return (
    <svg
      viewBox="0 0 100 100"
      aria-hidden
      overflow="visible"
      className={cn("bot-avatar shrink-0 select-none", className)}
      data-avatar-shape={shape}
      data-bot-state={state}
      style={{ "--bot-blink-delay": `${blinkDelayMs(name)}ms` } as CSSProperties}
    >
      <g className="bot-body">
        <BlobShape shape={shape} color={color} />
        <Face shape={shape} state={state} color={eyeColor} />
      </g>
    </svg>
  );
}
