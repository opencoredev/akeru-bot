// The frame loop from apps/web/src/components/roster/BotAvatarView.tsx, without React.
// An avatar animates only while it works, while the pointer is over it or its
// `[data-bot-hover]` row, and for the rare idle beat. The loop stops once the
// springs settle and pauses while the avatar is off screen.

import { IDLE_BEAT_LENGTH_MS, subscribeIdleBeat } from "./botAvatarIdleBeat";
import { BotMotion, type MotionFrame } from "./botAvatarMotion";
import { bodyTransform, botAvatarSeed, eyeTransform, parseBotBlobShape } from "./botAvatarShapes";

/** Minimum frame spacing for the working pose, about 30fps with rAF jitter headroom. */
const WORKING_FRAME_MS = 1000 / 30 - 2;

export interface BotAvatarHandle {
  setWorking(working: boolean): void;
  /** Plays a short burst of motion, as the idle beat does. */
  beat(ms?: number): void;
}

const handles = new WeakMap<HTMLElement, BotAvatarHandle>();

export function mountBotAvatar(wrapper: HTMLElement): BotAvatarHandle | null {
  const existing = handles.get(wrapper);

  if (existing) return existing;
  const body = wrapper.querySelector<HTMLElement>(".bot-body");
  const shape = parseBotBlobShape(wrapper.dataset.avatarShape);

  if (!body || !shape) return null;

  const eyes = Array.from(wrapper.querySelectorAll<SVGRectElement>(".bot-eyes rect"));
  const motion = new BotMotion(botAvatarSeed(wrapper.dataset.name ?? ""));
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const hoverTarget = wrapper.closest<HTMLElement>("[data-bot-hover]") ?? wrapper;
  let working = wrapper.dataset.botState === "working";
  let hovered = false;
  let pointer: { x: number; y: number } | null = null;
  let visible = true;
  let frameId: number | null = null;
  let last = 0;
  // Last values written to the DOM, so settled or repeated poses cost no style work.
  let lastBody = "";
  const lastEyes = eyes.map(() => ({ transform: "", visible: true }));
  let unsubscribeIdle: (() => void) | null = null;

  const render = (frame: MotionFrame) => {
    const nextBody = bodyTransform(frame);

    if (nextBody !== lastBody) {
      body.style.transform = nextBody;
      lastBody = nextBody;
    }

    eyes.forEach((eye, i) => {
      const written = lastEyes[i];

      if (!written) return;
      const transform = eyeTransform(shape, frame, i % 2 === 0 ? 0 : 1);
      const isVisible = transform !== null;

      if (isVisible !== written.visible) {
        eye.setAttribute("visibility", isVisible ? "visible" : "hidden");
        written.visible = isVisible;
      }

      if (transform && transform !== written.transform) {
        eye.setAttribute("transform", transform);
        written.transform = transform;
      }
    });
  };

  const tick = (time: number) => {
    // The continuous working bob reads fine at 30fps. Hover tracking and the spin keep
    // the full display rate.
    if (last !== 0 && working && !hovered && !motion.spinning && time - last < WORKING_FRAME_MS) {
      frameId = visible ? requestAnimationFrame(tick) : null;

      if (frameId === null) last = 0;

      return;
    }

    const dt = last === 0 ? 1 / 60 : (time - last) / 1000;
    last = time;

    const { frame, active } = motion.tick(dt, {
      working,
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

  const onMove = (event: PointerEvent) => {
    const rect = wrapper.getBoundingClientRect();
    const clamp = (value: number) => Math.max(-0.6, Math.min(0.6, value)) / 0.6;
    pointer = {
      x: clamp((event.clientX - (rect.left + rect.width / 2)) / Math.max(rect.width, 1)),
      y: clamp((event.clientY - (rect.top + rect.height / 2)) / Math.max(rect.height, 1)),
    };
  };

  reducedMotion.addEventListener("change", wake);
  hoverTarget.addEventListener("pointerenter", (event) => {
    hovered = true;
    onMove(event);
    wake();
  });
  hoverTarget.addEventListener("pointermove", onMove);
  hoverTarget.addEventListener("pointerleave", () => {
    hovered = false;
    pointer = null;
    wake();
  });

  new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;

    if (visible) wake();
  }).observe(wrapper);

  const beat = (ms = IDLE_BEAT_LENGTH_MS) => {
    motion.beat(ms);
    wake();
  };

  // Resting avatars join the idle beat; working ones already move.
  const syncIdle = () => {
    if (working && unsubscribeIdle) {
      unsubscribeIdle();
      unsubscribeIdle = null;
    } else if (!working && !unsubscribeIdle) {
      unsubscribeIdle = subscribeIdleBeat(wrapper, () => beat());
    }
  };

  const handle: BotAvatarHandle = {
    setWorking(next) {
      if (next === working) return;
      working = next;
      wrapper.dataset.botState = next ? "working" : "idle";
      syncIdle();
      wake();
    },
    beat,
  };

  handles.set(wrapper, handle);
  syncIdle();
  wake();

  return handle;
}

export function mountBotAvatars(root: ParentNode = document) {
  root.querySelectorAll<HTMLElement>(".bot-avatar[data-avatar-shape]").forEach(mountBotAvatar);
}
