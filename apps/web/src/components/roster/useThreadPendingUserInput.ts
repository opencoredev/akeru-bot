import type { ApprovalRequestId, ScopedThreadRef } from "@akeru/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  applyPendingUserInputSingleSelect,
  buildPendingUserInputAnswers,
  type PendingUserInputDraftAnswer,
  togglePendingUserInputOptionSelection,
} from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { type BotThreadFailure, commandFailure } from "./threadRuntimeWarning.logic";

/**
 * Answers the oldest open question in a bot or group chat. Draft answers and the question
 * index reset whenever a different question comes up, and a request id stays marked as
 * responding from the moment its answer is sent until the question leaves the thread.
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
  const singleSelectInFlightRef = useRef<string | null>(null);

  const [pendingUserInputAnswers, setPendingUserInputAnswers] = useState<
    Record<string, PendingUserInputDraftAnswer>
  >({});

  const [pendingUserInputQuestionIndex, setPendingUserInputQuestionIndex] = useState(0);

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

      if (result._tag === "Failure") {
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
   * Takes a typed prompt as the custom answer to the current question. Resolves true when
   * it moved on to the next question or sent the answers.
   */
  const answerPendingUserInputWithPrompt = useCallback(
    async (pendingUserInput: PendingUserInput, prompt: string): Promise<boolean> => {
      if (respondingRequestIds.includes(pendingUserInput.requestId)) return false;
      const question = pendingUserInput.questions[pendingUserInputQuestionIndex];

      if (!question || !prompt.trim()) return false;

      const nextAnswers = {
        ...pendingUserInputAnswers,
        [question.id]: { customAnswer: prompt.trim() },
      };

      setPendingUserInputAnswers(nextAnswers);

      if (pendingUserInputQuestionIndex < pendingUserInput.questions.length - 1) {
        setPendingUserInputQuestionIndex((index) => index + 1);

        return true;
      }

      const answers = buildPendingUserInputAnswers(pendingUserInput.questions, nextAnswers);

      if (!answers) return false;

      return submitPendingUserInput(pendingUserInput.requestId, answers);
    },
    [
      pendingUserInputAnswers,
      pendingUserInputQuestionIndex,
      respondingRequestIds,
      submitPendingUserInput,
    ],
  );

  useEffect(() => {
    setPendingUserInputAnswers({});
    setPendingUserInputQuestionIndex(0);
    singleSelectInFlightRef.current = null;
    const pendingIds = new Set(pendingUserInputs.map((pending) => pending.requestId));

    for (const requestId of respondingRequestIdsRef.current) {
      if (!pendingIds.has(requestId)) respondingRequestIdsRef.current.delete(requestId);
    }

    setRespondingRequestIds((current) => current.filter((requestId) => pendingIds.has(requestId)));
  }, [pendingUserInputs[0]?.requestId]);

  const selectPendingUserInputOption = useCallback(
    (questionId: string, optionLabel: string) => {
      const pending = pendingUserInputs[0];
      const question = pending?.questions.find((entry) => entry.id === questionId);

      if (!pending || !question) return;

      if (!question.multiSelect) {
        const selectionKey = `${pending.requestId}:${questionId}`;

        if (singleSelectInFlightRef.current === selectionKey) return;

        const selection = applyPendingUserInputSingleSelect(
          pending.questions,
          pendingUserInputAnswers,
          pendingUserInputQuestionIndex,
          questionId,
          optionLabel,
        );

        if (!selection) return;
        singleSelectInFlightRef.current = selectionKey;
        setPendingUserInputAnswers(selection.draftAnswers);

        if (!selection.answers) {
          setPendingUserInputQuestionIndex(selection.questionIndex);

          return;
        }

        void submitPendingUserInput(pending.requestId, selection.answers).then((submitted) => {
          if (!submitted) singleSelectInFlightRef.current = null;
        });

        return;
      }

      setPendingUserInputAnswers((current) => ({
        ...current,
        [questionId]: togglePendingUserInputOptionSelection(
          question,
          current[questionId],
          optionLabel,
        ),
      }));
    },
    [
      pendingUserInputAnswers,
      pendingUserInputQuestionIndex,
      pendingUserInputs,
      submitPendingUserInput,
    ],
  );

  const advancePendingUserInput = useCallback(async () => {
    const pending = pendingUserInputs[0];

    if (!pending || !linkedThreadRef || respondingRequestIds.includes(pending.requestId)) return;

    if (pendingUserInputQuestionIndex < pending.questions.length - 1) {
      setPendingUserInputQuestionIndex((index) => index + 1);

      return;
    }

    const answers = buildPendingUserInputAnswers(pending.questions, pendingUserInputAnswers);

    if (!answers) return;
    await submitPendingUserInput(pending.requestId, answers);
  }, [
    linkedThreadRef,
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    pendingUserInputs,
    respondingRequestIds,
    submitPendingUserInput,
  ]);

  return {
    pendingUserInputAnswers,
    pendingUserInputQuestionIndex,
    respondingRequestIds,
    answerPendingUserInputWithPrompt,
    selectPendingUserInputOption,
    advancePendingUserInput,
  };
}
