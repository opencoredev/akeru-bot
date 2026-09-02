import { type ApprovalRequestId } from "@t3tools/contracts";

import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";

export function BotUserInputPrompt({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onSelectSingleOption,
  onAdvance,
}: {
  readonly pendingUserInputs: PendingUserInput[];
  readonly respondingRequestIds: ApprovalRequestId[];
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly onToggleOption: (questionId: string, optionLabel: string) => void;
  readonly onSelectSingleOption: (questionId: string, optionLabel: string) => void;
  readonly onAdvance: () => void;
}) {
  return (
    <section
      aria-label="Question"
      className="mb-1.5 w-full rounded-t-[1.65rem] rounded-b-lg border border-white/10 bg-foreground/[0.12] dark:bg-white/[0.16]"
      data-testid="bot-user-input-prompt"
    >
      <ComposerPendingUserInputPanel
        pendingUserInputs={pendingUserInputs}
        respondingRequestIds={respondingRequestIds}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={onToggleOption}
        onSelectSingleOption={onSelectSingleOption}
        onAdvance={onAdvance}
      />
    </section>
  );
}
