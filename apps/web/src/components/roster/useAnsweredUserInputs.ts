import type { OrchestrationMessage, OrchestrationThreadActivity } from "@akeru/contracts";
import {
  type AnsweredUserInputQuestion,
  answeredUserInputForMessage,
  deriveAskedUserInputs,
} from "@akeru/client-runtime/user-input-answers";
import { useMemo } from "react";

/** Messages that answer a bot's questions, keyed by message id, so rows can show answer cards. */
export function useAnsweredUserInputs(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyMap<string, ReadonlyArray<AnsweredUserInputQuestion>> {
  return useMemo(() => {
    const answeredByMessageId = new Map<string, ReadonlyArray<AnsweredUserInputQuestion>>();
    const asked = deriveAskedUserInputs(activities);

    if (asked.size === 0) return answeredByMessageId;

    for (const message of messages) {
      if (message.role !== "user") continue;
      const answered = answeredUserInputForMessage(message, asked);

      if (answered) answeredByMessageId.set(message.id, answered);
    }

    return answeredByMessageId;
  }, [activities, messages]);
}
