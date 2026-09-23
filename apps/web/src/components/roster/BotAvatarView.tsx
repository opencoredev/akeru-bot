import { useEffect, useId, useRef, type RefObject } from "react";

import { cn } from "~/lib/utils";
import { IDLE_BEAT_LENGTH_MS, subscribeIdleBeat } from "./botAvatarIdleBeat";
import { BotMotion, REST_FRAME, wrapOnBelt, type MotionFrame } from "./botAvatarMotion";
import {
  botAvatarSeed,
  resolveBlobEyes,
  resolveBlobOutline,
  resolveBlobRendering,
} from "./roster.logic";
import type { BotAvatar, BotBlobShape } from "./types";

/**
 * What a bot is doing. `working` sways, glances down at its work, and spins
 * now and then for as long as the turn runs; `idle` and `needs-you` rest still
 * and only move on hover or during the rare idle beat. The presence dot
 * carries needs-you.
 */
export type BotAnimationState = "idle" | "working" | "needs-you";

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

/** Radius the face travels on when it spins around the body. */
const BELT_RADIUS = 44;

/** Places one eye for a motion frame, or returns null while it is behind the body. */
function eyeTransform(shape: BotBlobShape, frame: MotionFrame, index: 0 | 1) {
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

function bodyTransform(frame: MotionFrame) {
  return `translate(${frame.x.toFixed(2)}%, ${frame.y.toFixed(2)}%) rotate(${frame.roll.toFixed(2)}deg) scale(1, ${frame.scaleY.toFixed(4)})`;
}

/** Two slanted capsule eyes. The motion engine rewrites their transforms. */
function Eyes({
  shape,
  ink,
  eyeRefs,
}: {
  shape: BotBlobShape;
  ink: string;
  eyeRefs: RefObject<Array<SVGRectElement | null>>;
}) {
  return (
    <g className="bot-eyes" fill={ink}>
      {([0, 1] as const).map((index) => (
        <rect
          key={index}
          ref={(node) => {
            eyeRefs.current[index] = node;
          }}
          x="-4.2"
          y="-8.8"
          width="8.4"
          height="17.6"
          rx="4.2"
          transform={eyeTransform(shape, REST_FRAME, index) ?? undefined}
        />
      ))}
    </g>
  );
}

/**
 * The body and its face. Eyes are cut out of the body so the surface shows
 * through. Colors too light or dark for that to read paint the eyes on
 * instead, and light bodies add a faint outline.
 */
function BlobFigure({
  shape,
  color,
  eyeRefs,
}: {
  shape: BotBlobShape;
  color: string;
  eyeRefs: RefObject<Array<SVGRectElement | null>>;
}) {
  const maskId = `bot-eyes-${useId().replace(/[^\w-]/g, "")}`;
  const d = BODY[shape];
  const eyes = resolveBlobEyes(color);
  const outline = resolveBlobOutline(color);
  if (eyes.kind === "ink") {
    return (
      <>
        {outline && <path d={d} fill="none" stroke={outline} strokeWidth="3" />}
        <path d={d} fill={color} />
        <Eyes shape={shape} ink={eyes.ink} eyeRefs={eyeRefs} />
      </>
    );
  }
  return (
    <>
      <mask id={maskId} maskUnits="userSpaceOnUse" x="-10" y="-10" width="120" height="120">
        <rect x="-10" y="-10" width="120" height="120" fill="#fff" />
        <Eyes shape={shape} ink="#000" eyeRefs={eyeRefs} />
      </mask>
      <path d={d} fill={color} mask={`url(#${maskId})`} />
    </>
  );
}

/**
 * A flat blob avatar with a face, moved by a spring engine (see
 * botAvatarMotion). It animates only while the bot works, while the pointer
 * is over the avatar or its `[data-bot-hover]` row, and for the rare idle
 * beat. Hovered eyes follow the pointer. The frame loop stops once the springs
 * settle and pauses while the avatar is off screen.
 */
function BlobAvatar({
  shape,
  color,
  name,
  state,
  className,
}: {
  shape: BotBlobShape;
  color: string;
  name: string;
  state: BotAnimationState;
  className?: string | undefined;
}) {
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const bodyRef = useRef<HTMLSpanElement>(null);
  const eyeRefs = useRef<Array<SVGRectElement | null>>([null, null]);
  const working = state === "working";
  const workingRef = useRef(working);
  const wakeRef = useRef<() => void>(() => {});
  const motionRef = useRef<BotMotion | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    const body = bodyRef.current;
    if (!wrapper || !body) return;
    const motion = (motionRef.current = new BotMotion(botAvatarSeed(name)));
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const hoverTarget = wrapper.closest<HTMLElement>("[data-bot-hover]") ?? wrapper;
    let hovered = false;
    let pointer: { x: number; y: number } | null = null;
    let visible = true;
    let frameId: number | null = null;
    let last = 0;

    const render = (frame: MotionFrame) => {
      body.style.transform = bodyTransform(frame);
      for (const index of [0, 1] as const) {
        const eye = eyeRefs.current[index];
        if (!eye) continue;
        const transform = eyeTransform(shape, frame, index);
        eye.setAttribute("visibility", transform ? "visible" : "hidden");
        if (transform) eye.setAttribute("transform", transform);
      }
    };

    const tick = (time: number) => {
      const dt = last === 0 ? 1 / 60 : (time - last) / 1000;
      last = time;
      const { frame, active } = motion.tick(dt, {
        working: workingRef.current,
        hovered,
        pointer,
        reducedMotion: reducedMotion.matches,
      });
      render(frame);
      frameId = active && visible ? requestAnimationFrame(tick) : null;
      if (frameId === null) last = 0;
    };

    const wake = () => {
      if (frameId === null && visible) frameId = requestAnimationFrame(tick);
    };
    wakeRef.current = wake;

    const onEnter = (event: PointerEvent) => {
      hovered = true;
      onMove(event);
      wake();
    };
    const onMove = (event: PointerEvent) => {
      const rect = wrapper.getBoundingClientRect();
      const clamp = (value: number) => Math.max(-0.6, Math.min(0.6, value)) / 0.6;
      pointer = {
        x: clamp((event.clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1)),
        y: clamp((event.clientY - (rect.top + rect.height / 2)) / Math.max(rect.height, 1)),
      };
    };
    const onLeave = () => {
      hovered = false;
      pointer = null;
      wake();
    };
    reducedMotion.addEventListener("change", wake);
    hoverTarget.addEventListener("pointerenter", onEnter);
    hoverTarget.addEventListener("pointermove", onMove);
    hoverTarget.addEventListener("pointerleave", onLeave);

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      if (visible) wake();
    });
    observer.observe(wrapper);
    wake();

    return () => {
      reducedMotion.removeEventListener("change", wake);
      hoverTarget.removeEventListener("pointerenter", onEnter);
      hoverTarget.removeEventListener("pointermove", onMove);
      hoverTarget.removeEventListener("pointerleave", onLeave);
      observer.disconnect();
      if (frameId !== null) cancelAnimationFrame(frameId);
      wakeRef.current = () => {};
      motionRef.current = null;
    };
  }, [name, shape]);

  useEffect(() => {
    workingRef.current = working;
    wakeRef.current();
  }, [working]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || working) return;
    return subscribeIdleBeat(wrapper, () => {
      motionRef.current?.beat(IDLE_BEAT_LENGTH_MS);
      wakeRef.current();
    });
  }, [working]);

  return (
    <span
      ref={wrapperRef}
      aria-hidden
      className={cn("bot-avatar relative inline-block shrink-0 select-none", className)}
      data-avatar-shape={shape}
      data-bot-state={state}
    >
      <span ref={bodyRef} className="bot-body">
        <svg viewBox="0 0 100 100" overflow="visible" className="size-full">
          <BlobFigure shape={shape} color={color} eyeRefs={eyeRefs} />
        </svg>
      </span>
    </span>
  );
}

/**
 * Renders any bot avatar at a caller-supplied size. Image avatars paint the
 * asset; everything else draws as a blob, with legacy dither seeds picking its
 * shape and color. Malformed data falls back to the default blob. `name`
 * offsets the motion so a row of working bots does not bob in unison.
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
  return <BlobAvatar shape={shape} color={color} name={name} state={state} className={className} />;
}
