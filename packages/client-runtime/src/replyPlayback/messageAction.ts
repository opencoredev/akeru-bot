import type { OrchestrationMessage } from "@t3tools/contracts";
import { replyMarkdownToSpokenText } from "./spokenText.ts";

/** Uses only the stored assistant text, never attachments, tool events, or a new turn. */
export function replyReadoutMessageAction(
  message: Pick<OrchestrationMessage, "role" | "streaming" | "text">,
) {
  if (message.role !== "assistant" || message.streaming) return null;
  return replyMarkdownToSpokenText(message.text);
}
