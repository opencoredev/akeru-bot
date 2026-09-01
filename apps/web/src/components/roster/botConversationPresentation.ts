import type { OrchestrationMessage } from "@t3tools/contracts";

/**
 * Bot chat shows user messages and every completed assistant note. A turn can
 * answer before tools, add status beats during work, and finish with a result.
 */
export function visibleBotChatMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
): ReadonlyArray<OrchestrationMessage> {
  return messages.filter(
    (message) => message.role === "user" || (message.role === "assistant" && !message.streaming),
  );
}
