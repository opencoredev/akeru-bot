import type { UserInputQuestion } from "@akeru/contracts";

export interface PendingUserInputDraftAnswer {
  readonly selectedOptionLabels?: ReadonlyArray<string>;
  readonly customAnswer?: string;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(
  value: ReadonlyArray<string> | undefined,
): ReadonlyArray<string> {
  if (!Array.isArray(value)) {
    return [];
  }

  return Array.from(
    new Set(value.map((entry) => entry.trim()).filter((entry) => entry.length > 0)),
  );
}

function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | ReadonlyArray<string> | null {
  const customAnswer = normalizeDraftAnswer(draft?.customAnswer);

  if (customAnswer) {
    return customAnswer;
  }

  const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  if (question.multiSelect) {
    return selectedOptionLabels.length > 0 ? selectedOptionLabels : null;
  }

  return selectedOptionLabels[0] ?? null;
}

export function setPendingUserInputCustomAnswer(
  draft: PendingUserInputDraftAnswer | undefined,
  customAnswer: string,
): PendingUserInputDraftAnswer {
  const selectedOptionLabels =
    customAnswer.trim().length > 0
      ? undefined
      : normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

  return {
    customAnswer,
    ...(selectedOptionLabels && selectedOptionLabels.length > 0 ? { selectedOptionLabels } : {}),
  };
}

export function isPendingUserInputOptionSelected(
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): boolean {
  if (normalizeDraftAnswer(draft?.customAnswer)) {
    return false;
  }

  return normalizeSelectedOptionLabels(draft?.selectedOptionLabels).includes(optionLabel.trim());
}

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  const normalizedOptionLabel = optionLabel.trim();

  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

    const nextSelectedOptionLabels = selectedOptionLabels.includes(normalizedOptionLabel)
      ? selectedOptionLabels.filter((label) => label !== normalizedOptionLabel)
      : [...selectedOptionLabels, normalizedOptionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [normalizedOptionLabel],
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | ReadonlyArray<string>> | null {
  const answers: Record<string, string | ReadonlyArray<string>> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);

    if (!answer) {
      return null;
    }

    answers[question.id] = answer;
  }

  return answers;
}
