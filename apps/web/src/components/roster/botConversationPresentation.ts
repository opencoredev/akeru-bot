import {
  channelOriginLabel as sharedChannelOriginLabel,
  channelProviderLabel as sharedChannelProviderLabel,
} from "@t3tools/client-runtime/channel-presentation";
import type { ChannelMessageOrigin, OrchestrationMessage } from "@t3tools/contracts";
import type { RosterPresence } from "./roster.logic";

export const channelProviderLabel = sharedChannelProviderLabel;

export function channelOriginLabel(
  origin: ChannelMessageOrigin,
  senderDisplayName?: string | null,
): string {
  return sharedChannelOriginLabel(origin, senderDisplayName);
}

export function channelOriginForAssistantMessage(
  messages: ReadonlyArray<OrchestrationMessage>,
  assistantIndex: number,
): ChannelMessageOrigin | null {
  if (messages[assistantIndex]?.role !== "assistant") return null;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.channelOrigin ?? null;
  }
  return null;
}

export function isBotConversationWorking(input: {
  sending: boolean;
  respondingToUserInput: boolean;
  presence: RosterPresence;
}): boolean {
  return input.sending || input.respondingToUserInput || input.presence === "working";
}

/**
 * Bot chat shows each user message and one final assistant answer per turn.
 * Provider progress and intermediate assistant records stay behind the working
 * status so one provider turn cannot appear as several bot replies.
 */
export function visibleBotChatMessages(
  messages: ReadonlyArray<OrchestrationMessage>,
  working = false,
): ReadonlyArray<OrchestrationMessage> {
  const latestAssistantIndexByResponse = new Map<string, number>();
  let precedingUserId = "before-first-user";
  let lastUserIndex = -1;

  messages.forEach((message, index) => {
    if (message.role === "user" && String(message.id).startsWith("routine:")) return;
    if (message.role === "user") {
      precedingUserId = message.id;
      lastUserIndex = index;
      return;
    }
    if (message.role !== "assistant" || message.streaming) return;
    latestAssistantIndexByResponse.set(message.turnId ?? precedingUserId, index);
  });

  precedingUserId = "before-first-user";
  return messages.filter((message, index) => {
    if (message.role === "user" && String(message.id).startsWith("routine:")) return false;
    if (message.role === "user") {
      precedingUserId = message.id;
      return true;
    }
    if (message.role !== "assistant" || message.streaming) return false;
    if (working && index > lastUserIndex) return false;
    return latestAssistantIndexByResponse.get(message.turnId ?? precedingUserId) === index;
  });
}
