import { type ApprovalRequestId } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { type PendingUserInput } from "../../session-logic";
import {
  derivePendingUserInputProgress,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { CheckIcon } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

interface PendingUserInputPanelProps {
  pendingUserInputs: PendingUserInput[];
  respondingRequestIds: ApprovalRequestId[];
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onSelectSingleOption?: (questionId: string, optionLabel: string) => void;
  onAdvance?: () => void;
  className?: string;
}

export const ComposerPendingUserInputPanel = memo(function ComposerPendingUserInputPanel({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onSelectSingleOption,
  onAdvance,
  className,
}: PendingUserInputPanelProps) {
  if (pendingUserInputs.length === 0) return null;
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt) return null;

  return (
    <ComposerPendingUserInputCard
      key={activePrompt.requestId}
      prompt={activePrompt}
      isResponding={respondingRequestIds.includes(activePrompt.requestId)}
      answers={answers}
      questionIndex={questionIndex}
      onToggleOption={onToggleOption}
      {...(className ? { className } : {})}
      {...(onSelectSingleOption ? { onSelectSingleOption } : {})}
      {...(onAdvance ? { onAdvance } : {})}
    />
  );
});

const ComposerPendingUserInputCard = memo(function ComposerPendingUserInputCard({
  prompt,
  isResponding,
  answers,
  questionIndex,
  onToggleOption,
  onSelectSingleOption,
  onAdvance,
  className,
}: {
  prompt: PendingUserInput;
  isResponding: boolean;
  answers: Record<string, PendingUserInputDraftAnswer>;
  questionIndex: number;
  onToggleOption: (questionId: string, optionLabel: string) => void;
  onSelectSingleOption?: (questionId: string, optionLabel: string) => void;
  onAdvance?: () => void;
  className?: string;
}) {
  const progress = derivePendingUserInputProgress(prompt.questions, answers, questionIndex);
  const activeQuestion = progress.activeQuestion;
  const autoAdvanceTimerRef = useRef<number | null>(null);
  const [optimisticSingleSelect, setOptimisticSingleSelect] = useState<{
    questionId: string;
    optionLabel: string;
  } | null>(null);
  useEffect(
    () => () => {
      if (autoAdvanceTimerRef.current !== null) {
        window.clearTimeout(autoAdvanceTimerRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    if (!activeQuestion || activeQuestion.multiSelect || !optimisticSingleSelect) {
      return;
    }
    if (optimisticSingleSelect.questionId !== activeQuestion.id) {
      setOptimisticSingleSelect(null);
      return;
    }
    if (
      progress.customAnswer.trim().length === 0 &&
      progress.selectedOptionLabels.includes(optimisticSingleSelect.optionLabel)
    ) {
      setOptimisticSingleSelect(null);
    }
  }, [
    activeQuestion,
    optimisticSingleSelect,
    progress.customAnswer,
    progress.selectedOptionLabels,
  ]);

  const handleOptionSelection = useCallback(
    (questionId: string, optionLabel: string) => {
      if (activeQuestion?.multiSelect) {
        onToggleOption(questionId, optionLabel);
        return;
      }
      setOptimisticSingleSelect({ questionId, optionLabel });
      if (onSelectSingleOption) {
        onSelectSingleOption(questionId, optionLabel);
        return;
      }
      onToggleOption(questionId, optionLabel);
      if (onAdvance) {
        if (autoAdvanceTimerRef.current !== null) {
          window.clearTimeout(autoAdvanceTimerRef.current);
        }
        autoAdvanceTimerRef.current = window.setTimeout(() => {
          autoAdvanceTimerRef.current = null;
          onAdvance();
        }, 200);
      }
    },
    [activeQuestion, onAdvance, onSelectSingleOption, onToggleOption],
  );

  useEffect(() => {
    if (!activeQuestion || isResponding) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        return;
      }
      if (
        target instanceof HTMLElement &&
        target.closest('[contenteditable]:not([contenteditable="false"])')
      ) {
        return;
      }
      const normalizedKey = event.key.toLocaleLowerCase();
      const optionIndex = /^[1-9]$/.test(normalizedKey)
        ? Number.parseInt(normalizedKey, 10) - 1
        : /^[a-i]$/.test(normalizedKey)
          ? normalizedKey.charCodeAt(0) - 97
          : -1;
      if (optionIndex < 0) return;
      if (optionIndex >= activeQuestion.options.length) return;
      const option = activeQuestion.options[optionIndex];
      if (!option) return;
      event.preventDefault();
      handleOptionSelection(activeQuestion.id, option.label);
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [activeQuestion, handleOptionSelection, isResponding]);

  if (!activeQuestion) {
    return null;
  }

  const customAnswerActive = progress.customAnswer.trim().length > 0;

  return (
    <section
      aria-label={activeQuestion.question}
      className={cn(
        "w-full max-w-2xl rounded-2xl border border-border bg-foreground/5 p-3",
        className,
      )}
      data-testid="pending-user-input-card"
    >
      <div className="flex items-start gap-3">
        <p className="min-w-0 flex-1 text-[15px] font-medium leading-6 text-foreground">
          {activeQuestion.question}
        </p>
        {prompt.questions.length > 1 ? (
          <span className="mt-1 shrink-0 text-[11px] text-muted-foreground tabular-nums">
            {questionIndex + 1}/{prompt.questions.length}
          </span>
        ) : null}
      </div>
      {activeQuestion.multiSelect ? (
        <p className="mt-1 text-xs text-muted-foreground">Select one or more.</p>
      ) : null}
      <div className="mt-3 overflow-hidden rounded-xl border border-border/80 bg-background/25 divide-y divide-border/70">
        {activeQuestion.options.map((option, index) => {
          const isOptimisticallySelected =
            optimisticSingleSelect?.questionId === activeQuestion.id &&
            optimisticSingleSelect.optionLabel === option.label;
          const isSelected =
            isOptimisticallySelected ||
            (!customAnswerActive && progress.selectedOptionLabels.includes(option.label));
          const shortcutKey = index < 9 ? String.fromCharCode(65 + index) : null;
          const className = cn(
            "group flex min-h-12 w-full items-center gap-3 px-3 py-2.5 text-left outline-none transition-colors duration-150 focus-visible:relative focus-visible:z-10 focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-primary/35",
            isSelected
              ? "bg-muted/70 text-foreground"
              : "bg-transparent text-foreground/90 hover:bg-muted/35",
            isResponding && "opacity-50 cursor-not-allowed",
            !isResponding && "cursor-pointer",
          );
          const content = (
            <>
              {shortcutKey !== null ? (
                <kbd className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-muted/70 text-[11px] font-medium text-muted-foreground">
                  {shortcutKey}
                </kbd>
              ) : null}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-sm font-medium">{option.label}</span>
                {option.description && option.description !== option.label ? (
                  <span className="text-secondary-label text-[11px]">{option.description}</span>
                ) : null}
              </div>
              {isSelected ? <CheckIcon className="size-3.5 shrink-0 text-primary" /> : null}
            </>
          );
          return (
            <button
              key={`${activeQuestion.id}:${option.label}`}
              type="button"
              aria-pressed={isSelected}
              disabled={isResponding}
              onClick={() => {
                handleOptionSelection(activeQuestion.id, option.label);
              }}
              className={className}
            >
              {content}
            </button>
          );
        })}
      </div>
      {activeQuestion.multiSelect && onAdvance ? (
        <div className="mt-3 flex justify-end">
          <Button
            size="xs"
            disabled={isResponding || progress.selectedOptionLabels.length === 0}
            onClick={onAdvance}
          >
            {questionIndex < prompt.questions.length - 1 ? "Continue" : "Submit"}
          </Button>
        </div>
      ) : null}
    </section>
  );
});
