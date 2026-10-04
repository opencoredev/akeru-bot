import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import { ProviderOptionSelections } from "../model.ts";
import { RepositoryIdentity, ThreadEnvMode } from "../environment.ts";
import {
  AuthSessionId,
  BotId,
  ChannelConnectionId,
  GroupId,
  IsoDateTime,
  MessageId,
  ProjectId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { McpServerId } from "../mcpServer.ts";
import { ImageProviderId } from "../imageGeneration.ts";
import { ModelSelection, RuntimeMode, DEFAULT_RUNTIME_MODE } from "./modelSelection.ts";

export const ProjectScriptIcon = Schema.Literals([
  "play",
  "test",
  "lint",
  "configure",
  "build",
  "debug",
]);

export type ProjectScriptIcon = typeof ProjectScriptIcon.Type;

export const ProjectScript = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  icon: ProjectScriptIcon,
  runOnWorktreeCreate: Schema.Boolean,
  /**
   * URL to open in the in-app browser preview when this script runs (or
   * when the user explicitly requests a preview). Optional; only honored on
   * the desktop build.
   */
  previewUrl: Schema.optional(TrimmedNonEmptyString),
  /**
   * When true, automatically open the preview panel pointed at `previewUrl`
   * the moment this script starts. Ignored without `previewUrl` or on web.
   */
  autoOpenPreview: Schema.optional(Schema.Boolean),
});

export type ProjectScript = typeof ProjectScript.Type;

export const ProjectFaviconPath = TrimmedNonEmptyString.check(
  Schema.isMaxLength(1024),
  Schema.isPattern(/\.(?:avif|gif|ico|jpe?g|png|svg|webp)$/i),
);

export type ProjectFaviconPath = typeof ProjectFaviconPath.Type;

export const OrchestrationProject = Schema.Struct({
  id: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Retired per-project override for where new threads start. Still decoded
  // from stored events and snapshots; clients start new chats in local mode.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Optional on the wire so cached snapshots from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  deletedAt: Schema.NullOr(IsoDateTime),
});

export type OrchestrationProject = typeof OrchestrationProject.Type;

export const BotAvatar = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("blob"),
    shape: Schema.Literals([
      "circle",
      "squircle",
      "square",
      "pill",
      "triangle",
      "hex",
      "cloud",
      "drop",
    ]),
    color: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("dither"),
    seed: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("image"),
    assetPath: Schema.String,
    dithered: Schema.Boolean,
  }),
]);

export type BotAvatar = typeof BotAvatar.Type;

export const BotEngine = Schema.Struct({
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  options: Schema.optionalKey(ProviderOptionSelections),
});

export type BotEngine = typeof BotEngine.Type;

export const BotSandbox = Schema.Literals([
  "local",
  "e2b",
  "daytona",
  "vercel",
  "upstash",
  "ascii",
  "railway",
  "tenki",
]);

export type BotSandbox = typeof BotSandbox.Type;

export const PersistedBotSandbox = Schema.Union([
  Schema.NullOr(BotSandbox),
  Schema.Literal("akeru-cloud"),
]).pipe(
  Schema.decodeTo(
    Schema.NullOr(BotSandbox),
    SchemaTransformation.transform({
      decode: (value) => (value === "akeru-cloud" ? null : value),
      encode: (value) => value,
    }),
  ),
);

export const BotSandboxBrowserSharing = Schema.Literals(["shared", "separate"]);

export type BotSandboxBrowserSharing = typeof BotSandboxBrowserSharing.Type;

export const DEFAULT_BOT_SANDBOX_BROWSER_SHARING: BotSandboxBrowserSharing = "separate";

export const BotUsageCap = Schema.Struct({
  unit: Schema.Literal("tokens"),
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
});

export type BotUsageCap = typeof BotUsageCap.Type;

export const MIN_BOT_PERSONALITY_TONE = 0;

export const BALANCED_BOT_PERSONALITY_TONE = 50;

export const MAX_BOT_PERSONALITY_TONE = 100;

export const BotPersonalityTone = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_BOT_PERSONALITY_TONE,
    maximum: MAX_BOT_PERSONALITY_TONE,
  }),
);

export type BotPersonalityTone = typeof BotPersonalityTone.Type;

export const CHANNEL_PROVIDERS = ["telegram", "imessage", "whatsapp", "slack", "discord"] as const;

export const ChannelProvider = Schema.Literals(CHANNEL_PROVIDERS);

export type ChannelProvider = typeof ChannelProvider.Type;

export const ChannelTransportCapabilities = Schema.Struct({
  directMessages: Schema.Boolean,
  mentions: Schema.Boolean,
  threads: Schema.Boolean,
  reactions: Schema.Boolean,
  typing: Schema.Boolean,
  messageEdits: Schema.Boolean,
  attachments: Schema.Boolean,
  interactiveActions: Schema.Boolean,
});

export type ChannelTransportCapabilities = typeof ChannelTransportCapabilities.Type;

export const CHANNEL_TRANSPORT_CAPABILITIES = {
  telegram: {
    directMessages: true,
    mentions: false,
    threads: false,
    reactions: false,
    typing: false,
    messageEdits: false,
    attachments: false,
    interactiveActions: false,
  },
  imessage: {
    directMessages: true,
    mentions: false,
    threads: false,
    reactions: false,
    typing: false,
    messageEdits: false,
    attachments: false,
    interactiveActions: false,
  },
  whatsapp: {
    directMessages: true,
    mentions: false,
    threads: false,
    reactions: false,
    typing: false,
    messageEdits: false,
    attachments: false,
    interactiveActions: false,
  },
  slack: {
    directMessages: true,
    mentions: true,
    threads: true,
    reactions: true,
    typing: false,
    messageEdits: false,
    attachments: false,
    interactiveActions: false,
  },
  discord: {
    directMessages: true,
    mentions: true,
    threads: true,
    reactions: true,
    typing: false,
    messageEdits: false,
    attachments: false,
    interactiveActions: false,
  },
} as const satisfies Record<ChannelProvider, ChannelTransportCapabilities>;

export const ChannelBindingStatus = Schema.Literals([
  "disconnected",
  "connecting",
  "connected",
  "needs-reconnect",
  "failed",
  "blocked",
  "not-live",
]);

export type ChannelBindingStatus = typeof ChannelBindingStatus.Type;

/** Why a channel binding last failed. Clients pick one repair action from status plus category. */
export const ChannelFailureCategory = Schema.Literals([
  "credentials",
  "network",
  "project",
  "delivery-unknown",
  "restore",
]);

export type ChannelFailureCategory = typeof ChannelFailureCategory.Type;

export const ChannelBinding = Schema.Struct({
  botId: BotId,
  connectionId: Schema.optional(ChannelConnectionId),
  projectId: Schema.optional(ProjectId),
  provider: ChannelProvider,
  status: ChannelBindingStatus,
  externalIdentity: Schema.NullOr(TrimmedNonEmptyString),
  connectedAt: Schema.NullOr(IsoDateTime),
  lastAttemptAt: Schema.optional(IsoDateTime),
  /** Most recent successful connect or confirmed delivery. Survives later failures. */
  lastSucceededAt: Schema.optional(IsoDateTime),
  lastError: Schema.optional(TrimmedNonEmptyString),
  /** Present only with `lastError`. */
  failureCategory: Schema.optional(ChannelFailureCategory),
  sentMessageIds: Schema.Array(MessageId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export type ChannelBinding = typeof ChannelBinding.Type;

export const OrchestrationBot = Schema.Struct({
  id: BotId,
  name: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  label: Schema.NullOr(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  description: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  disabledMcpServerIds: Schema.Array(McpServerId).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  avatar: BotAvatar,
  engine: Schema.NullOr(BotEngine),
  sandbox: PersistedBotSandbox,
  runtimeMode: RuntimeMode.pipe(Schema.withDecodingDefault(Effect.succeed(DEFAULT_RUNTIME_MODE))),
  usageCap: Schema.NullOr(BotUsageCap).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /**
   * The bot's image provider, independent of its chat engine (a Claude bot may
   * still use ChatGPT images). `null` means "use the global default" and is
   * also the decode default so bots written before this field decode cleanly.
   */
  imageProvider: Schema.NullOr(ImageProviderId).pipe(
    Schema.withDecodingDefault(Effect.succeed(null)),
  ),
  personalityTone: Schema.optionalKey(BotPersonalityTone),
  voiceEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  channelBindings: Schema.Array(ChannelBinding).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  groupId: Schema.NullOr(GroupId),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type OrchestrationBot = typeof OrchestrationBot.Type;

export const GroupMembershipRole = Schema.Literals(["boss", "specialist"]);

export type GroupMembershipRole = typeof GroupMembershipRole.Type;

export const GroupBotMembership = Schema.Struct({
  kind: Schema.Literal("bot").pipe(Schema.withDecodingDefault(Effect.succeed("bot" as const))),
  botId: BotId,
  role: GroupMembershipRole,
});

export type GroupBotMembership = typeof GroupBotMembership.Type;

export const GroupPersonMembership = Schema.Struct({
  kind: Schema.Literal("person"),
  personId: AuthSessionId,
  displayName: TrimmedNonEmptyString,
});

export type GroupPersonMembership = typeof GroupPersonMembership.Type;

export const GroupMembership = Schema.Union([GroupBotMembership, GroupPersonMembership]);

export type GroupMembership = typeof GroupMembership.Type;

export function isGroupBotMember(member: GroupMembership): member is GroupBotMembership {
  return member.kind === "bot";
}

export function isGroupPersonMember(member: GroupMembership): member is GroupPersonMembership {
  return member.kind === "person";
}

export const GROUP_SHARED_WORKSPACE_WARNING =
  "Bots share this workspace. Anyone who can talk to a bot can reach anything the workspace can.";

export const OrchestrationGroup = Schema.Struct({
  id: GroupId,
  name: TrimmedNonEmptyString,
  bossBotId: Schema.NullOr(BotId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  members: Schema.Array(GroupMembership).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});

export type OrchestrationGroup = typeof OrchestrationGroup.Type;

/** Days an archived bot is kept before the server deletes it. Its chats stay in history. */
export const ARCHIVED_BOT_RETENTION_DAYS = 7;

/** When the server deletes a bot archived at `archivedAt`, in epoch milliseconds. */
export const archivedBotDeletesAtMs = (archivedAt: string): number =>
  Date.parse(archivedAt) + ARCHIVED_BOT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
