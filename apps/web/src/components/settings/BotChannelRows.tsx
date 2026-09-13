import {
  type BotId,
  type ChannelBinding,
  type ChannelProvider,
  type ProjectId,
} from "@t3tools/contracts";

export interface ChannelBot {
  readonly id: BotId;
  readonly channelBindings?: readonly ChannelBinding[];
}

export function bindingFor(bot: ChannelBot, provider: ChannelProvider): ChannelBinding {
  return (
    bot.channelBindings?.find((binding) => binding.provider === provider) ?? {
      botId: bot.id,
      provider,
      status: "disconnected",
      externalIdentity: null,
      connectedAt: null,
      sentMessageIds: [],
    }
  );
}

export function selfHostedIMessageConnectInput(
  botId: BotId,
  targetProjectId: ProjectId,
  serverUrl: string,
  apiKey: string,
  phone: string,
) {
  const trimmedPhone = phone.trim();
  return {
    botId,
    targetProjectId,
    provider: "imessage" as const,
    mode: "self-hosted" as const,
    serverUrl: serverUrl.trim(),
    apiKey: apiKey.trim(),
    ...(trimmedPhone ? { phone: trimmedPhone } : {}),
  };
}

export function whatsAppConnectInput(
  botId: BotId,
  targetProjectId: ProjectId,
  accessToken: string,
  appSecret: string,
  phoneNumberId: string,
  verifyToken: string,
) {
  return {
    botId,
    targetProjectId,
    provider: "whatsapp" as const,
    accessToken: accessToken.trim(),
    appSecret: appSecret.trim(),
    phoneNumberId: phoneNumberId.trim(),
    verifyToken: verifyToken.trim(),
  };
}
