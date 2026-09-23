import {
  ProviderInstanceId,
  type BotEngine,
  type ModelSelection,
  type SubscriptionProviderId,
} from "@t3tools/contracts";

import type { BotAnimationState } from "../roster/BotAvatarView";
import type { BotAvatar, BotBlobShape } from "../roster/types";
import { BLOB_COLORS, BLOB_SHAPES, isBotAvatarColor } from "../roster/roster.logic";

export const DESKTOP_ONBOARDING_STORAGE_KEY = "akeru:desktop-onboarding:v1";
export const DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY = "akeru:desktop-onboarding-completed:v1";
export function markDesktopOnboardingCompleted(
  storage: Pick<Storage, "removeItem" | "setItem">,
): void {
  storage.removeItem(DESKTOP_ONBOARDING_STORAGE_KEY);
  storage.setItem(DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY, "1");
}

/**
 * The bot whose chat setup is handing off to. It is written with completion,
 * the moment the first message goes out, so a reload mid-handoff neither
 * reopens setup (and resends) nor loses the chat the user was being taken to.
 */
export const DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY = "akeru:desktop-onboarding-handoff:v1";
export function markDesktopOnboardingHandoffStarted(
  storage: Pick<Storage, "removeItem" | "setItem">,
  botId: string,
): void {
  markDesktopOnboardingCompleted(storage);
  storage.setItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, botId);
}

/** Clears the pending handoff once its chat route has opened. */
export function clearDesktopOnboardingHandoff(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY);
}

/**
 * Reads and clears a handoff a reload interrupted, so the app routes to its
 * chat exactly once.
 */
export function takeDesktopOnboardingHandoff(
  storage: Pick<Storage, "getItem" | "removeItem">,
): string | null {
  const botId = storage.getItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY);
  if (botId === null) return null;
  clearDesktopOnboardingHandoff(storage);
  return botId.trim().length > 0 ? botId : null;
}

export type DesktopOnboardingStep = "subscription" | "goal" | "identity" | "message";

export interface DesktopOnboardingStepDefinition {
  readonly id: DesktopOnboardingStep;
  /** Rail label. Short enough to sit in a four-up stepper. */
  readonly label: string;
}

/** Source of truth for step order: drives the rail, the counter, and stepNumber. */
export const DESKTOP_ONBOARDING_STEPS: readonly DesktopOnboardingStepDefinition[] = [
  { id: "subscription", label: "Connect" },
  { id: "goal", label: "Goal" },
  { id: "identity", label: "Identity" },
  { id: "message", label: "First message" },
];

/**
 * Generous enough for a few sentences about work we cannot anticipate, short
 * enough that the answer still reads as a goal rather than a brief.
 */
export const DESKTOP_ONBOARDING_GOAL_MAX_LENGTH = 600;

export interface DesktopOnboardingDraft {
  readonly step: DesktopOnboardingStep;
  readonly providerId: SubscriptionProviderId;
  /** What the user wants done, in their words. Empty until they answer. */
  readonly goal: string;
  readonly name: string;
  readonly avatar: Extract<BotAvatar, { kind: "blob" }>;
  readonly botId: string | null;
}

export const DEFAULT_DESKTOP_ONBOARDING_DRAFT: DesktopOnboardingDraft = {
  step: "subscription",
  providerId: "openai-codex",
  goal: "",
  name: "",
  avatar: { kind: "blob", shape: "squircle", color: "#8B6FC9" },
  botId: null,
};

function isBlobShape(value: unknown): value is BotBlobShape {
  return typeof value === "string" && (BLOB_SHAPES as readonly string[]).includes(value);
}

function isBlobColor(value: unknown): value is string {
  return isBotAvatarColor(value);
}

const providerIds: readonly SubscriptionProviderId[] = [
  "openai-codex",
  "anthropic",
  "xai",
  "kimi-for-coding",
  "opencode-go",
];

/**
 * Goals recovered from drafts saved while setup asked the user to pick a
 * category. Phrased the way someone would answer the question that replaced
 * the picker, because the answer is shown back to them and drafts their first
 * message. Ids are historical: never reuse one for different work.
 */
const legacyUseCaseGoals: Readonly<Record<string, string>> = {
  build: "Building a software feature",
  fix: "Fixing a software bug",
  understand: "Understanding a codebase",
  automate: "Automating a task I repeat",
  inbox: "Triaging my inbox and drafting replies I approve",
  documents: "Processing incoming documents and filing them where they belong",
  monitoring: "Watching a system and telling me when something changes",
  research: "Looking up the same facts and keeping one list current",
  routine: "Taking over a routine that eats my week",
};

/**
 * Short label for the goal, shown live in the preview while the user is still
 * typing. Collapses newlines so a multi-line answer still reads on one line.
 */
export function resolveDesktopOnboardingFocusLabel(goal: string): string | null {
  const summary = goal.trim().replace(/\s+/g, " ");
  if (summary.length === 0) return null;
  return summary.length > 48 ? `${summary.slice(0, 47).trimEnd()}…` : summary;
}

interface DesktopOnboardingProvider {
  readonly instanceId: string;
  readonly driver: string;
  readonly enabled: boolean;
  readonly installed: boolean;
  readonly availability?: "available" | "unavailable" | undefined;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

export type DesktopOnboardingCreationReadiness =
  | { readonly status: "loading" }
  | { readonly status: "unavailable" }
  | { readonly status: "ready"; readonly engine: BotEngine };

const subscriptionDriver: Readonly<Partial<Record<SubscriptionProviderId, string>>> = {
  "openai-codex": "codex",
  anthropic: "claudeAgent",
  xai: "grok",
  "kimi-for-coding": "kimi",
  "opencode-go": "opencodeGo",
};

export function resolveDesktopOnboardingEngine(
  providerId: SubscriptionProviderId,
  providers: ReadonlyArray<DesktopOnboardingProvider>,
): BotEngine | null {
  const provider = providers.find(
    (candidate) =>
      candidate.driver === subscriptionDriver[providerId] &&
      candidate.enabled &&
      candidate.installed &&
      candidate.availability !== "unavailable",
  );
  const model = provider?.models.find((candidate) => candidate.isDefault) ?? provider?.models[0];
  return provider && model ? { provider: provider.instanceId, model: model.slug } : null;
}

export function resolveDesktopOnboardingCreationReadiness(
  providerId: SubscriptionProviderId,
  providers: ReadonlyArray<DesktopOnboardingProvider> | null,
): DesktopOnboardingCreationReadiness {
  if (providers === null) return { status: "loading" };
  const engine = resolveDesktopOnboardingEngine(providerId, providers);
  return engine ? { status: "ready", engine } : { status: "unavailable" };
}

export function desktopOnboardingModelSelection(engine: BotEngine | null): ModelSelection | null {
  return engine
    ? { instanceId: ProviderInstanceId.make(engine.provider), model: engine.model }
    : null;
}

function isProviderId(value: unknown): value is SubscriptionProviderId {
  return typeof value === "string" && (providerIds as readonly string[]).includes(value);
}

function isStep(value: unknown): value is DesktopOnboardingStep {
  return DESKTOP_ONBOARDING_STEPS.some((step) => step.id === value);
}

/**
 * Goal of a saved draft, whichever generation of setup wrote it. A stored
 * category still names work the user chose, so it outranks any custom text
 * left behind by a choice they moved away from.
 */
function storedGoal(parsed: Record<string, unknown>): string {
  if (typeof parsed.goal === "string" && parsed.goal.trim().length > 0) return parsed.goal;
  const custom = typeof parsed.customUseCase === "string" ? parsed.customUseCase : "";
  const useCaseId = typeof parsed.useCaseId === "string" ? parsed.useCaseId : null;
  if (useCaseId !== null && useCaseId !== "custom") return legacyUseCaseGoals[useCaseId] ?? custom;
  return custom;
}

export function parseDesktopOnboardingDraft(value: string | null): DesktopOnboardingDraft | null {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const avatar = parsed.avatar as Record<string, unknown> | undefined;
    const step = parsed.step === "use-case" ? "goal" : parsed.step;
    const goal = storedGoal(parsed);
    if (
      !isStep(step) ||
      !isProviderId(parsed.providerId) ||
      goal.length > DESKTOP_ONBOARDING_GOAL_MAX_LENGTH ||
      typeof parsed.name !== "string" ||
      parsed.name.length > 80 ||
      !avatar ||
      avatar.kind !== "blob" ||
      !isBlobShape(avatar.shape) ||
      !isBlobColor(avatar.color) ||
      !(parsed.botId === null || typeof parsed.botId === "string")
    ) {
      return null;
    }
    return {
      step,
      providerId: parsed.providerId,
      goal,
      name: parsed.name,
      avatar: { kind: "blob", shape: avatar.shape, color: avatar.color },
      botId: parsed.botId,
    };
  } catch {
    return null;
  }
}

export function shouldShowDesktopOnboarding(input: {
  readonly desktop: boolean;
  readonly rosterLoaded: boolean;
  readonly serverBotCount: number;
  readonly draft: DesktopOnboardingDraft | null;
  readonly completed: boolean;
  readonly started: boolean;
}): boolean {
  if (!input.desktop || !input.rosterLoaded) return false;
  return input.started || input.draft !== null || (!input.completed && input.serverBotCount === 0);
}

export function recoverMissingDesktopOnboardingBot(
  draft: DesktopOnboardingDraft,
  serverBotIds: readonly string[],
): DesktopOnboardingDraft {
  if (draft.step !== "message" || draft.botId === null || serverBotIds.includes(draft.botId)) {
    return draft;
  }
  return { ...draft, step: "identity", botId: null };
}

export function recoverDisappearedDesktopOnboardingBot(
  draft: DesktopOnboardingDraft,
  readyBotId: string | null,
): DesktopOnboardingDraft {
  if (draft.step !== "message" || draft.botId === null || draft.botId !== readyBotId) return draft;
  return { ...draft, step: "identity", botId: null };
}

export function stepNumber(step: DesktopOnboardingStep): number {
  const index = DESKTOP_ONBOARDING_STEPS.findIndex((candidate) => candidate.id === step);
  return index === -1 ? DESKTOP_ONBOARDING_STEPS.length : index + 1;
}

export interface DesktopOnboardingProgress {
  readonly number: number;
  readonly total: number;
  /** 0 on the first step, 1 once the last one is reached. */
  readonly fraction: number;
  readonly label: string;
}

export function desktopOnboardingProgress(step: DesktopOnboardingStep): DesktopOnboardingProgress {
  const total = DESKTOP_ONBOARDING_STEPS.length;
  const number = stepNumber(step);
  return {
    number,
    total,
    fraction: total <= 1 ? 1 : (number - 1) / (total - 1),
    label: `Step ${number} of ${total}`,
  };
}

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
): string {
  const name = botName.trim() || "your bot";
  if (phase === "sending") return "Message sent";
  if (phase === "waking") return `Waking ${name} up`;
  return "Opening your workspace";
}

/**
 * Every distinct status in order. The widest one sizes the status box so a
 * swap never resizes the row underneath the avatar.
 */
export function desktopOnboardingHandoffStatuses(botName: string): readonly string[] {
  const statuses = DESKTOP_ONBOARDING_HANDOFF_PHASES.map((phase) =>
    desktopOnboardingHandoffStatus(phase, botName),
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
