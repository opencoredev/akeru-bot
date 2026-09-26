import { describe, expect, it } from "vite-plus/test";

import { BotMotion, wrapOnBelt, type MotionInput } from "./botAvatarMotion";

const rest: MotionInput = { working: false, hovered: false, pointer: null, reducedMotion: false };

function run(motion: BotMotion, input: MotionInput, seconds: number) {
  let result = motion.tick(1 / 60, input);
  for (let elapsed = 1 / 60; elapsed < seconds; elapsed += 1 / 60) {
    result = motion.tick(1 / 60, input);
  }
  return result;
}

describe("BotMotion", () => {
  it("stops asking for frames when nothing wants motion", () => {
    const motion = new BotMotion(0.3);
    expect(motion.tick(1 / 60, rest).active).toBe(false);
  });

  it("keeps a working bot moving, then settles it once the turn ends", () => {
    const motion = new BotMotion(0.3);
    const working = run(motion, { ...rest, working: true }, 2);
    expect(working.active).toBe(true);
    expect(working.frame.roll).not.toBe(0);

    const after = run(motion, rest, 6);
    expect(after.active).toBe(false);
    expect(after.frame.roll).toBeCloseTo(0, 1);
    expect(after.frame.spin).toBe(0);
  });

  it("reports the working spin while it plays so the view can render it at full rate", () => {
    const motion = new BotMotion(0.3);
    const working = { ...rest, working: true };
    let sawSpin = false;
    for (let frame = 0; frame < 60 * 8 && !sawSpin; frame++) {
      const { frame: pose } = motion.tick(1 / 60, working);
      if (pose.spin !== 0) {
        sawSpin = true;
        expect(motion.spinning).toBe(true);
      }
    }
    expect(sawSpin).toBe(true);
    run(motion, rest, 6);
    expect(motion.spinning).toBe(false);
  });

  it("turns the eyes toward the pointer and enlarges them on hover", () => {
    const motion = new BotMotion(0.3);
    const { frame } = run(motion, { ...rest, hovered: true, pointer: { x: 1, y: 0 } }, 1.5);
    expect(frame.gazeX).toBeGreaterThan(5);
    expect(frame.eyeWidth).toBeGreaterThan(1.1);
  });

  it("plays an idle beat and then rests again", () => {
    const motion = new BotMotion(0.3);
    motion.beat(1600);
    expect(motion.tick(1 / 60, rest).active).toBe(true);
    expect(run(motion, rest, 5).active).toBe(false);
  });

  it("holds still under reduced motion", () => {
    const motion = new BotMotion(0.3);
    const { frame, active } = motion.tick(1 / 60, {
      ...rest,
      working: true,
      reducedMotion: true,
    });
    expect(active).toBe(false);
    expect(frame.roll).toBe(0);
  });

  it("drops a pending idle beat when reduced motion is on", () => {
    const motion = new BotMotion(0.3);
    motion.beat(1600);
    const { frame, active } = motion.tick(1 / 60, { ...rest, reducedMotion: true });
    expect(active).toBe(false);
    expect(frame.eyeHeight).toEqual([1, 1]);
    expect(motion.tick(1 / 60, rest).active).toBe(false);
  });
});

describe("wrapOnBelt", () => {
  it("leaves a point in place at rest and hides it behind the body", () => {
    expect(wrapOnBelt(60, 50, 44, 0)).toEqual({ x: 60, width: 1 });
    expect(wrapOnBelt(60, 50, 44, Math.PI)).toBeNull();
  });
});
