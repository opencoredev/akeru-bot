import * as NodeCrypto from "node:crypto";
import { BotId, CommandId, ProjectId } from "@akeru/contracts";

/** Fixed IDs and connect inputs shared by the channel runtime tests. */
const NOW = "2026-08-27T20:00:00.000Z";

const BOT_ID = BotId.make("bot-1");

const PROJECT_ID = ProjectId.make("project-1");

const SECOND_PROJECT_ID = ProjectId.make("project-2");

const MISSING_PROJECT_ID = ProjectId.make("project-missing");

const telegramConnect = (botId: BotId, token = "telegram-token") => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "telegram" as const,
  token,
});

const imessageConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-imessage-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "imessage" as const,
  mode: "hosted" as const,
  projectId: "photon-project",
  projectSecret: "photon-secret",
});

const whatsappConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-whatsapp-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "whatsapp" as const,
  accessToken: "access-token",
  appSecret: "app-secret",
  phoneNumberId: "phone-number-id",
  verifyToken: "verify-token",
});

const slackConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-slack-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "slack" as const,
  botToken: "xoxb-token",
  appToken: "xapp-token",
});

const discordConnect = (botId: BotId) => ({
  type: "channel.connect" as const,
  commandId: CommandId.make(`connect-discord-${botId}`),
  botId,
  targetProjectId: PROJECT_ID,
  provider: "discord" as const,
  botToken: "discord-token",
  applicationId: "discord-app",
  publicKey: "discord-public-key",
});

const signedWhatsAppRequest = (body: string) =>
  new Request(`https://akeru.example/api/channels/whatsapp/${BOT_ID}/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-hub-signature-256": `sha256=${NodeCrypto.createHmac("sha256", "app-secret").update(body).digest("hex")}`,
    },
    body,
  });

export {
  NOW,
  BOT_ID,
  PROJECT_ID,
  SECOND_PROJECT_ID,
  MISSING_PROJECT_ID,
  telegramConnect,
  imessageConnect,
  whatsappConnect,
  slackConnect,
  discordConnect,
  signedWhatsAppRequest,
};
