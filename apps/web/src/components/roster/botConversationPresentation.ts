import type { ChannelMessageOrigin, OrchestrationMessage } from "@t3tools/contracts";

export function channelProviderLabel(
  provider: ChannelMessageOrigin["provider"] | "whatsapp",
): string {
  if (provider === "imessage") return "iMessage";
  if (provider === "whatsapp") return "WhatsApp";
  return "Telegram";
}

export function channelOriginLabel(origin: ChannelMessageOrigin): string {
  const provider = channelProviderLabel(origin.provider);
  return origin.provider === "imessage" && origin.externalSenderId
    ? `${provider} · ${origin.externalSenderId}`
    : provider;
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
