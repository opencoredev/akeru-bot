import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";
import {
  BotId,
  GroupId,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  TrimmedNonEmptyString,
} from "../baseSchemas.ts";
import { AkeruMemoryTargetScope } from "../akeruMemory/base.ts";
import {
  AkeruWorkerCheckInput,
  AkeruWorkerMessageInput,
  AkeruWorkerStopInput,
  AkeruWorkerTaskInput,
} from "../akeruWorkers.ts";
import { McpServerId, McpServerInstructions, McpServerUrl } from "../mcpServer.ts";
import { ImageGenerationRequest } from "../imageGeneration.ts";
import { BotSandbox } from "../orchestration/roster.ts";
import { RuntimeMode } from "../orchestration/modelSelection.ts";
import { AkeruToolId, AkeruToolApprovalClass } from "./catalog.ts";

export const AKERU_COMMAND_MAX_CHARS = 32_000;

export const AKERU_PATH_MAX_CHARS = 512;

export const AkeruAwaitHandleId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruAwaitHandleId"));

export type AkeruAwaitHandleId = typeof AkeruAwaitHandleId.Type;

export const AkeruPluginRecommendation = Schema.Struct({
  id: TrimmedNonEmptyString,
  source: Schema.Literals(["directory", "composio"]),
  name: TrimmedNonEmptyString,
  description: Schema.String,
  category: Schema.optional(TrimmedNonEmptyString),
  logoUrl: Schema.optional(TrimmedNonEmptyString),
  action: Schema.Literals(["open", "install", "connect", "unavailable"]),
});

export type AkeruPluginRecommendation = typeof AkeruPluginRecommendation.Type;

export const AkeruPluginSearchResult = Schema.Struct({
  kind: Schema.Literal("plugin-search-results"),
  query: Schema.String,
  total: NonNegativeInt,
  sources: Schema.Struct({
    directory: Schema.Literal("available"),
    composio: Schema.Literals(["available", "setup-required", "unavailable"]),
  }),
  recommendations: Schema.Array(AkeruPluginRecommendation),
});

export type AkeruPluginSearchResult = typeof AkeruPluginSearchResult.Type;

export const AkeruComputerBoundary = Schema.Literals(["bot-workspace", "user-computer"]);

export type AkeruComputerBoundary = typeof AkeruComputerBoundary.Type;

const CommandText = TrimmedNonEmptyString.check(Schema.isMaxLength(AKERU_COMMAND_MAX_CHARS));

const PathText = TrimmedNonEmptyString.check(Schema.isMaxLength(AKERU_PATH_MAX_CHARS));

const CommandInput = Schema.Struct({
  command: CommandText,
  cwd: Schema.optional(PathText),
  background: Schema.optional(Schema.Boolean),
});

const PathInput = Schema.Struct({ path: PathText });

const CopyInput = Schema.Struct({ sourcePath: PathText, destinationPath: PathText });

const McpServerIdInput = Schema.Struct({ serverId: TrimmedNonEmptyString });

const WebSearchInput = Schema.Struct({
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(2_000)),
  domains: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
});

const WebFetchInput = Schema.Struct({
  url: Schema.String.check(Schema.isPattern(/^https?:\/\//i)),
});

const AddMcpServerInput = Schema.Union([
  Schema.Struct({
    serverId: McpServerId,
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("stdio"),
    command: TrimmedNonEmptyString,
    args: Schema.optional(Schema.Array(Schema.String)),
  }),
  Schema.Struct({
    serverId: McpServerId,
    name: TrimmedNonEmptyString,
    transport: Schema.Literal("url"),
    url: McpServerUrl,
  }),
]);

const RenameMcpAccountInput = Schema.Struct({
  serverId: McpServerId,
  name: TrimmedNonEmptyString,
});

const UpdateBotProfileInput = Schema.Struct({
  name: Schema.optional(TrimmedNonEmptyString),
  title: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
}).check(
  Schema.makeFilter(
    (input) =>
      input.name !== undefined ||
      input.title !== undefined ||
      input.label !== undefined ||
      input.description !== undefined ||
      new SchemaIssue.InvalidValue({ message: "At least one profile field is required." }),
    { identifier: "UpdateBotProfileInput" },
  ),
);

/**
 * Maximum characters of parent context a bot may hand to a child. Longer
 * input is rejected, never truncated, so the child never works from a silently
 * clipped brief.
 */
export const AKERU_DELEGATION_CONTEXT_MAX_CHARS = 8_000;

const AgentMessageInput = Schema.Struct({
  botId: BotId,
  task: TrimmedNonEmptyString,
  expectedResult: TrimmedNonEmptyString,
  context: Schema.optional(
    Schema.String.check(
      Schema.isMaxLength(AKERU_DELEGATION_CONTEXT_MAX_CHARS, {
        message: `Delegation context must be at most ${AKERU_DELEGATION_CONTEXT_MAX_CHARS} characters.`,
      }),
    ),
  ),
  deadline: Schema.optional(IsoDateTime),
  allowedToolIds: Schema.optional(Schema.Array(AkeruToolId)),
  memoryScopes: Schema.optional(Schema.Array(AkeruMemoryTargetScope)),
  mcpServerIds: Schema.optional(Schema.Array(McpServerId)),
  sandbox: Schema.optional(
    Schema.NullOr(Schema.suspend((): Schema.Codec<BotSandbox> => BotSandbox)),
  ),
  runtimeMode: Schema.optional(Schema.suspend((): Schema.Codec<RuntimeMode> => RuntimeMode)),
  approvalCeiling: Schema.optional(AkeruToolApprovalClass),
});

export const AkeruToolInputSchemas = {
  Shell: CommandInput,
  Read: PathInput,
  Screenshot: Schema.Struct({ displayId: Schema.optional(TrimmedNonEmptyString) }),
  CopyToBox: CopyInput,
  CopyFromBox: CopyInput,
  request_box_help: Schema.Struct({
    reason: Schema.Literals(["login", "2fa", "captcha", "payment", "other"]),
    message: TrimmedNonEmptyString,
  }),
  ExternalShell: CommandInput,
  ExternalRead: PathInput,
  AwaitShell: Schema.Struct({ handleId: AkeruAwaitHandleId }),
  AwaitExternalShell: Schema.Struct({ handleId: AkeruAwaitHandleId }),
  CreateAgent: Schema.Struct({
    name: TrimmedNonEmptyString,
    title: Schema.optional(TrimmedNonEmptyString),
    description: Schema.optional(TrimmedNonEmptyString),
  }),
  CheckAgent: Schema.Struct({ botId: BotId }),
  MessageAgent: AgentMessageInput,
  StopAgent: Schema.Struct({ botId: BotId }),
  SendToAgent: Schema.Struct({
    ...AgentMessageInput.fields,
    /** Keep the work running after the parent turn ends instead of stopping it. */
    keep: Schema.optional(Schema.Boolean),
  }),
  CreateChannel: Schema.Struct({
    name: TrimmedNonEmptyString,
    specialistBotIds: Schema.optional(Schema.Array(BotId)),
  }),
  UpdateChannel: Schema.Struct({
    channelId: GroupId,
    name: TrimmedNonEmptyString,
  }),
  SendToUser: Schema.Struct({
    message: TrimmedNonEmptyString.check(Schema.isMaxLength(AKERU_COMMAND_MAX_CHARS)),
  }),
  SearchPlugins: Schema.Struct({
    query: Schema.optional(TrimmedNonEmptyString),
    limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(50))),
  }),
  GetPlugin: Schema.Struct({ pluginId: TrimmedNonEmptyString }),
  ReactToMessage: Schema.Struct({
    messageId: MessageId,
    emoji: TrimmedNonEmptyString.check(Schema.isMaxLength(32)),
    action: Schema.Literals(["add", "remove"]),
  }),
  InstallPlugin: Schema.Struct({ pluginId: TrimmedNonEmptyString }),
  UninstallPlugin: Schema.Struct({ pluginId: TrimmedNonEmptyString }),
  GetMcpServerStatus: McpServerIdInput,
  TestMcpServer: McpServerIdInput,
  ReconnectMcpServer: McpServerIdInput,
  UpdateBotProfile: UpdateBotProfileInput,
  AuthenticateMcpServer: McpServerIdInput,
  RestartMcpServers: Schema.Struct({
    serverIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  }),
  WebSearch: WebSearchInput,
  WebFetch: WebFetchInput,
  GenerateImage: ImageGenerationRequest,
  AddMcpServer: AddMcpServerInput,
  UninstallMcpServer: Schema.Struct({ serverId: McpServerId }),
  RemoveMcpAccount: Schema.Struct({ serverId: McpServerId }),
  RenameMcpAccount: RenameMcpAccountInput,
  SetMcpInstructions: Schema.Struct({ serverId: McpServerId, instructions: McpServerInstructions }),
  Task: AkeruWorkerTaskInput,
  CheckSubagent: AkeruWorkerCheckInput,
  MessageSubagent: AkeruWorkerMessageInput,
  StopSubagent: AkeruWorkerStopInput,
} as const satisfies Record<AkeruToolId, Schema.Top>;

export const AkeruMessageReactionResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("applied"),
    messageId: MessageId,
    emoji: TrimmedNonEmptyString,
    action: Schema.Literals(["add", "remove"]),
    changed: Schema.Boolean,
  }),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    messageId: MessageId,
    reason: Schema.Literal("channel-does-not-support-reactions"),
  }),
]);

export type AkeruMessageReactionResult = typeof AkeruMessageReactionResult.Type;

const AkeruToolInputDecoders = Object.fromEntries(
  Object.entries(AkeruToolInputSchemas).map(([toolId, schema]) => [
    toolId,
    Schema.decodeUnknownSync(schema),
  ]),
) as Record<
  AkeruToolId,
  (input: unknown, options: { readonly onExcessProperty: "error" }) => unknown
>;

export function decodeAkeruToolInput<Name extends AkeruToolId>(
  toolId: Name,
  input: unknown,
): (typeof AkeruToolInputSchemas)[Name]["Type"] {
  return AkeruToolInputDecoders[toolId](input, {
    onExcessProperty: "error",
  }) as (typeof AkeruToolInputSchemas)[Name]["Type"];
}
