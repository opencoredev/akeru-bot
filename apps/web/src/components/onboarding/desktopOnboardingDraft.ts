import { Predicate } from "effect";
import type { SubscriptionProviderId } from "@akeru/contracts";

import type { BotAvatar, BotBlobShape } from "../roster/types";
import { BLOB_SHAPES, isBotAvatarColor } from "../roster/roster.logic";
import { normalizeDesktopOnboardingGoal } from "./goalPlan.logic";

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
export const DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY = "akeru:desktop-onboarding-handoff:v2";

export const DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY = "akeru:desktop-onboarding-handoff:v1";

export function markDesktopOnboardingHandoffStarted(
  storage: Pick<Storage, "removeItem" | "setItem">,
  environmentId: string,
  botId: string,
): void {
  markDesktopOnboardingCompleted(storage);
  storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);
  storage.setItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, JSON.stringify({ environmentId, botId }));
}

/** Clears the pending handoff once its chat route has opened. */
export function clearDesktopOnboardingHandoff(storage: Pick<Storage, "removeItem">): void {
  storage.removeItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY);
  storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);
}

/** Reads a pending handoff; the caller clears it after the chat opens. */
export function readDesktopOnboardingHandoff(
  storage: Pick<Storage, "getItem">,
): { readonly environmentId: string; readonly botId: string } | null {
  const value = storage.getItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY);

  if (!value) return null;

  try {
    const handoff: unknown = JSON.parse(value);

    if (
      Predicate.isObjectOrArray(handoff) &&
      handoff !== null &&
      "environmentId" in handoff &&
      Predicate.isString(handoff.environmentId) &&
      handoff.environmentId.trim() &&
      "botId" in handoff &&
      Predicate.isString(handoff.botId) &&
      handoff.botId.trim()
    ) {
      return { environmentId: handoff.environmentId, botId: handoff.botId };
    }
  } catch {
    return null;
  }

  return null;
}

/** Migrates a v1 bot ID only after this environment's loaded roster confirms ownership. */
export function readDesktopOnboardingHandoffForEnvironment(
  storage: Pick<Storage, "getItem" | "removeItem" | "setItem">,
  environmentId: string,
  botIds: ReadonlyArray<string>,
): { readonly environmentId: string; readonly botId: string } | null {
  const current = readDesktopOnboardingHandoff(storage);

  if (current) return current;
  const legacyBotId = storage.getItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY)?.trim();

  if (!legacyBotId) {
    storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);

    return null;
  }

  if (!botIds.includes(legacyBotId)) return null;
  const handoff = { environmentId, botId: legacyBotId };
  storage.setItem(DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY, JSON.stringify(handoff));
  storage.removeItem(DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY);

  return handoff;
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
  readonly goalPhase: "ask" | "plan";
  readonly name: string;
  readonly avatar: Extract<BotAvatar, { kind: "blob" }>;
  readonly botId: string | null;
}

export const DEFAULT_DESKTOP_ONBOARDING_DRAFT: DesktopOnboardingDraft = {
  step: "subscription",
  providerId: "openai-codex",
  goal: "",
  goalPhase: "ask",
  name: "",
  avatar: { kind: "blob", shape: "squircle", color: "#8B6FC9" },
  botId: null,
};

function isBlobShape(value: unknown): value is BotBlobShape {
  return Predicate.isString(value) && (BLOB_SHAPES as readonly string[]).includes(value);
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

function isProviderId(value: unknown): value is SubscriptionProviderId {
  return Predicate.isString(value) && (providerIds as readonly string[]).includes(value);
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
  if (Predicate.isString(parsed.goal) && parsed.goal.trim().length > 0) return parsed.goal;
  const custom = Predicate.isString(parsed.customUseCase) ? parsed.customUseCase : "";
  const useCaseId = Predicate.isString(parsed.useCaseId) ? parsed.useCaseId : null;

  if (useCaseId !== null && useCaseId !== "custom") return legacyUseCaseGoals[useCaseId] ?? custom;

  return custom;
}

export function parseDesktopOnboardingDraft(value: string | null): DesktopOnboardingDraft | null {
  if (value === null) return null;

  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const avatar = parsed.avatar as Record<string, unknown> | undefined;
    const step = parsed.step === "use-case" ? "goal" : parsed.step;
    const legacy = parsed.step === "use-case" || "useCaseId" in parsed || "customUseCase" in parsed;
    const goal = legacy ? normalizeDesktopOnboardingGoal(storedGoal(parsed)) : storedGoal(parsed);

    if (
      !isStep(step) ||
      !isProviderId(parsed.providerId) ||
      goal.length > DESKTOP_ONBOARDING_GOAL_MAX_LENGTH ||
      !Predicate.isString(parsed.name) ||
      parsed.name.length > 80 ||
      !avatar ||
      avatar.kind !== "blob" ||
      !isBlobShape(avatar.shape) ||
      !isBlobColor(avatar.color) ||
      !(parsed.botId === null || Predicate.isString(parsed.botId))
    ) {
      return null;
    }

    return {
      step,
      providerId: parsed.providerId,
      goal,
      goalPhase:
        parsed.goalPhase === "ask" || parsed.goalPhase === "plan"
          ? parsed.goalPhase
          : step === "goal"
            ? "ask"
            : "plan",
      name: parsed.name,
      avatar: { kind: "blob", shape: avatar.shape, color: avatar.color },
      botId: parsed.botId,
    };
  } catch {
    return null;
  }
}

/** Reads the in-progress setup draft, or null when none is saved or it no longer parses. */
export function readDesktopOnboardingDraft(
  storage: Pick<Storage, "getItem">,
): DesktopOnboardingDraft | null {
  return parseDesktopOnboardingDraft(storage.getItem(DESKTOP_ONBOARDING_STORAGE_KEY));
}

export function writeDesktopOnboardingDraft(
  storage: Pick<Storage, "setItem">,
  draft: DesktopOnboardingDraft,
): void {
  storage.setItem(DESKTOP_ONBOARDING_STORAGE_KEY, JSON.stringify(draft));
}
