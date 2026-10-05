import * as Predicate from "effect/Predicate";
import type { UserInputQuestion } from "@akeru/contracts";

export interface PendingUserInputDraftAnswer {
  selectedOptionLabels?: string[];
  customAnswer?: string;
}

function normalizeDraftAnswer(value: string | undefined): string | null {
  if (!Predicate.isString(value)) {
    return null;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : null;
}

function normalizeSelectedOptionLabels(value: string[] | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const normalized: string[] = [];

  for (const entry of value) {
    if (!Predicate.isString(entry)) continue;
    const trimmed = entry.trim();

    if (trimmed.length > 0) {
      normalized.push(trimmed);
    }
  }

  return Array.from(new Set(normalized));
}

export function resolvePendingUserInputAnswer(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
): string | string[] | null {
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

export function togglePendingUserInputOptionSelection(
  question: UserInputQuestion,
  draft: PendingUserInputDraftAnswer | undefined,
  optionLabel: string,
): PendingUserInputDraftAnswer {
  if (question.multiSelect) {
    const selectedOptionLabels = normalizeSelectedOptionLabels(draft?.selectedOptionLabels);

    const nextSelectedOptionLabels = selectedOptionLabels.includes(optionLabel)
      ? selectedOptionLabels.filter((label) => label !== optionLabel)
      : [...selectedOptionLabels, optionLabel];

    return {
      customAnswer: "",
      ...(nextSelectedOptionLabels.length > 0
        ? { selectedOptionLabels: nextSelectedOptionLabels }
        : {}),
    };
  }

  return {
    customAnswer: "",
    selectedOptionLabels: [optionLabel],
  };
}

export interface PendingUserInputSelectionResult {
  draftAnswers: Record<string, PendingUserInputDraftAnswer>;
  /** Set when the click settles the last step, so the prompt can be sent right away. */
  answers: Record<string, string | string[]> | null;
  /** The step to show after this click. */
  nextStep: number;
}

/**
 * Where the card goes once a step is answered: the next step, or from the last step back to
 * the first one still open. Returns null when every question is answered on the last step.
 */
export function pendingUserInputStepAfterAnswer(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  step: number,
): number | null {
  if (step < questions.length - 1) return step + 1;

  if (buildPendingUserInputAnswers(questions, draftAnswers)) return null;

  return findFirstUnansweredPendingUserInputQuestionIndex(questions, draftAnswers);
}

/**
 * Applies an option click on the current step. A single-choice pick moves to the next step,
 * and on the last step sends once every question has an answer. Multi-select picks toggle and
 * wait for Next.
 */
export function applyPendingUserInputOptionSelection(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
  questionId: string,
  optionLabel: string,
): PendingUserInputSelectionResult | null {
  const step = questions.findIndex((entry) => entry.id === questionId);
  const question = questions[step];

  if (!question || !question.options.some((option) => option.label === optionLabel)) return null;

  const nextDraftAnswers = {
    ...draftAnswers,
    [questionId]: togglePendingUserInputOptionSelection(
      question,
      draftAnswers[questionId],
      optionLabel,
    ),
  };

  if (question.multiSelect)
    return { draftAnswers: nextDraftAnswers, answers: null, nextStep: step };

  const nextStep = pendingUserInputStepAfterAnswer(questions, nextDraftAnswers, step);

  return {
    draftAnswers: nextDraftAnswers,
    answers: nextStep === null ? buildPendingUserInputAnswers(questions, nextDraftAnswers) : null,
    nextStep: nextStep ?? step,
  };
}

export function buildPendingUserInputAnswers(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): Record<string, string | string[]> | null {
  const answers: Record<string, string | string[]> = {};

  for (const question of questions) {
    const answer = resolvePendingUserInputAnswer(question, draftAnswers[question.id]);

    if (!answer) {
      return null;
    }

    answers[question.id] = answer;
  }

  return answers;
}

export function countAnsweredPendingUserInputQuestions(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  return questions.reduce((count, question) => {
    return resolvePendingUserInputAnswer(question, draftAnswers[question.id]) ? count + 1 : count;
  }, 0);
}

export function findFirstUnansweredPendingUserInputQuestionIndex(
  questions: ReadonlyArray<UserInputQuestion>,
  draftAnswers: Record<string, PendingUserInputDraftAnswer>,
): number {
  const unansweredIndex = questions.findIndex(
    (question) => !resolvePendingUserInputAnswer(question, draftAnswers[question.id]),
  );

  return unansweredIndex === -1 ? Math.max(questions.length - 1, 0) : unansweredIndex;
}

export type PendingUserInputKeyAction =
  | { readonly kind: "pick"; readonly optionIndex: number }
  | { readonly kind: "type" }
  | null;

/**
 * What a plain key press does while a question is on screen. A number picks that option; any
 * other printable character starts a typed answer, so a sentence typed outside a field never
 * turns into picks. Whitespace and named keys do nothing here.
 */
export function pendingUserInputKeyAction(
  key: string,
  optionCount: number,
): PendingUserInputKeyAction {
  if (/^[1-9]$/.test(key)) {
    const optionIndex = Number.parseInt(key, 10) - 1;

    return optionIndex < optionCount ? { kind: "pick", optionIndex } : { kind: "type" };
  }

  return key.length === 1 && key.trim() ? { kind: "type" } : null;
}
