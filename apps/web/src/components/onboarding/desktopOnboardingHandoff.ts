import type { BotAnimationState } from "../roster/BotAvatarView";
import { BLOB_COLORS, isBotAvatarColor } from "../roster/roster.logic";
import { englishOnboardingTranslate, type OnboardingTranslate } from "./onboardingTranslate";

export interface DesktopOnboardingCelebrationPiece {
  readonly id: number;
  readonly color: string;
  /** Horizontal drift in px, signed. */
  readonly x: number;
  /** Vertical travel in px. Negative rises. */
  readonly y: number;
  readonly rotate: number;
  readonly scale: number;
  /** Seconds. Staggers the burst so it reads as a scatter, not a ring. */
  readonly delay: number;
  readonly square: boolean;
}

export const DESKTOP_ONBOARDING_CELEBRATION_PIECES = 16;

function hashSeed(seed: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, deterministic, and good enough to scatter confetti. */
function seededRandom(state: number): () => number {
  let value = state;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let next = Math.imul(value ^ (value >>> 15), 1 | value);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Fixed layout for the completion burst. Deterministic on purpose: a re-render
 * mid-flight must not re-roll the particles and restart the animation. The
 * accent leads the palette so the burst reads as the user's own bot color.
 */
export function desktopOnboardingCelebrationPieces(
  seed: string,
  accent: string,
  count: number = DESKTOP_ONBOARDING_CELEBRATION_PIECES,
): readonly DesktopOnboardingCelebrationPiece[] {
  const tint = isBotAvatarColor(accent) ? accent.toUpperCase() : null;
  const others = BLOB_COLORS.filter((color) => color !== "#FFFFFF" && color !== tint);
  const palette = tint ? [tint, tint, ...others.slice(0, 3)] : others.slice(0, 4);
  const random = seededRandom(hashSeed(seed));
  return Array.from({ length: Math.max(0, count) }, (_, id) => {
    const spread = (random() - 0.5) * 2;
    return {
      id,
      color: palette[Math.floor(random() * palette.length)] ?? palette[0] ?? "#7A8699",
      x: Math.round(spread * 132),
      y: Math.round(-46 - random() * 104),
      rotate: Math.round((random() - 0.5) * 220),
      scale: Number((0.65 + random() * 0.5).toFixed(2)),
      delay: Number((random() * 0.12).toFixed(3)),
      square: random() > 0.45,
    };
  });
}

/**
 * Beats of the handoff that runs after the first message is sent. Each one is
 * a real moment: the send resolved, the bot is starting its first turn, the
 * workspace behind setup is being opened, and setup is fading off it once that
 * workspace is genuinely showing the conversation. Nothing here narrates work
 * the app is not doing.
 */
export type DesktopOnboardingHandoffPhase = "sending" | "waking" | "opening" | "revealing" | "done";

/** Every beat in order. Sizes the status box and drives phase-wide tests. */
export const DESKTOP_ONBOARDING_HANDOFF_PHASES: readonly DesktopOnboardingHandoffPhase[] = [
  "sending",
  "waking",
  "opening",
  "revealing",
  "done",
];

export interface DesktopOnboardingHandoffStage {
  readonly phase: DesktopOnboardingHandoffPhase;
  /** Milliseconds after the send. */
  readonly atMs: number;
}

/**
 * How long setup takes to fade off the workspace. The whole surface leaves as
 * one layer, so this is also the gap between `revealing` and `done`: unmount
 * any earlier and the fade is cut off mid-way.
 */
export const DESKTOP_ONBOARDING_REVEAL_DURATION_MS = 400;

/**
 * The timed part of the handoff: the beats that play while setup is still
 * fully opaque. It stops at `opening`, which mounts the workspace behind
 * setup. `revealing` is not on a clock. It waits for that workspace to show
 * the conversation, because a timer cannot know when a projection landed.
 */
export const DESKTOP_ONBOARDING_HANDOFF_STAGES: readonly DesktopOnboardingHandoffStage[] = [
  { phase: "sending", atMs: 0 },
  { phase: "waking", atMs: 520 },
  { phase: "opening", atMs: 1260 },
];

/**
 * Last resort. If the destination never reports itself ready (a stalled
 * projection, a dropped socket), setup still leaves rather than trapping the
 * user behind an overlay. Long enough that a slow-but-working machine reaches
 * readiness first, so the normal flow is never the timeout.
 */
export const DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS = 6_000;

/**
 * Reduced motion keeps every beat but collapses the wait, so the user still
 * reaches the workspace without sitting through motion they asked not to see.
 */
export function desktopOnboardingHandoffStages(
  reducedMotion: boolean,
): readonly DesktopOnboardingHandoffStage[] {
  if (!reducedMotion) return DESKTOP_ONBOARDING_HANDOFF_STAGES;
  return DESKTOP_ONBOARDING_HANDOFF_STAGES.map((stage) => ({ ...stage, atMs: 0 }));
}

/** How long the opaque part of the handoff takes, before readiness is waited on. */
export function desktopOnboardingHandoffDurationMs(reducedMotion: boolean): number {
  const stages = desktopOnboardingHandoffStages(reducedMotion);
  return stages.at(-1)?.atMs ?? 0;
}

/**
 * What the destination has to be showing before setup may fade off it. The
 * thread the message landed in has to exist, the message itself has to be in
 * the messages the chat renders, and the turn it started has to be on the
 * thread. That trio is exactly what the user sees behind the fade, so
 * anything less can reveal an empty chat.
 */
export function desktopOnboardingDestinationReady(input: {
  readonly threadLinked: boolean;
  readonly submittedMessage: string;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
  /** Whether the thread carries the turn the message started, in any state. */
  readonly turnStarted: boolean;
}): boolean {
  if (!input.threadLinked || !input.turnStarted) return false;
  const submitted = input.submittedMessage.trim();
  const userMessages = input.messages.filter((message) => message.role === "user");
  if (userMessages.length === 0) return false;
  // An attachment-only first message has no text to match, so the presence of
  // the user turn is all there is to wait for.
  if (submitted.length === 0) return true;
  return userMessages.some((message) => message.text.trim() === submitted);
}

/**
 * Whether setup may start fading. The reveal is gated twice: the workspace has
 * to be mounted behind setup (`opening`), and it has to be showing the
 * conversation. The timeout is failure safety, not the normal path.
 */
export function canStartDesktopOnboardingReveal(input: {
  readonly phase: DesktopOnboardingHandoffPhase | null;
  readonly destinationReady: boolean;
  readonly timedOut: boolean;
}): boolean {
  if (input.phase !== "opening") return false;
  return input.destinationReady || input.timedOut;
}

/**
 * Status line for a beat. Claims only what just happened, so a slow machine
 * reads as honest rather than as a lie about backend work.
 */
export function desktopOnboardingHandoffStatus(
  phase: DesktopOnboardingHandoffPhase,
  botName: string,
  t: OnboardingTranslate = englishOnboardingTranslate,
): string {
  const name = botName.trim() || t("your bot");
  if (phase === "sending") return t("Message sent");
  if (phase === "waking") return t("Waking {name} up", { name });
  return t("Opening your workspace");
}

/**
 * Every distinct status in order. The widest one sizes the status box so a
 * swap never resizes the row underneath the avatar.
 */
export function desktopOnboardingHandoffStatuses(
  botName: string,
  t: OnboardingTranslate = englishOnboardingTranslate,
): readonly string[] {
  const statuses = DESKTOP_ONBOARDING_HANDOFF_PHASES.map((phase) =>
    desktopOnboardingHandoffStatus(phase, botName, t),
  );
  return [...new Set(statuses)];
}

/**
 * How the avatar plays the handoff: at rest while the message goes out, then
 * working from the moment the bot wakes to pick it up.
 */
export function desktopOnboardingHandoffAvatarState(
  phase: DesktopOnboardingHandoffPhase,
): BotAnimationState {
  return phase === "sending" ? "idle" : "working";
}
