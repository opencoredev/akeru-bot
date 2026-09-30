import type {
  ChannelDeliveryState,
  ChannelMessageOrigin,
  ChannelProvider,
  OrchestrationMessage,
} from "@t3tools/contracts";

import { channelProviderLabel } from "./channelPresentation.ts";

export function channelOriginLabel(
  origin: ChannelMessageOrigin,
  senderDisplayName?: string | null,
): string {
  const sender = senderDisplayName?.trim() || origin.externalSenderId;
  const provider = channelProviderLabel(origin.provider);
  return sender ? `${provider} · ${sender}` : provider;
}

/**
 * The external conversation an assistant message replies to: the nearest
 * preceding user message's channel origin. Returns null when the reply did not
 * come from a channel.
 */
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
 * Delivery label for a channel-originated assistant reply. Returns null for
 * messages with no external delivery state so web and mobile can skip the
 * metadata chip entirely. Without a provider, for a reply whose inbound
 * message is on an older unloaded page, the label names no channel.
 */
export function channelDeliveryLabel(
  delivery: ChannelDeliveryState | null | undefined,
  provider: ChannelProvider | null | undefined,
): { readonly message: string; readonly tone: "neutral" | "warning" | "error" } | null {
  const channel = provider ? channelProviderLabel(provider) : "the channel";
  switch (delivery) {
    case "sent":
      return { message: `Sent to ${channel}`, tone: "neutral" };
    case "pending":
      return { message: `Sending to ${channel}…`, tone: "neutral" };
    case "failed":
      return { message: `Could not deliver to ${channel}`, tone: "error" };
    case "unknown":
      return { message: `Delivery to ${channel} unknown`, tone: "warning" };
    default:
      return null;
  }
}
