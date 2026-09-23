/**
 * Spring-driven avatar motion, tuned to feel like Grok Bot's companions.
 *
 * Every animated value is a damped spring chasing a target. Poses set the
 * targets (a slow sway at rest, a rocking bob while working), and one-off
 * events kick them: blinks with an overshoot, saccades, a one-eye squint, and
 * a belt spin that wraps the face around the body. The engine only ticks while
 * something asks for motion and stops itself once every spring has settled,
 * so a resting roster costs nothing per frame.
 *
 * Units are the avatar's 100×100 viewBox. Body offsets are applied as percent
 * of the element, which is the same thing.
 */

interface Spring {
  x: number;
  v: number;
  t: number;
}

const spring = (value: number): Spring => ({ x: value, v: 0, t: value });

function step(s: Spring, freq: number, damping: number, dt: number) {
  s.v += (-2 * damping * freq * s.v - freq * freq * (s.x - s.t)) * dt;
  s.x += s.v * dt;
}

const settled = (s: Spring, eps = 0.002) => Math.abs(s.x - s.t) < eps && Math.abs(s.v) < eps * 10;

const rand = (min: number, max: number) => min + Math.random() * (max - min);

/** Blink keyframes for eye height, [ms, value]. Squeezes shut, then overshoots open. */
const BLINK: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [60, 0.08],
  [110, 0.08],
  [190, 1.08],
  [320, 1],
];
const DOUBLE_BLINK: ReadonlyArray<readonly [number, number]> = [
  ...BLINK.slice(0, -1),
  [360, 1],
  [420, 0.08],
  [470, 0.08],
  [560, 1.06],
  [680, 1],
];

function sampleKeyframes(frames: ReadonlyArray<readonly [number, number]>, ms: number) {
  for (let index = 1; index < frames.length; index++) {
    const [endMs, endValue] = frames[index]!;
    if (ms <= endMs) {
      const [startMs, startValue] = frames[index - 1]!;
      const t = (ms - startMs) / (endMs - startMs);
      const eased = t * t * (3 - 2 * t);
      return startValue + (endValue - startValue) * eased;
    }
  }
  return frames[frames.length - 1]![1];
}

const SQUINT_MS = 320;
const SPIN_EVERY_MS: readonly [number, number] = [6000, 9000];
const WORK_BOB_HZ = 1.6;

export interface MotionFrame {
  /** Body roll in degrees. */
  roll: number;
  /** Body offset in viewBox units. */
  x: number;
  y: number;
  /** Vertical squash of the body. */
  scaleY: number;
  /** Gaze offset of the whole face, in face units. */
  gazeX: number;
  gazeY: number;
  /** Pull of the face toward the body center, 0 to 1. */
  pull: number;
  /** Eye width and height multipliers. */
  eyeWidth: number;
  eyeHeight: [number, number];
  /** Belt spin angle in radians, or 0 at rest. */
  spin: number;
}

export interface MotionInput {
  working: boolean;
  hovered: boolean;
  /** Pointer position relative to the avatar, each clamped to -1..1, or null. */
  pointer: { x: number; y: number } | null;
  reducedMotion: boolean;
}

/**
 * One avatar's motion state. Call `tick` from requestAnimationFrame; it
 * returns false once the avatar is at rest and nothing is pending.
 */
export class BotMotion {
  private readonly roll = spring(0);
  private readonly offsetX = spring(0);
  private readonly offsetY = spring(0);
  private readonly squash = spring(1);
  private readonly lookX = spring(0);
  private readonly lookY = spring(0);
  private readonly pull = spring(0);
  private readonly eyeWidth = spring(1);
  private readonly eyeHeight = spring(1);
  private spin: Spring | null = null;
  private spinDirection = 1;

  private clock = 0;
  private readonly phase: number;
  private saccadeAt = 0;
  private saccade = { x: 0, y: 0 };
  private blinkAt = 0;
  private blink: { start: number; frames: ReadonlyArray<readonly [number, number]> } | null = null;
  private squint: { start: number; eye: 0 | 1 } | null = null;
  private squintAt = 0;
  private spinAt = 0;
  private followX = 0;
  private followY = 0;
  private beatUntil = -1;
  private working = false;

  constructor(seed: number) {
    this.phase = seed * 40;
    this.scheduleIdle();
  }

  /** Plays a short lively moment on a resting avatar. */
  beat(lengthMs: number) {
    this.beatUntil = this.clock + lengthMs / 1000;
    const pick = Math.random();
    if (pick < 0.4) this.startBlink();
    else if (pick < 0.7) this.startSquint();
    else this.saccade = { x: rand(-1, 1) * 5, y: rand(-1, 0.4) * 3 };
    this.saccadeAt = this.clock + rand(0.9, 1.3);
    this.blinkAt = Math.max(this.blinkAt, this.beatUntil + 1);
    this.squintAt = Math.max(this.squintAt, this.beatUntil + 1);
  }

  tick(dtSeconds: number, input: MotionInput): { frame: MotionFrame; active: boolean } {
    if (input.reducedMotion) return { frame: this.rest(), active: false };
    const dt = Math.min(dtSeconds, 1 / 20);
    this.clock += dt;
    const now = this.clock;
    const t = now + this.phase;
    const beating = now < this.beatUntil;
    this.working = input.working;
    const lively = input.working || input.hovered || beating;

    // Pose targets.
    if (lively && input.working) {
      const bob = Math.sin(2 * Math.PI * WORK_BOB_HZ * t);
      this.roll.t = 4 + 2.5 * bob;
      this.offsetX.t = 1.2;
      this.offsetY.t = 0.6 + 1.2 * Math.max(0, bob);
      this.squash.t = 1 - 0.02 * Math.max(0, bob);
    } else if (lively) {
      this.roll.t = 1.5 * Math.sin(0.5 * t) + 0.6 * Math.sin(0.17 * t);
      this.offsetX.t = 0.4 * Math.sin(0.27 * t);
      this.offsetY.t = 0.5 * Math.sin(0.85 * t);
      this.squash.t = 1 + 0.007 * Math.sin(0.85 * t);
    } else {
      this.roll.t = 0;
      this.offsetX.t = 0;
      this.offsetY.t = 0;
      this.squash.t = 1;
    }

    // Gaze: saccades, a slow drift, and the pointer while hovered.
    if (lively && now >= this.saccadeAt) {
      if (input.working) {
        this.saccade = {
          x: (Math.random() < 0.5 ? -1 : 1) * rand(0, 0.4) * 6,
          y: rand(0.4, 1) * 3.6,
        };
        this.saccadeAt = now + rand(1.2, 2.4);
      } else {
        this.saccade = { x: 0, y: 0 };
        this.saccadeAt = now + rand(2.5, 5.5);
      }
    }
    if (!lively) this.saccade = { x: 0, y: 0 };
    const following = lively && input.hovered && input.pointer !== null;
    const followTargetX = following ? input.pointer!.x * 9 : 0;
    const followTargetY = following ? input.pointer!.y * 5.6 : 0;
    this.followX += (followTargetX - this.followX) * 0.16;
    this.followY += (followTargetY - this.followY) * 0.16;
    const saccadeWeight = following ? 0.2 : 1;
    const drift = lively ? 1 : 0;
    this.lookX.t =
      this.saccade.x * saccadeWeight +
      this.followX +
      drift * (0.56 * Math.sin(t * 0.42) + 0.2 * Math.sin(t * 1.0 + 2));
    this.lookY.t =
      this.saccade.y * saccadeWeight + this.followY + drift * 0.36 * Math.sin(t * 0.58);

    // Hover emphasis: bigger eyes, face drawn toward the middle.
    const emphasis = lively && input.hovered && !input.working;
    this.pull.t = emphasis ? 1 : 0;
    this.eyeWidth.t = emphasis ? 1.18 : 1;
    this.eyeHeight.t = emphasis ? 1.1 : 1;

    // Blinks and the one-eye squint.
    if (lively && now >= this.blinkAt && !this.blink) this.startBlink();
    if (lively && !input.working && now >= this.squintAt && !this.squint) this.startSquint();
    let blinkHeight = 1;
    if (this.blink) {
      const ms = (now - this.blink.start) * 1000;
      const frames = this.blink.frames;
      if (ms >= frames[frames.length - 1]![0]) this.blink = null;
      else blinkHeight = sampleKeyframes(frames, ms);
    }
    const eyeHeight: [number, number] = [blinkHeight, blinkHeight];
    if (this.squint) {
      const progress = ((now - this.squint.start) * 1000) / SQUINT_MS;
      if (progress >= 1) this.squint = null;
      else {
        const dip = progress < 0.42 ? progress / 0.42 : 1 - (progress - 0.42) / 0.58;
        eyeHeight[this.squint.eye] *= 1 - 0.55 * dip;
      }
    }

    // The working spin, a full turn of the face around the body.
    if (lively && input.working && !this.spin && now >= this.spinAt) {
      this.spin = spring(0);
      this.spin.t = 2 * Math.PI;
      this.spinDirection = Math.random() < 0.5 ? 1 : -1;
    }

    const substeps = Math.max(1, Math.ceil(dt * 120));
    const h = dt / substeps;
    for (let index = 0; index < substeps; index++) {
      step(this.roll, 5, 0.9, h);
      step(this.offsetX, 3.5, 1, h);
      step(this.offsetY, 4, 1, h);
      step(this.squash, 10, 0.8, h);
      step(this.lookX, 13, 1, h);
      step(this.lookY, 13, 1, h);
      step(this.pull, 9, 1, h);
      step(this.eyeWidth, 9, 0.85, h);
      step(this.eyeHeight, 9, 0.85, h);
      if (this.spin) step(this.spin, 6.2, 1, h);
    }
    let spin = 0;
    if (this.spin) {
      spin = this.spin.x * this.spinDirection;
      if (settled(this.spin, 0.004)) {
        this.spin = null;
        spin = 0;
        this.spinAt = now + rand(...SPIN_EVERY_MS) / 1000;
      }
    }

    const frame: MotionFrame = {
      roll: this.roll.x,
      x: this.offsetX.x,
      y: this.offsetY.x,
      scaleY: this.squash.x,
      gazeX: this.lookX.x,
      gazeY: this.lookY.x,
      pull: this.pull.x,
      eyeWidth: this.eyeWidth.x,
      eyeHeight: [eyeHeight[0] * this.eyeHeight.x, eyeHeight[1] * this.eyeHeight.x],
      spin,
    };

    const resting =
      settled(this.roll) &&
      settled(this.offsetX) &&
      settled(this.offsetY) &&
      settled(this.squash) &&
      settled(this.lookX) &&
      settled(this.lookY) &&
      settled(this.pull) &&
      settled(this.eyeWidth) &&
      settled(this.eyeHeight) &&
      Math.abs(this.followX) < 0.01 &&
      Math.abs(this.followY) < 0.01 &&
      !this.spin &&
      !this.blink &&
      !this.squint;
    if (!lively && resting) this.scheduleIdle();
    return { frame, active: lively || !resting };
  }

  /** Drops every pending motion and snaps to the rest frame. */
  private rest(): MotionFrame {
    for (const s of [this.roll, this.offsetX, this.offsetY, this.lookX, this.lookY, this.pull]) {
      s.x = s.t = s.v = 0;
    }
    for (const s of [this.squash, this.eyeWidth, this.eyeHeight]) {
      s.x = s.t = 1;
      s.v = 0;
    }
    this.followX = this.followY = 0;
    this.saccade = { x: 0, y: 0 };
    this.blink = this.squint = this.spin = null;
    this.beatUntil = -1;
    return REST_FRAME;
  }

  private scheduleIdle() {
    const now = this.clock;
    this.saccadeAt = now + rand(0.6, 1.5);
    this.blinkAt = now + rand(1.2, 3);
    this.squintAt = now + rand(4.5, 10);
    this.spinAt = now + rand(1.5, 3.5);
  }

  private startBlink() {
    this.blink = {
      start: this.clock,
      frames: Math.random() < 0.14 ? DOUBLE_BLINK : BLINK,
    };
    // Working bots blink often; hovered ones now and then.
    this.blinkAt = this.clock + (this.working ? rand(1.8, 3.2) : rand(3, 6));
  }

  private startSquint() {
    this.squint = { start: this.clock, eye: Math.random() < 0.5 ? 0 : 1 };
    this.squintAt = this.clock + rand(4.5, 10);
  }
}

export const REST_FRAME: MotionFrame = {
  roll: 0,
  x: 0,
  y: 0,
  scaleY: 1,
  gazeX: 0,
  gazeY: 0,
  pull: 0,
  eyeWidth: 1,
  eyeHeight: [1, 1],
  spin: 0,
};

/**
 * Wraps a point on the face around the body like a belt turning by `angle`.
 * Returns the new x and how wide the point should draw, or null when it has
 * turned behind the body.
 */
export function wrapOnBelt(x: number, center: number, radius: number, angle: number) {
  const u = Math.max(-0.999, Math.min(0.999, (x - center) / radius));
  const a = Math.asin(u);
  const cos = Math.cos(a + angle);
  if (cos < 0.02) return null;
  return { x: center + radius * Math.sin(a + angle), width: cos / Math.cos(a) };
}
