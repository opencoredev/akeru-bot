import type {
  ChannelBinding,
  ChannelBindingStatus,
  ChannelMessageOrigin,
  ChannelProvider,
  ProjectId,
} from "@t3tools/contracts";

export function channelProviderLabel(provider: ChannelProvider): string {
  if (provider === "imessage") return "iMessage";
  if (provider === "whatsapp") return "WhatsApp";
  if (provider === "telegram") return "Telegram";
  if (provider === "slack") return "Slack";
  return "Discord";
}

export function channelHealthLabel(status: ChannelBindingStatus): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "disconnected":
      return "Disconnected";
    case "needs-reconnect":
      return "Reconnect required";
    case "failed":
      return "Connection failed";
    case "not-live":
      return "Not live";
  }
}

export function channelBindingPresentation(
  binding: ChannelBinding,
  projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>,
) {
  const deliveredCount = new Set(binding.sentMessageIds).size;
  return {
    provider: channelProviderLabel(binding.provider),
    health: channelHealthLabel(binding.status),
    warning: binding.lastError ? "Channel needs attention" : null,
    project: binding.projectId
      ? (projects.find((project) => project.id === binding.projectId)?.title ??
        "Project unavailable")
      : "No project selected",
    delivery:
      deliveredCount === 0
        ? "No confirmed deliveries"
        : `${deliveredCount} confirmed ${deliveredCount === 1 ? "delivery" : "deliveries"}`,
  };
}

export function channelOriginLabel(
  origin: ChannelMessageOrigin,
  senderDisplayName?: string | null,
): string {
  const sender = senderDisplayName?.trim() || origin.externalSenderId;
  const provider = channelProviderLabel(origin.provider);
  return sender ? `${provider} · ${sender}` : provider;
}
