import { type ApprovalRequestId, type ScopedThreadRef } from "@akeru/contracts";

import { useI18n } from "../../i18n";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "../chat/ComposerPendingUserInputPanel";
import { OpenComputerAction } from "../computer/OpenComputerAction";
import type { Bot } from "./types";

export function BotUserInputPrompt({
  pendingUserInputs,
  respondingRequestIds,
  answers,
  questionIndex,
  onToggleOption,
  onSelectSingleOption,
  onAdvance,
  threadRef = null,
  askingBot = null,
}: {
  readonly pendingUserInputs: PendingUserInput[];
  readonly respondingRequestIds: ApprovalRequestId[];
  readonly answers: Record<string, PendingUserInputDraftAnswer>;
  readonly questionIndex: number;
  readonly onToggleOption: (questionId: string, optionLabel: string) => void;
  readonly onSelectSingleOption: (questionId: string, optionLabel: string) => void;
  readonly onAdvance: () => void;
  /** The chat's thread and the bot asking, so the prompt can open that bot's computer. */
  readonly threadRef?: ScopedThreadRef | null;
  readonly askingBot?: Pick<Bot, "name" | "sandbox" | "engine"> | null;
}) {
  const { t } = useI18n();
  // Once an answer is on its way the question has been dealt with: the composer's working
  // status takes over rather than leaving a dead card docked above the prompt box.
  const activePrompt = pendingUserInputs[0];
  if (!activePrompt || respondingRequestIds.includes(activePrompt.requestId)) return null;

  return (
    <section
      aria-label={t("Question")}
      className="mb-1 w-full rounded-t-[1.65rem] rounded-b-md border border-border/70 border-b-transparent bg-card px-3.5 pt-3 pb-2.5"
      data-testid="bot-user-input-prompt"
    >
      <ComposerPendingUserInputPanel
        className="!max-w-none !rounded-none !border-0 !bg-transparent !p-0"
        pendingUserInputs={pendingUserInputs}
        respondingRequestIds={respondingRequestIds}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={onToggleOption}
        onSelectSingleOption={onSelectSingleOption}
        onAdvance={onAdvance}
      />
      {askingBot ? (
        <div className="px-3 pb-2">
          <OpenComputerAction threadRef={threadRef} bot={askingBot} />
        </div>
      ) : null}
    </section>
  );
}
