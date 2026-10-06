import {
  DESKTOP_ONBOARDING_STEPS,
  type DesktopOnboardingDraft,
  type DesktopOnboardingStep,
} from "./desktopOnboardingDraft";
import type { OnboardingTranslate } from "./onboardingTranslate";

export { englishOnboardingTranslate, type OnboardingTranslate } from "./onboardingTranslate";

export {
  clearDesktopOnboardingHandoff,
  DEFAULT_DESKTOP_ONBOARDING_DRAFT,
  DESKTOP_ONBOARDING_COMPLETED_STORAGE_KEY,
  DESKTOP_ONBOARDING_HANDOFF_STORAGE_KEY,
  DESKTOP_ONBOARDING_LEGACY_HANDOFF_STORAGE_KEY,
  DESKTOP_ONBOARDING_STEPS,
  DESKTOP_ONBOARDING_STORAGE_KEY,
  type DesktopOnboardingDraft,
  type DesktopOnboardingStep,
  type DesktopOnboardingStepDefinition,
  markDesktopOnboardingCompleted,
  markDesktopOnboardingHandoffStarted,
  parseDesktopOnboardingDraft,
  readDesktopOnboardingDraft,
  readDesktopOnboardingHandoff,
  readDesktopOnboardingHandoffForEnvironment,
  writeDesktopOnboardingDraft,
} from "./desktopOnboardingDraft";

export {
  type DesktopOnboardingCreationReadiness,
  desktopOnboardingModelSelection,
  resolveDesktopOnboardingCreationReadiness,
  resolveDesktopOnboardingEngine,
} from "./desktopOnboardingEngine";

export {
  DESKTOP_ONBOARDING_FIRST_CHAT_STORAGE_KEY,
  DESKTOP_ONBOARDING_PROMPT_CHIPS,
  DESKTOP_ONBOARDING_TEAMMATE_NAMES,
  type DesktopOnboardingPromptChip,
  clearDesktopOnboardingFirstChat,
  desktopOnboardingDefaultProjectCreateInput,
  markDesktopOnboardingFirstChat,
  pickDesktopOnboardingTeammateName,
  readDesktopOnboardingFirstChatBotId,
  shouldShowDesktopOnboardingPromptChips,
  workspaceTitleFromCwd,
} from "./desktopOnboardingTeammate";

export {
  canStartDesktopOnboardingReveal,
  DESKTOP_ONBOARDING_CELEBRATION_PIECES,
  DESKTOP_ONBOARDING_DESTINATION_TIMEOUT_MS,
  DESKTOP_ONBOARDING_HANDOFF_PHASES,
  DESKTOP_ONBOARDING_HANDOFF_STAGES,
  DESKTOP_ONBOARDING_REVEAL_DURATION_MS,
  type DesktopOnboardingCelebrationPiece,
  desktopOnboardingCelebrationPieces,
  desktopOnboardingDestinationReady,
  desktopOnboardingHandoffAvatarState,
  desktopOnboardingHandoffDurationMs,
  type DesktopOnboardingHandoffPhase,
  type DesktopOnboardingHandoffStage,
  desktopOnboardingHandoffStages,
  desktopOnboardingHandoffStatus,
  desktopOnboardingHandoffStatuses,
} from "./desktopOnboardingHandoff";

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
  if (draft.botId === null || serverBotIds.includes(draft.botId)) return draft;

  return { ...draft, botId: null };
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

export function desktopOnboardingPromptChipItems(t: OnboardingTranslate): ReadonlyArray<{
  readonly id: "code" | "research" | "admin" | "planning";
  readonly label: string;
  readonly prompt: string;
}> {
  return [
    {
      id: "code",
      label: t("Ship a feature"),
      prompt: t("Walk this codebase and ship a small, complete improvement."),
    },
    {
      id: "research",
      label: t("Research"),
      prompt: t("Research a topic for me and keep one page of findings current"),
    },
    {
      id: "admin",
      label: t("Admin"),
      prompt: t("Take the admin off my desk: inbox, invoices, and filing"),
    },
    {
      id: "planning",
      label: t("Plan my week"),
      prompt: t("Plan my week and keep me on top of what I said I would do"),
    },
  ];
}
