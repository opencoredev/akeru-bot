import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  BotId,
  GroupId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AkeruMemoryTargetScope } from "./akeruMemory.ts";
import { AKERU_DELEGATION_MAX_CONCURRENCY, AKERU_DELEGATION_MAX_DEPTH } from "./akeruDelegation.ts";
import { McpServerId } from "./mcpServer.ts";
import { BotSandbox, RuntimeMode } from "./orchestration.ts";

export const AKERU_COMMAND_MAX_CHARS = 32_000;
export const AKERU_PATH_MAX_CHARS = 512;

export const AkeruAwaitHandleId = TrimmedNonEmptyString.pipe(Schema.brand("AkeruAwaitHandleId"));
export type AkeruAwaitHandleId = typeof AkeruAwaitHandleId.Type;

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

export const AkeruToolId = Schema.Literals([
  "Shell",
  "Read",
  "Screenshot",
  "CopyToBox",
  "CopyFromBox",
  "request_box_help",
  "ExternalShell",
  "ExternalRead",
  "AwaitShell",
  "AwaitExternalShell",
  "CreateAgent",
  "CheckAgent",
  "MessageAgent",
  "StopAgent",
  "SendToAgent",
  "CreateChannel",
  "UpdateChannel",
  "SendToUser",
  "SearchPlugins",
  "GetPlugin",
  "InstallPlugin",
  "UninstallPlugin",
  "GetMcpServerStatus",
  "TestMcpServer",
  "ReconnectMcpServer",
  "UpdateBotProfile",
  "AuthenticateMcpServer",
  "RestartMcpServers",
]);
export type AkeruToolId = typeof AkeruToolId.Type;

export const AkeruToolApprovalClass = Schema.Literals([
  "none",
  "user-computer",
  "send",
  "pay",
  "delete",
  "production",
  "secrets",
]);
export type AkeruToolApprovalClass = typeof AkeruToolApprovalClass.Type;

const AgentMessageInput = Schema.Struct({
  botId: BotId,
  task: TrimmedNonEmptyString,
  expectedResult: TrimmedNonEmptyString,
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
  SendToAgent: AgentMessageInput,
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
} as const satisfies Record<AkeruToolId, Schema.Top>;

const AkeruToolInputDecoders = Object.fromEntries(
  Object.entries(AkeruToolInputSchemas).map(([toolId, schema]) => [
    toolId,
    Schema.decodeUnknownSync(schema),
  ]),
) as Record<
  AkeruToolId,
  (input: unknown, options: { readonly onExcessProperty: "error" }) => unknown
>;

export const AkeruProtectedApprovalClass = Schema.Literals([
  "send",
  "pay",
  "delete",
  "production",
  "secrets",
]);
export type AkeruProtectedApprovalClass = typeof AkeruProtectedApprovalClass.Type;
export const AKERU_PROTECTED_APPROVAL_CLASSES: ReadonlySet<AkeruProtectedApprovalClass> = new Set([
  "send",
  "pay",
  "delete",
  "production",
  "secrets",
]);

export const AkeruToolCapability = Schema.Literals(["bot-workspace", "user-computer"]);
export type AkeruToolCapability = typeof AkeruToolCapability.Type;
export const AkeruToolWorkspaceType = Schema.Literals(["none", "local", "cloud"]);
export type AkeruToolWorkspaceType = typeof AkeruToolWorkspaceType.Type;
export type AkeruToolWorkspaceRequirement = "none" | "bot-workspace" | "user-computer";
export interface AkeruCopyDirection {
  readonly from: AkeruComputerBoundary;
  readonly to: AkeruComputerBoundary;
}

export interface AkeruToolDefinition {
  readonly id: AkeruToolId;
  readonly description: string;
  readonly capability: AkeruToolCapability;
  readonly workspace: AkeruToolWorkspaceRequirement;
  readonly approval: AkeruToolApprovalClass;
  readonly requiresUserComputer?: boolean;
  readonly copy?: AkeruCopyDirection;
}

const define = (
  id: AkeruToolId,
  capability: AkeruToolCapability,
  description: string,
  options: Partial<
    Pick<AkeruToolDefinition, "workspace" | "approval" | "requiresUserComputer" | "copy">
  > = {},
): AkeruToolDefinition => ({
  id,
  capability,
  description,
  workspace: options.workspace ?? "none",
  approval: options.approval ?? "none",
  ...(options.requiresUserComputer ? { requiresUserComputer: true } : {}),
  ...(options.copy ? { copy: options.copy } : {}),
});

export const AKERU_TOOL_CATALOG = [
  define("Shell", "bot-workspace", "Run a command in the bot workspace.", {
    workspace: "bot-workspace",
  }),
  define("Read", "bot-workspace", "Read a file in the bot workspace.", {
    workspace: "bot-workspace",
  }),
  define("Screenshot", "bot-workspace", "Capture the bot workspace desktop.", {
    workspace: "bot-workspace",
  }),
  define(
    "CopyToBox",
    "bot-workspace",
    "Copy a file from the user computer into the bot workspace.",
    {
      workspace: "bot-workspace",
      approval: "user-computer",
      requiresUserComputer: true,
      copy: { from: "user-computer", to: "bot-workspace" },
    },
  ),
  define(
    "CopyFromBox",
    "bot-workspace",
    "Copy a file from the bot workspace to the user computer.",
    {
      workspace: "bot-workspace",
      approval: "user-computer",
      requiresUserComputer: true,
      copy: { from: "bot-workspace", to: "user-computer" },
    },
  ),
  define("request_box_help", "bot-workspace", "Ask the user to complete a human-only step.", {
    workspace: "bot-workspace",
  }),
  define("ExternalShell", "user-computer", "Run a command on the user computer.", {
    workspace: "user-computer",
    approval: "user-computer",
    requiresUserComputer: true,
  }),
  define("ExternalRead", "user-computer", "Read an allowed file from the user computer.", {
    workspace: "user-computer",
    approval: "user-computer",
    requiresUserComputer: true,
  }),
  define("AwaitShell", "bot-workspace", "Await a bot workspace command.", {
    workspace: "bot-workspace",
  }),
  define("AwaitExternalShell", "user-computer", "Await a user computer command.", {
    workspace: "user-computer",
    requiresUserComputer: true,
  }),
  define("CreateAgent", "bot-workspace", "Create a durable named bot."),
  define("CheckAgent", "bot-workspace", "Inspect a durable named bot and its delegated work."),
  define("MessageAgent", "bot-workspace", "Send bounded work to a durable named bot.", {
    approval: "send",
  }),
  define("StopAgent", "bot-workspace", "Cancel a durable bot's delegated work.", {
    approval: "delete",
  }),
  define("SendToAgent", "bot-workspace", "Delegate a task to another bot.", {
    approval: "send",
  }),
  define("CreateChannel", "bot-workspace", "Create a bot channel."),
  define("UpdateChannel", "bot-workspace", "Rename a bot channel."),
  define("SendToUser", "bot-workspace", "Send a message into the current Akeru thread.", {
    approval: "send",
  }),
  define("SearchPlugins", "bot-workspace", "Search the curated plugin directory."),
  define(
    "GetPlugin",
    "bot-workspace",
    "Inspect a plugin, its connection, permissions, health, and dependents.",
  ),
  define("InstallPlugin", "bot-workspace", "Install a curated plugin after inspecting it.", {
    approval: "production",
  }),
  define("UninstallPlugin", "bot-workspace", "Remove a curated plugin after inspecting it.", {
    approval: "delete",
  }),
  define("GetMcpServerStatus", "bot-workspace", "Inspect an MCP server connection."),
  define("TestMcpServer", "bot-workspace", "Run a real MCP server connection test.", {
    approval: "production",
  }),
  define("ReconnectMcpServer", "bot-workspace", "Reconnect one MCP server.", {
    approval: "production",
  }),
  define("UpdateBotProfile", "bot-workspace", "Update this bot's public profile."),
  define("AuthenticateMcpServer", "bot-workspace", "Authenticate an MCP server.", {
    approval: "secrets",
  }),
  define("RestartMcpServers", "bot-workspace", "Restart MCP servers.", {
    approval: "production",
  }),
] satisfies ReadonlyArray<AkeruToolDefinition>;

export interface AkeruToolAvailabilityContext {
  readonly capabilities: ReadonlySet<AkeruToolCapability>;
  readonly workspaceType: AkeruToolWorkspaceType;
  readonly hasUserComputer: boolean;
  readonly localFullAccess: boolean;
  readonly implementedTools: ReadonlySet<string>;
  readonly delegationDepth?: number;
  readonly activeDelegations?: number;
}

export function filterAkeruTools(
  context: AkeruToolAvailabilityContext,
): ReadonlyArray<AkeruToolDefinition> {
  return AKERU_TOOL_CATALOG.filter((tool) => {
    if (!context.capabilities.has(tool.capability)) return false;
    if (!context.implementedTools.has(tool.id)) return false;
    if (
      (tool.id === "SendToAgent" || tool.id === "MessageAgent") &&
      ((context.delegationDepth ?? 0) >= AKERU_DELEGATION_MAX_DEPTH ||
        (context.activeDelegations ?? 0) >= AKERU_DELEGATION_MAX_CONCURRENCY)
    )
      return false;
    if (tool.workspace === "bot-workspace" && context.workspaceType === "none") return false;
    if (tool.workspace === "user-computer" && !context.hasUserComputer) return false;
    return !(tool.requiresUserComputer && !context.hasUserComputer);
  });
}

export function classifyAkeruSensitivePath(path: string): AkeruProtectedApprovalClass | undefined {
  return /(^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.config[/\\]gh|keychain|credentials?|secrets?|tokens?)(?:[/\\]|$)/i.test(
    path,
  )
    ? "secrets"
    : undefined;
}

export function classifyAkeruExternalCommand(
  command: string,
): AkeruProtectedApprovalClass | undefined {
  if (/\b(stripe|checkout|payment|purchase|buy)\b/i.test(command)) return "pay";
  if (/\b(rm|rmdir|unlink|trash|delete|drop|destroy|wipe)\b/i.test(command)) return "delete";
  if (/\b(secret|credential|token|password|keychain|\.env)\b/i.test(command)) return "secrets";
  if (
    /\b(deploy|release|publish|production|kubectl|terraform\s+apply|git\s+push|gh\s+pr\s+(?:create|merge))\b/i.test(
      command,
    )
  )
    return "production";
  if (
    /\b(send|post|comment|message|mail|curl\b[^\n]*(?:-X\s*POST|--request\s+POST|-d\b|--data(?:-raw|-binary|-urlencode)?\b))\b/i.test(
      command,
    )
  )
    return "send";
  return undefined;
}

export function akeruToolApprovalForInput(
  tool: AkeruToolDefinition,
  input: unknown,
  context?: { readonly workspaceType?: AkeruToolWorkspaceType },
): AkeruToolApprovalClass {
  if (typeof input !== "object" || input === null) return tool.approval;
  if (
    (tool.id === "Shell" || tool.id === "ExternalShell") &&
    "command" in input &&
    typeof input.command === "string"
  ) {
    const protectedClass = classifyAkeruExternalCommand(input.command);
    if (protectedClass) return protectedClass;
  }
  if (tool.id === "ExternalRead" && "path" in input && typeof input.path === "string") {
    return classifyAkeruSensitivePath(input.path) ?? tool.approval;
  }
  if (tool.id === "CopyToBox" && "sourcePath" in input && typeof input.sourcePath === "string") {
    return classifyAkeruSensitivePath(input.sourcePath) ?? tool.approval;
  }
  if (tool.id === "CopyFromBox" && "sourcePath" in input && typeof input.sourcePath === "string") {
    return classifyAkeruSensitivePath(input.sourcePath) ?? tool.approval;
  }
  if (tool.id === "Shell" && context?.workspaceType === "local") return "user-computer";
  return tool.approval;
}

export function akeruToolRequiresApproval(
  tool: AkeruToolDefinition,
  context: Pick<AkeruToolAvailabilityContext, "localFullAccess"> & {
    readonly workspaceType?: AkeruToolWorkspaceType;
  },
  input?: unknown,
): boolean {
  const approval = akeruToolApprovalForInput(tool, input, context);
  if (tool.id === "Shell" && context.workspaceType === "local") return true;
  if (AKERU_PROTECTED_APPROVAL_CLASSES.has(approval as AkeruProtectedApprovalClass)) return true;
  return approval === "user-computer" && !(context.localFullAccess && input !== undefined);
}

export function copyDirectionForTool(toolId: AkeruToolId): AkeruCopyDirection | undefined {
  return AKERU_TOOL_CATALOG.find((tool) => tool.id === toolId)?.copy;
}

export function decodeAkeruToolInput<Name extends AkeruToolId>(
  toolId: Name,
  input: unknown,
): (typeof AkeruToolInputSchemas)[Name]["Type"] {
  return AkeruToolInputDecoders[toolId](input, {
    onExcessProperty: "error",
  }) as (typeof AkeruToolInputSchemas)[Name]["Type"];
}

export const AkeruToolReceiptPhase = Schema.Literals([
  "start",
  "progress",
  "approval",
  "success",
  "failure",
  "cancellation",
]);
export const AkeruToolFailureCode = Schema.Literals([
  "validation",
  "denied",
  "not_found",
  "timeout",
  "cancelled",
  "internal",
]);
export const AkeruToolReceipt = Schema.Struct({
  receiptId: TrimmedNonEmptyString,
  toolId: TrimmedNonEmptyString,
  phase: AkeruToolReceiptPhase,
  threadId: ThreadId,
  botId: Schema.optional(BotId),
  handleId: Schema.optional(AkeruAwaitHandleId),
  summary: Schema.optional(TrimmedNonEmptyString),
  progress: Schema.optional(NonNegativeInt),
  approvalClass: Schema.optional(AkeruToolApprovalClass),
  failureCode: Schema.optional(AkeruToolFailureCode),
  fatalToThread: Schema.Literal(false).pipe(
    Schema.withDecodingDefault(Effect.succeed(false as const)),
  ),
  billedBotId: Schema.optional(BotId),
  usage: Schema.optional(
    Schema.Struct({
      inputTokens: Schema.optional(NonNegativeInt),
      outputTokens: Schema.optional(NonNegativeInt),
      costUsd: Schema.optional(Schema.Number),
    }),
  ),
  createdAt: IsoDateTime,
});
export type AkeruToolReceipt = typeof AkeruToolReceipt.Type;
