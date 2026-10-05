import { Predicate } from "effect";
import type { ApprovalRequestId, ScopedThreadRef } from "@akeru/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyPendingUserInputOptionSelection,
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  pendingUserInputStepAfterAnswer,
} from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { type BotThreadFailure, commandFailure } from "./threadRuntimeWarning.logic";

/**
 * Answers the oldest open question in a bot or group chat, one question (step) at a time.
 * Draft answers and the step reset whenever a different prompt comes up, and a request id
 * stays marked as responding from the moment its answer is sent until the prompt leaves
 * the thread.
 */
export function useThreadPendingUserInput(input: {
  readonly linkedThreadRef: ScopedThreadRef | null;
  readonly pendingUserInputs: ReadonlyArray<PendingUserInput>;
  readonly onFailure: (failure: BotThreadFailure) => void;
}) {
  const { linkedThreadRef, onFailure, pendingUserInputs } = input;

  const respondToUserInputCommand = useAtomCommand(threadEnvironment.respondToUserInput, {
    reportFailure: false,
  });

  const [respondingRequestIds, setRespondingRequestIds] = useState<ApprovalRequestId[]>([]);
  const respondingRequestIdsRef = useRef(new Set<ApprovalRequestId>());

  const [pendingUserInputAnswers, setPendingUserInputAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({});

  const [pendingUserInputStep, setPendingUserInputStep] = useState(0);

  const submitPendingUserInput = useCallback(
    async (
      requestId: ApprovalRequestId,
      answers: Record<string, string | string[]>,
    ): Promise<boolean> => {
      if (!linkedThreadRef || respondingRequestIdsRef.current.has(requestId)) return false;
      respondingRequestIdsRef.current.add(requestId);
      setRespondingRequestIds((current) =>
        current.includes(requestId) ? current : [...current, requestId],
      );

      const result = await respondToUserInputCommand({
        environmentId: linkedThreadRef.environmentId,
        input: { threadId: linkedThreadRef.threadId, requestId, answers },
      });

      if (Predicate.isTagged(result, "Failure")) {
        respondingRequestIdsRef.current.delete(requestId);
        setRespondingRequestIds((current) => current.filter((id) => id !== requestId));
        onFailure(commandFailure(result));

        return false;
      }

      return true;
    },
    [linkedThreadRef, onFailure, respondToUserInputCommand],
  );

  /**
   * Takes a typed prompt as the custom answer to the current step, then moves on like a
   * pick would, sending from the last step once every question is answered. Resolves true
   * when the text was used.
   */
  const answerPendingUserInputWithPrompt = useCallback(
    async (pendingUserInput: PendingUserInput, prompt: string): Promise<boolean> => {
      if (respondingRequestIds.includes(pendingUserInput.requestId)) return false;

      const { questions } = pendingUserInput;
      const step = Math.min(pendingUserInputStep, questions.length - 1);
      const question = questions[step];

      if (!question || !prompt.trim()) return false;

      const nextAnswers = {
        ...pendingUserInputAnswers,
        [question.id]: { customAnswer: prompt.trim() },
      };

      setPendingUserInputAnswers(nextAnswers);
      const nextStep = pendingUserInputStepAfterAnswer(questions, nextAnswers, step);

      if (nextStep !== null) {
        setPendingUserInputStep(nextStep);

        return true;
      }

      const answers = buildPendingUserInputAnswers(questions, nextAnswers);

      return answers ? submitPendingUserInput(pendingUserInput.requestId, answers) : true;
    },
    [pendingUserInputAnswers, pendingUserInputStep, respondingRequestIds, submitPendingUserInput],
  );

  /** Answers the question on screen with text typed into the card's own-answer row. */
  const answerPendingUserInputWithText = useCallback(
    (text: string) => {
      const pending = pendingUserInputs[0];

      return pending ? answerPendingUserInputWithPrompt(pending, text) : Promise.resolve(false);
    },
    [answerPendingUserInputWithPrompt, pendingUserInputs],
  );

  useEffect(() => {
    setPendingUserInputAnswers({});
    setPendingUserInputStep(0);
    const pendingIds = new Set(pendingUserInputs.map((pending) => pending.requestId));

    for (const requestId of respondingRequestIdsRef.current) {
      if (!pendingIds.has(requestId)) respondingRequestIdsRef.current.delete(requestId);
    }

    setRespondingRequestIds((current) => current.filter((requestId) => pendingIds.has(requestId)));
  }, [pendingUserInputs[0]?.requestId]);

  const selectPendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      const pending = pendingUserInputs[0];

      if (!pending || respondingRequestIdsRef.current.has(pending.requestId)) return;

      const selection = applyPendingUserInputOptionSelection(
        pending.questions,
        pendingUserInputAnswers,
        questionId,
        optionLabel,
      );

      if (!selection) return;
      setPendingUserInputAnswers(selection.draftAnswers);
      setPendingUserInputStep(selection.nextStep);

      if (selection.answers) void submitPendingUserInput(pending.requestId, selection.answers);
    },
    [pendingUserInputAnswers, pendingUserInputs, submitPendingUserInput],
  );

  const submitPendingUserInputAnswers = useCallback(async () => {
    const pending = pendingUserInputs[0];

    if (!pending) return;

    const answers = buildPendingUserInputAnswers(pending.questions, pendingUserInputAnswers);

    if (!answers) return;
    await submitPendingUserInput(pending.requestId, answers);
  }, [pendingUserInputAnswers, pendingUserInputs, submitPendingUserInput]);

  return {
    pendingUserInputAnswers,
    pendingUserInputStep,
    setPendingUserInputStep,
    respondingRequestIds,
    answerPendingUserInputWithPrompt,
    answerPendingUserInputWithText,
    selectPendingUserInputOption,
    submitPendingUserInputAnswers,
  };
}
