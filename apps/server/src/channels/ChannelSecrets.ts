import * as NodeCrypto from "node:crypto";
import {
  BotId,
  ChannelConnectionId,
  CommandId,
  type ProjectId,
  type ChannelProvider,
} from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ChannelRuntimeError, failWith } from "./ChannelErrors.ts";
import {
  type LiveProvider,
  type ChannelConnectInput,
  type ChannelConnectionSaveInput,
  type ChannelRuntimeContext,
} from "./ChannelRuntimeTypes.ts";
import { encoder, decoder } from "./ChannelWebhooks.ts";
export const StoredChannelSecret = Schema.Union([
  Schema.Struct({ provider: Schema.Literal("telegram"), token: Schema.String }),
  Schema.Struct({
    provider: Schema.Literal("imessage"),
    mode: Schema.Literals(["hosted", "self-hosted"]),
    projectId: Schema.optional(Schema.String),
    projectSecret: Schema.optional(Schema.String),
    serverUrl: Schema.optional(Schema.String),
    apiKey: Schema.optional(Schema.String),
    phone: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    provider: Schema.Literal("whatsapp"),
    accessToken: Schema.String,
    appSecret: Schema.String,
    phoneNumberId: Schema.String,
    verifyToken: Schema.String,
  }),
  Schema.Struct({
    provider: Schema.Literal("slack"),
    botToken: Schema.String,
    appToken: Schema.String,
  }),
  Schema.Struct({
    provider: Schema.Literal("discord"),
    botToken: Schema.String,
    applicationId: Schema.String,
    publicKey: Schema.String,
  }),
]);

export type StoredChannelSecret = typeof StoredChannelSecret.Type;

export const StoredChannelSecretJson = Schema.fromJsonString(StoredChannelSecret);

export const decodeStoredChannelSecret = Schema.decodeUnknownEffect(StoredChannelSecretJson);

export const encodeStoredChannelSecretJson = Schema.encodeEffect(StoredChannelSecretJson);

export const encodeStoredChannelSecret = (secret: StoredChannelSecret) =>
  encodeStoredChannelSecretJson(secret).pipe(Effect.map((json) => encoder.encode(json)));

export const runtimeKey = (botId: string, provider: ChannelProvider) => `${botId}:${provider}`;

export const secretName = (botId: BotId, provider: ChannelProvider) =>
  `channel-${provider}-${NodeCrypto.createHash("sha256").update(botId).digest("hex")}`;

export const connectionSecretName = (connectionId: ChannelConnectionId) =>
  `channel-connection-${NodeCrypto.createHash("sha256").update(connectionId).digest("hex")}`;

export const randomId = (ctx: ChannelRuntimeContext, prefix: string) =>
  ctx.deps.randomUuid.pipe(Effect.map((uuid) => `${prefix}-${uuid}`));

export const channelProviderName = (provider: ChannelProvider) =>
  provider === "imessage"
    ? "iMessage"
    : provider === "whatsapp"
      ? "WhatsApp"
      : provider === "telegram"
        ? "Telegram"
        : provider === "slack"
          ? "Slack"
          : "Discord";

export const decodeSecret = (stored: Option.Option<Uint8Array>) =>
  Option.isNone(stored)
    ? Effect.succeed(null)
    : decodeStoredChannelSecret(decoder.decode(stored.value));

export const loadSecret = (ctx: ChannelRuntimeContext, botId: BotId, provider: LiveProvider) =>
  ctx.deps.secretStore.get(secretName(botId, provider)).pipe(Effect.flatMap(decodeSecret));

export const loadConnectionSecret = (
  ctx: ChannelRuntimeContext,
  connectionId: ChannelConnectionId,
) =>
  ctx.deps.secretStore.get(connectionSecretName(connectionId)).pipe(Effect.flatMap(decodeSecret));

export const storedSecretFromInput = (
  input: ChannelConnectInput | ChannelConnectionSaveInput,
): StoredChannelSecret => {
  if (input.provider === "telegram") return { provider: "telegram", token: input.token };
  if (input.provider === "whatsapp") {
    return {
      provider: "whatsapp",
      accessToken: input.accessToken,
      appSecret: input.appSecret,
      phoneNumberId: input.phoneNumberId,
      verifyToken: input.verifyToken,
    };
  }
  if (input.provider === "slack") {
    return { provider: "slack", botToken: input.botToken, appToken: input.appToken };
  }
  if (input.provider === "discord") {
    return {
      provider: "discord",
      botToken: input.botToken,
      applicationId: input.applicationId,
      publicKey: input.publicKey,
    };
  }
  return input.mode === "hosted"
    ? {
        provider: "imessage",
        mode: "hosted",
        projectId: input.projectId,
        projectSecret: input.projectSecret,
      }
    : {
        provider: "imessage",
        mode: "self-hosted",
        serverUrl: input.serverUrl,
        apiKey: input.apiKey,
        ...(input.phone ? { phone: input.phone } : {}),
      };
};

export const connectInputFromSecret = (
  botId: BotId,
  targetProjectId: ProjectId,
  commandId: CommandId,
  secret: StoredChannelSecret,
): Effect.Effect<ChannelConnectInput, ChannelRuntimeError> => {
  if (secret.provider === "telegram") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "telegram",
      token: secret.token,
    });
  }
  if (secret.provider === "whatsapp") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "whatsapp",
      accessToken: secret.accessToken,
      appSecret: secret.appSecret,
      phoneNumberId: secret.phoneNumberId,
      verifyToken: secret.verifyToken,
    });
  }
  if (secret.provider === "slack") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "slack",
      botToken: secret.botToken,
      appToken: secret.appToken,
    });
  }
  if (secret.provider === "discord") {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "discord",
      botToken: secret.botToken,
      applicationId: secret.applicationId,
      publicKey: secret.publicKey,
    });
  }
  if (secret.mode === "hosted" && secret.projectId && secret.projectSecret) {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "imessage",
      mode: "hosted",
      projectId: secret.projectId,
      projectSecret: secret.projectSecret,
    });
  }
  if (secret.mode === "self-hosted" && secret.serverUrl && secret.apiKey) {
    return Effect.succeed({
      type: "channel.connect",
      commandId,
      botId,
      targetProjectId,
      provider: "imessage",
      mode: "self-hosted",
      serverUrl: secret.serverUrl,
      apiKey: secret.apiKey,
      ...(secret.phone ? { phone: secret.phone } : {}),
    });
  }
  return failWith("Saved channel credentials are incomplete.");
};

export const channelSecretIdentity = (secret: StoredChannelSecret): string => {
  if (secret.provider === "telegram") return `telegram:${secret.token}`;
  if (secret.provider === "whatsapp") return `whatsapp:${secret.phoneNumberId}`;
  if (secret.provider === "slack") return `slack:${secret.botToken}`;
  if (secret.provider === "discord") return `discord:${secret.applicationId}`;
  return secret.mode === "hosted"
    ? `imessage:hosted:${secret.projectId ?? ""}`
    : `imessage:self-hosted:${secret.serverUrl ?? ""}:${secret.phone ?? ""}`;
};

export const assertChannelIdentityAvailable = (
  ctx: ChannelRuntimeContext,
  botId: BotId,
  candidateSecret: StoredChannelSecret,
) =>
  Effect.gen(function* () {
    const model = yield* ctx.deps.readModel;
    for (const bot of model.bots) {
      if (bot.id === botId || bot.archivedAt !== null) continue;
      for (const binding of bot.channelBindings ?? []) {
        if (
          binding.provider !== candidateSecret.provider ||
          (binding.status === "disconnected" && !binding.connectionId)
        ) {
          continue;
        }
        const secret = yield* (
          binding.connectionId
            ? loadConnectionSecret(ctx, binding.connectionId)
            : loadSecret(ctx, bot.id, binding.provider)
        ).pipe(Effect.orElseSucceed(() => null));
        if (secret && channelSecretIdentity(secret) === channelSecretIdentity(candidateSecret)) {
          return yield* failWith("This channel connection is already connected to another bot.");
        }
      }
    }
  });
