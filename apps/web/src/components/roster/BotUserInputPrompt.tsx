import { type ApprovalRequestId } from "@akeru/contracts";

import { useI18n } from "../../i18n";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { cn } from "../../lib/utils";
import {
  BOT_COMPOSER_DOCKED_PANEL_CLASS_NAME,
  BOT_COMPOSER_QUIET_SURFACE_CLASS_NAME,
} from "./botConversationPresentation";

export function BotUserInputPrompt({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  step,
  onStepChange,
  onSelectOption,
  onAnswerWithText,
  onSubmit,
}: {
  readonly pendingUserInputs: PendingUserInput[];
  readonly respondingRequestIds: ApprovalRequestId[];
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly step: number;
  readonly onStepChange: (step: number) => void;
  readonly onSelectOption: (questionId: string, optionLabel: string) => void;
  readonly onAnswerWithText: (text: string) => void;
  readonly onSubmit: () => void;
}) {
  const { t } = useI18n();
  // Once an answer is on its way the question has been dealt with: the composer's working
  // status takes over rather than leaving a dead card docked above the prompt box.
  const activePrompt = pendingUserInputs[0];

  if (!activePrompt || respondingRequestIds.includes(activePrompt.requestId)) return null;

  return (
    <section
      aria-label={t("Question")}
      className={cn(BOT_COMPOSER_QUIET_SURFACE_CLASS_NAME, BOT_COMPOSER_DOCKED_PANEL_CLASS_NAME)}
      data-testid="bot-user-input-prompt"
    >
      <ComposerPendingUserInputPanel
        surface="docked"
        pendingUserInputs={pendingUserInputs}
        respondingRequestIds={respondingRequestIds}
        answers={answers}
        step={step}
        onStepChange={onStepChange}
        onSelectOption={onSelectOption}
        onAnswerWithText={onAnswerWithText}
        onSubmit={onSubmit}
      />
    </section>
  );
}
