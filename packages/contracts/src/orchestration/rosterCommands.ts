import * as Schema from "effect/Schema";
import { ThreadEnvMode } from "../environment.ts";
import {
  AuthSessionId,
  BotId,
  ChannelConnectionId,
  CommandId,
  GroupId,
  IsoDateTime,
  MessageId,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { McpServerId, McpServerInstructions, McpServerUrl } from "../mcpServer.ts";
import { ImageProviderId } from "../imageGeneration.ts";
import { ModelSelection, RuntimeMode } from "./modelSelection.ts";
import {
  ProjectScript,
  ProjectFaviconPath,
  BotAvatar,
  BotEngine,
  BotSandbox,
  BotPersonalityTone,
  ChannelProvider,
  ChannelBinding,
  GroupMembershipRole,
  GroupPersonMembership,
} from "./roster.ts";

export const ProjectCreateCommand = Schema.Struct({
  type: Schema.Literal("project.create"),
  commandId: CommandId,
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  createWorkspaceRootIfMissing: Schema.optional(Schema.Boolean),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  createdAt: IsoDateTime,
});

export const ProjectMetaUpdateCommand = Schema.Struct({
  type: Schema.Literal("project.meta.update"),
  commandId: CommandId,
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  faviconPath: Schema.optional(Schema.NullOr(ProjectFaviconPath)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
});

export const ProjectDeleteCommand = Schema.Struct({
  type: Schema.Literal("project.delete"),
  commandId: CommandId,
  projectId: ProjectId,
  force: Schema.optional(Schema.Boolean),
});

export const BotCreateCommand = Schema.Struct({
  type: Schema.Literal("bot.create"),
  commandId: CommandId,
  botId: BotId,
  name: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  disabledMcpServerIds: Schema.optional(Schema.Array(McpServerId)),
  avatar: BotAvatar,
  engine: Schema.NullOr(BotEngine),
  sandbox: Schema.NullOr(BotSandbox),
  runtimeMode: Schema.optional(RuntimeMode),
  imageProvider: Schema.optional(Schema.NullOr(ImageProviderId)),
  personalityTone: Schema.optional(BotPersonalityTone),
  voiceEnabled: Schema.optional(Schema.Boolean),
  groupId: Schema.NullOr(GroupId),
  createdAt: IsoDateTime,
});

export const BotUpdateCommand = Schema.Struct({
  type: Schema.Literal("bot.update"),
  commandId: CommandId,
  botId: BotId,
  name: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  disabledMcpServerIds: Schema.optional(Schema.Array(McpServerId)),
  avatar: Schema.optional(BotAvatar),
  engine: Schema.optional(Schema.NullOr(BotEngine)),
  sandbox: Schema.optional(Schema.NullOr(BotSandbox)),
  runtimeMode: Schema.optional(RuntimeMode),
  imageProvider: Schema.optional(Schema.NullOr(ImageProviderId)),
  personalityTone: Schema.optional(BotPersonalityTone),
  voiceEnabled: Schema.optional(Schema.Boolean),
  channelBindings: Schema.optional(Schema.Array(ChannelBinding)),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
});

export const ClientBotUpdateCommand = Schema.Struct({
  type: Schema.Literal("bot.update"),
  commandId: CommandId,
  botId: BotId,
  name: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  disabledMcpServerIds: Schema.optional(Schema.Array(McpServerId)),
  avatar: Schema.optional(BotAvatar),
  engine: Schema.optional(Schema.NullOr(BotEngine)),
  sandbox: Schema.optional(Schema.NullOr(BotSandbox)),
  runtimeMode: Schema.optional(RuntimeMode),
  imageProvider: Schema.optional(Schema.NullOr(ImageProviderId)),
  personalityTone: Schema.optional(BotPersonalityTone),
  voiceEnabled: Schema.optional(Schema.Boolean),
  groupId: Schema.optional(Schema.NullOr(GroupId)),
});

export const BotArchiveCommand = Schema.Struct({
  type: Schema.Literal("bot.archive"),
  commandId: CommandId,
  botId: BotId,
});

export const BotRestoreCommand = Schema.Struct({
  type: Schema.Literal("bot.restore"),
  commandId: CommandId,
  botId: BotId,
});

export const BotDeleteCommand = Schema.Struct({
  type: Schema.Literal("bot.delete"),
  commandId: CommandId,
  botId: BotId,
  /** Deletes only while the bot is still archived at this time, so a restore wins a race with the retention sweep. */
  archivedAt: Schema.optional(IsoDateTime),
});

export const ChannelConnectCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("channel.connect"),
    commandId: CommandId,
    botId: BotId,
    targetProjectId: ProjectId,
    provider: Schema.Literal("telegram"),
    token: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connect"),
    commandId: CommandId,
    botId: BotId,
    targetProjectId: ProjectId,
    provider: Schema.Literal("imessage"),
    mode: Schema.Literal("hosted"),
    projectId: TrimmedNonEmptyString,
    projectSecret: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connect"),
    commandId: CommandId,
    botId: BotId,
    targetProjectId: ProjectId,
    provider: Schema.Literal("imessage"),
    mode: Schema.Literal("self-hosted"),
    serverUrl: TrimmedNonEmptyString,
    apiKey: TrimmedNonEmptyString,
    phone: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connect"),
    commandId: CommandId,
    botId: BotId,
    targetProjectId: ProjectId,
    provider: Schema.Literal("whatsapp"),
    accessToken: TrimmedNonEmptyString,
    appSecret: TrimmedNonEmptyString,
    phoneNumberId: TrimmedNonEmptyString,
    verifyToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connect"),
    commandId: CommandId,
    botId: BotId,
    targetProjectId: ProjectId,
    provider: Schema.Literal("slack"),
    botToken: TrimmedNonEmptyString,
    appToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connect"),
    commandId: CommandId,
    botId: BotId,
    targetProjectId: ProjectId,
    provider: Schema.Literal("discord"),
    botToken: TrimmedNonEmptyString,
    applicationId: TrimmedNonEmptyString,
    publicKey: TrimmedNonEmptyString,
  }),
]);

export const ChannelConnectionSaveCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("channel.connection.save"),
    commandId: CommandId,
    connectionId: ChannelConnectionId,
    name: TrimmedNonEmptyString,
    provider: Schema.Literal("telegram"),
    token: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connection.save"),
    commandId: CommandId,
    connectionId: ChannelConnectionId,
    name: TrimmedNonEmptyString,
    provider: Schema.Literal("imessage"),
    mode: Schema.Literal("hosted"),
    projectId: TrimmedNonEmptyString,
    projectSecret: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connection.save"),
    commandId: CommandId,
    connectionId: ChannelConnectionId,
    name: TrimmedNonEmptyString,
    provider: Schema.Literal("imessage"),
    mode: Schema.Literal("self-hosted"),
    serverUrl: TrimmedNonEmptyString,
    apiKey: TrimmedNonEmptyString,
    phone: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connection.save"),
    commandId: CommandId,
    connectionId: ChannelConnectionId,
    name: TrimmedNonEmptyString,
    provider: Schema.Literal("whatsapp"),
    accessToken: TrimmedNonEmptyString,
    appSecret: TrimmedNonEmptyString,
    phoneNumberId: TrimmedNonEmptyString,
    verifyToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connection.save"),
    commandId: CommandId,
    connectionId: ChannelConnectionId,
    name: TrimmedNonEmptyString,
    provider: Schema.Literal("slack"),
    botToken: TrimmedNonEmptyString,
    appToken: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("channel.connection.save"),
    commandId: CommandId,
    connectionId: ChannelConnectionId,
    name: TrimmedNonEmptyString,
    provider: Schema.Literal("discord"),
    botToken: TrimmedNonEmptyString,
    applicationId: TrimmedNonEmptyString,
    publicKey: TrimmedNonEmptyString,
  }),
]);

export const ChannelConnectionDeleteCommand = Schema.Struct({
  type: Schema.Literal("channel.connection.delete"),
  commandId: CommandId,
  connectionId: ChannelConnectionId,
});

export const ChannelAttachCommand = Schema.Struct({
  type: Schema.Literal("channel.attach"),
  commandId: CommandId,
  botId: BotId,
  connectionId: ChannelConnectionId,
  // Every new attachment names its project explicitly. Legacy persisted bindings remain readable.
  projectId: ProjectId,
  provider: ChannelProvider,
});

export const ChannelDisconnectCommand = Schema.Struct({
  type: Schema.Literal("channel.disconnect"),
  commandId: CommandId,
  botId: BotId,
  provider: ChannelProvider,
});

export const ChannelDetachCommand = Schema.Struct({
  type: Schema.Literal("channel.detach"),
  commandId: CommandId,
  botId: BotId,
  provider: ChannelProvider,
  expectedConnectionId: Schema.optional(ChannelConnectionId),
});

export const ChannelReconnectCommand = Schema.Struct({
  type: Schema.Literal("channel.reconnect"),
  commandId: CommandId,
  botId: BotId,
  provider: ChannelProvider,
});

export const ChannelChangeProjectCommand = Schema.Struct({
  type: Schema.Literal("channel.change-project"),
  commandId: CommandId,
  botId: BotId,
  provider: ChannelProvider,
  projectId: ProjectId,
});

export const ChannelSendCommand = Schema.Struct({
  type: Schema.Literal("channel.send"),
  commandId: CommandId,
  botId: BotId,
  threadId: ThreadId,
  messageId: MessageId,
});

export const GroupCreateCommand = Schema.Struct({
  type: Schema.Literal("group.create"),
  commandId: CommandId,
  groupId: GroupId,
  name: TrimmedNonEmptyString,
  // Optional at the wire boundary so the decider returns the domain-specific
  // missing-boss rejection instead of a generic schema failure.
  bossBotId: Schema.optional(BotId),
  specialistBotIds: Schema.optional(Schema.Array(BotId)),
  creator: Schema.optional(GroupPersonMembership),
  createdAt: IsoDateTime,
});

export const GroupRenameCommand = Schema.Struct({
  type: Schema.Literal("group.rename"),
  commandId: CommandId,
  groupId: GroupId,
  name: TrimmedNonEmptyString,
});

export const GroupDeleteCommand = Schema.Struct({
  type: Schema.Literal("group.delete"),
  commandId: CommandId,
  groupId: GroupId,
});

export const GroupMemberAssignCommand = Schema.Struct({
  type: Schema.Literal("group.member.assign"),
  commandId: CommandId,
  groupId: GroupId,
  botId: BotId,
  role: GroupMembershipRole,
});

export const GroupMemberUnassignCommand = Schema.Struct({
  type: Schema.Literal("group.member.unassign"),
  commandId: CommandId,
  groupId: GroupId,
  botId: BotId,
});

export const GroupPersonAssignCommand = Schema.Struct({
  type: Schema.Literal("group.person.assign"),
  commandId: CommandId,
  groupId: GroupId,
  person: GroupPersonMembership,
});

export const GroupPersonUnassignCommand = Schema.Struct({
  type: Schema.Literal("group.person.unassign"),
  commandId: CommandId,
  groupId: GroupId,
  personId: AuthSessionId,
});

export const GroupLeaveCommand = Schema.Struct({
  type: Schema.Literal("group.leave"),
  commandId: CommandId,
  groupId: GroupId,
  personId: AuthSessionId,
});

export const GroupBossSetCommand = Schema.Struct({
  type: Schema.Literal("group.boss.set"),
  commandId: CommandId,
  groupId: GroupId,
  bossBotId: BotId,
  // This makes boss replacement and removal of the old boss one atomic
  // command. Without it, the old boss remains a specialist.
  unassignPreviousBoss: Schema.optional(Schema.Boolean),
});

export const McpServerCreateCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mcp-server.create"),
    commandId: CommandId,
    mcpServerId: McpServerId,
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
    enabled: Schema.optional(Schema.Boolean),
    createdAt: IsoDateTime,
  }),
  Schema.Struct({
    type: Schema.Literal("mcp-server.create"),
    commandId: CommandId,
    mcpServerId: McpServerId,
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("url"),
    url: McpServerUrl,
    enabled: Schema.optional(Schema.Boolean),
    createdAt: IsoDateTime,
  }),
]);

export const McpServerUpdateCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("mcp-server.update"),
    commandId: CommandId,
    mcpServerId: McpServerId,
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    type: Schema.Literal("mcp-server.update"),
    commandId: CommandId,
    mcpServerId: McpServerId,
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("url"),
    url: McpServerUrl,
  }),
]);

export const McpServerInstructionsSetCommand = Schema.Struct({
  type: Schema.Literal("mcp-server.instructions.set"),
  commandId: CommandId,
  mcpServerId: McpServerId,
  // An empty string clears the instructions.
  instructions: McpServerInstructions,
});

export const McpServerDeleteCommand = Schema.Struct({
  type: Schema.Literal("mcp-server.delete"),
  commandId: CommandId,
  mcpServerId: McpServerId,
});

export const McpServerEnableCommand = Schema.Struct({
  type: Schema.Literal("mcp-server.enable"),
  commandId: CommandId,
  mcpServerId: McpServerId,
});

export const McpServerDisableCommand = Schema.Struct({
  type: Schema.Literal("mcp-server.disable"),
  commandId: CommandId,
  mcpServerId: McpServerId,
});
