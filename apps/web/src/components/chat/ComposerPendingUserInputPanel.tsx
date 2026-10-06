import { type ApprovalRequestId, type UserInputQuestion } from "@akeru/contracts";
import { ChevronLeftIcon } from "lucide-react";
import { memo, useEffect, useRef, useState, type RefObject } from "react";
import { useI18n } from "~/i18n";
import {
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  pendingUserInputKeyAction,
  resolvePendingUserInputAnswer,
} from "../../pendingUserInput";
import { type PendingUserInput } from "../../session-logic";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { ChoiceButton, OwnAnswerRow } from "./PendingUserInputChoices";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  /** The question on screen. Typed replies answer this one too. */
  step: number;
  onStepChange: (step: number) => void;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  /** Answers the question on screen with text typed into the card's own-answer row. */
  onAnswerWithText: (text: string) => void;
  onSubmit?: () => void;
  /** `docked` drops the card chrome when a host surface already frames the panel. */
  surface?: "card" | "docked";
}

/**
 * The bot's open question as one card that shows a single question at a time. A single-choice
 * pick moves to the next question and the last one sends; multi-select steps wait for Next.
 * Number keys pick options on the question on screen, other typing goes to the own-answer row,
 * and Enter moves on.
 */
export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  step,
  onStepChange,
  onSelectOption,
  onAnswerWithText,
  onSubmit,
  surface = "card",
}: PendingUserInputPanelProps) {
  const activePrompt = pendingUserInputs[0];

  if (!activePrompt) return null;

  return (
    <PendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      step={step}
      onStepChange={onStepChange}
      onSelectOption={onSelectOption}
      onAnswerWithText={onAnswerWithText}
      surface={surface}
      {...(onSubmit ? { onSubmit } : {})}
    />
  );
});

function isTypingTarget(target: EventTarget | null) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;

  return (
    target instanceof HTMLElement &&
    target.closest('[contenteditable]:not([contenteditable="false"])') !== null
  );
}

/** Enter on a focused link, button, or field belongs to that control, not to the card. */
function isInteractiveTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.closest(
      'a[href], button, input, select, textarea, summary, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"]',
    ) !== null
  );
}

function PendingUserInputCard({
  prompt,
  isResponding,
  answers,
  step: requestedStep,
  onStepChange,
  onSelectOption,
  onAnswerWithText,
  onSubmit,
  surface,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  step: number;
  onStepChange: (step: number) => void;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onAnswerWithText: (text: string) => void;
  onSubmit?: () => void;
  surface: "card" | "docked";
}) {
  const { t } = useI18n();
  const { questions } = prompt;
  const step = Math.min(Math.max(requestedStep, 0), questions.length - 1);
  const question = questions[step];
  const isLastStep = step === questions.length - 1;
  const complete = buildPendingUserInputAnswers(questions, answers) !== null;

  const stepAnswered = question
    ? resolvePendingUserInputAnswer(question, answers[question.id])
    : null;

  const sendsOnClick = questions.length === 1 && question?.multiSelect === false;

  // Back slides the previous question in from the left; every other move comes from the right.
  const [shown, setShown] = useState({ step, direction: "forward" });
  const ownAnswerRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLElement>(null);

  if (shown.step !== step) setShown({ step, direction: step < shown.step ? "back" : "forward" });

  const primary = sendsOnClick
    ? null
    : isLastStep
      ? { label: t("Submit"), enabled: complete && onSubmit !== undefined, run: () => onSubmit?.() }
      : { label: t("Next"), enabled: stepAnswered !== null, run: () => onStepChange(step + 1) };

  useEffect(() => {
    if (!question || isResponding) return;

    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;

      if (event.key === "Enter") {
        if (event.defaultPrevented || isInteractiveTarget(event.target) || !primary?.enabled) {
          return;
        }

        event.preventDefault();
        primary.run();

        return;
      }

      // A key pressed on some other control on the page belongs to that control.
      const target = event.target instanceof Node ? event.target : null;

      if (isInteractiveTarget(event.target) && !cardRef.current?.contains(target)) return;

      const action = pendingUserInputKeyAction(event.key, question.options.length);
      const option = action?.kind === "pick" ? question.options[action.optionIndex] : undefined;

      if (option) {
        event.preventDefault();
        onSelectOption(question.id, option.label);
      } else if (action?.kind === "type") {
        // Focus moves before the character lands, so it starts the typed answer.
        ownAnswerRef.current?.focus();
      }
    };

    document.addEventListener("keydown", handler);

    return () => document.removeEventListener("keydown", handler);
  }, [question, isResponding, onSelectOption, primary]);

  if (!question) return null;

  const body = (
    <div className="flex flex-col gap-3.5 px-4 pt-3.5 pb-3.5">
      {questions.length > 1 ? (
        <div className="flex items-center gap-3">
          <div className="flex flex-1 gap-1" aria-hidden="true">
            {questions.map((entry, index) => (
              <span
                key={entry.id}
                className="gen-step h-1 flex-1 rounded-full"
                data-state={
                  index === step
                    ? "current"
                    : resolvePendingUserInputAnswer(entry, answers[entry.id])
                      ? "done"
                      : "todo"
                }
              />
            ))}
          </div>
          <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
            {t("{step} of {total}", { step: String(step + 1), total: String(questions.length) })}
          </span>
        </div>
      ) : null}
      <div
        key={question.id}
        className={shown.direction === "back" ? "motion-page-back" : "motion-page-forward"}
      >
        <PendingQuestion
          question={question}
          draft={answers[question.id]}
          disabled={isResponding}
          onSelectOption={onSelectOption}
          onAnswerWithText={onAnswerWithText}
          ownAnswerRef={ownAnswerRef}
        />
      </div>
      <div className="flex items-center gap-3">
        {step > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={isResponding}
            onClick={() => onStepChange(step - 1)}
          >
            <ChevronLeftIcon />
            {t("Back")}
          </Button>
        ) : null}
        <span className="flex-1" />
        {primary ? (
          <Button size="sm" disabled={isResponding || !primary.enabled} onClick={primary.run}>
            {primary.label}
          </Button>
        ) : null}
      </div>
    </div>
  );

  return (
    <section
      ref={cardRef}
      aria-label={question.question}
      className="chat-generative w-full max-w-2xl"
      data-generative="question"
      data-testid="pending-user-input-card"
    >
      {surface === "card" ? <Card>{body}</Card> : body}
    </section>
  );
}

function PendingQuestion({
  question,
  draft,
  disabled,
  onSelectOption,
  onAnswerWithText,
  ownAnswerRef,
}: {
  question: UserInputQuestion;
  draft: PendingUserInputDraftAnswer | undefined;
  disabled: boolean;
  onSelectOption: (questionId: string, optionLabel: string) => void;
  onAnswerWithText: (text: string) => void;
  ownAnswerRef: RefObject<HTMLInputElement | null>;
}) {
  const { t } = useI18n();
  const customAnswer = draft?.customAnswer?.trim() ?? "";
  const resolved = resolvePendingUserInputAnswer(question, draft);
  const selectedLabels = customAnswer ? [] : [resolved ?? []].flat();

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-col gap-0.5">
        {question.header && question.header !== question.question ? (
          <span className="text-xs font-medium text-muted-foreground">{question.header}</span>
        ) : null}
        <span className="text-sm font-semibold text-foreground">{question.question}</span>
        {question.multiSelect ? (
          <span className="text-xs text-muted-foreground">{t("Pick any that apply.")}</span>
        ) : null}
      </div>
      <div
        className="gen-choices flex flex-col gap-2"
        data-answered={!question.multiSelect && resolved !== null}
      >
        {question.options.map((option, index) => (
          <ChoiceButton
            key={option.label}
            kind={question.multiSelect ? "checkbox" : "radio"}
            pressed={selectedLabels.includes(option.label)}
            disabled={disabled}
            shortcut={index < 9 ? String(index + 1) : null}
            onClick={() => onSelectOption(question.id, option.label)}
          >
            <span className="text-sm font-medium text-foreground">{option.label}</span>
            {option.description && option.description !== option.label ? (
              <span className="text-xs text-muted-foreground">{option.description}</span>
            ) : null}
          </ChoiceButton>
        ))}
        <OwnAnswerRow
          kind={question.multiSelect ? "checkbox" : "radio"}
          answer={customAnswer}
          disabled={disabled}
          inputRef={ownAnswerRef}
          onAnswer={onAnswerWithText}
        />
      </div>
    </div>
  );
}
