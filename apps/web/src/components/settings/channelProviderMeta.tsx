import type { ChannelProvider } from "@t3tools/contracts";

import {
  DiscordIcon,
  IMessageIcon,
  SlackIcon,
  TelegramIcon,
  WhatsAppIcon,
  type Icon,
} from "../Icons";

export interface ChannelCredentialField {
  readonly key: string;
  readonly label: string;
  readonly placeholder: string;
  readonly sensitive: boolean;
  /** Restrict the field to one Photon connection type. */
  readonly mode?: "hosted" | "self-hosted";
  readonly optional?: boolean;
}

export interface ChannelProviderMeta {
  readonly provider: ChannelProvider;
  readonly label: string;
  readonly icon: Icon;
  readonly tagline: string;
  readonly consoleLabel: string;
  readonly consoleUrl: string;
  readonly steps: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<ChannelCredentialField>;
}

export const CHANNEL_PROVIDER_META: ReadonlyArray<ChannelProviderMeta> = [
  {
    provider: "imessage",
    label: "iMessage",
    icon: IMessageIcon,
    tagline: "Direct messages through Photon",
    consoleLabel: "Open Photon dashboard",
    consoleUrl: "https://photon.chat",
    steps: [
      "Create a Photon project, or run a self-hosted Photon server.",
      "Copy the hosted project credentials, or your server URL and API key.",
      "Paste the credentials here.",
    ],
    fields: [
      {
        key: "projectId",
        label: "Project ID",
        placeholder: "SPECTRUM_PROJECT_ID",
        sensitive: false,
        mode: "hosted",
      },
      {
        key: "projectSecret",
        label: "Project secret",
        placeholder: "SPECTRUM_PROJECT_SECRET",
        sensitive: true,
        mode: "hosted",
      },
      {
        key: "serverUrl",
        label: "Server URL",
        placeholder: "https://imessage.example.com",
        sensitive: false,
        mode: "self-hosted",
      },
      {
        key: "apiKey",
        label: "API key",
        placeholder: "API key",
        sensitive: true,
        mode: "self-hosted",
      },
      {
        key: "phone",
        label: "Phone (optional)",
        placeholder: "+15555550100",
        sensitive: false,
        mode: "self-hosted",
        optional: true,
      },
    ],
  },
  {
    provider: "whatsapp",
    label: "WhatsApp",
    icon: WhatsAppIcon,
    tagline: "Direct messages through the WhatsApp Business Cloud API",
    consoleLabel: "Open Meta app dashboard",
    consoleUrl: "https://developers.facebook.com/apps",
    steps: [
      "Create a Meta app with WhatsApp and copy the access token, app secret, and phone number ID.",
      "Choose a verify token and configure the webhook URL shown in the docs.",
      "Paste all four values here.",
    ],
    fields: [
      { key: "accessToken", label: "Access token", placeholder: "Access token", sensitive: true },
      { key: "appSecret", label: "App secret", placeholder: "App secret", sensitive: true },
      {
        key: "phoneNumberId",
        label: "Phone number ID",
        placeholder: "Phone number ID",
        sensitive: false,
      },
      { key: "verifyToken", label: "Verify token", placeholder: "Verify token", sensitive: true },
    ],
  },
  {
    provider: "telegram",
    label: "Telegram",
    icon: TelegramIcon,
    tagline: "Direct messages through a BotFather bot",
    consoleLabel: "Open BotFather",
    consoleUrl: "https://t.me/BotFather",
    steps: [
      "Message @BotFather and send /newbot.",
      "Copy the bot token BotFather returns.",
      "Paste the token here.",
    ],
    fields: [{ key: "token", label: "Bot token", placeholder: "123456:ABC…", sensitive: true }],
  },
  {
    provider: "slack",
    label: "Slack",
    icon: SlackIcon,
    tagline: "Direct messages and mentions over Socket Mode",
    consoleLabel: "Open Slack app console",
    consoleUrl: "https://api.slack.com/apps",
    steps: [
      "Create a Slack app, enable Socket Mode, and create an app-level token with the connections scope.",
      "Install the app to your workspace and copy the bot token.",
      "Subscribe the app to direct-message and mention events, then paste both tokens here.",
    ],
    fields: [
      { key: "botToken", label: "Bot token", placeholder: "xoxb-…", sensitive: true },
      { key: "appToken", label: "App-level token", placeholder: "xapp-…", sensitive: true },
    ],
  },
  {
    provider: "discord",
    label: "Discord",
    icon: DiscordIcon,
    tagline: "Direct messages and mentions through the Gateway",
    consoleLabel: "Open Discord developer portal",
    consoleUrl: "https://discord.com/developers/applications",
    steps: [
      "Create a Discord application and bot, then enable Message Content Intent.",
      "Copy the application ID, public key, and bot token.",
      "Paste them here, then invite the bot with the generated link.",
    ],
    fields: [
      {
        key: "applicationId",
        label: "Application ID",
        placeholder: "Application ID",
        sensitive: false,
      },
      { key: "publicKey", label: "Public key", placeholder: "Public key", sensitive: false },
      { key: "botToken", label: "Bot token", placeholder: "Bot token", sensitive: true },
    ],
  },
];

export function channelProviderMeta(provider: ChannelProvider): ChannelProviderMeta {
  return (
    CHANNEL_PROVIDER_META.find((meta) => meta.provider === provider) ?? CHANNEL_PROVIDER_META[0]!
  );
}

/** Permissions: view channels, send messages, read history, threads, reactions. */
export function discordInviteUrl(applicationId: string): string | null {
  const trimmed = applicationId.trim();
  if (!/^\d{15,21}$/u.test(trimmed)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${trimmed}&scope=bot&permissions=397552987200`;
}

/** Route a pasted Slack token to its field by prefix. */
export function slackPasteTarget(pasted: string): "botToken" | "appToken" | null {
  const value = pasted.trim();
  if (value.startsWith("xoxb-")) return "botToken";
  if (value.startsWith("xapp-")) return "appToken";
  return null;
}
