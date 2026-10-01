import * as Schema from "effect/Schema";
import type { AkeruComputerBoundary } from "./inputs.ts";

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
  "ReactToMessage",
  "InstallPlugin",
  "UninstallPlugin",
  "GetMcpServerStatus",
  "TestMcpServer",
  "ReconnectMcpServer",
  "UpdateBotProfile",
  "AuthenticateMcpServer",
  "RestartMcpServers",
  "WebSearch",
  "WebFetch",
  "GenerateImage",
  "AddMcpServer",
  "UninstallMcpServer",
  "RemoveMcpAccount",
  "RenameMcpAccount",
  "SetMcpInstructions",
  "Task",
  "CheckSubagent",
  "MessageSubagent",
  "StopSubagent",
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
  define(
    "CheckAgent",
    "bot-workspace",
    "Inspect a durable named bot and its delegated work. A finished result returned here counts as delivered and is not repeated in your next turn.",
  ),
  define(
    "MessageAgent",
    "bot-workspace",
    "Send bounded work to a durable named bot. Returns a handle at once; the result arrives in your next turn.",
    {
      approval: "send",
    },
  ),
  define("StopAgent", "bot-workspace", "Cancel a durable bot's delegated work.", {
    approval: "delete",
  }),
  define(
    "SendToAgent",
    "bot-workspace",
    "Delegate a task to another bot. Returns a handle at once; the result arrives in your next turn.",
    {
      approval: "send",
    },
  ),
  define("CreateChannel", "bot-workspace", "Create a bot channel."),
  define("UpdateChannel", "bot-workspace", "Rename a bot channel."),
  define("SendToUser", "bot-workspace", "Send a message into the current Akeru thread.", {
    approval: "send",
  }),
  define(
    "SearchPlugins",
    "bot-workspace",
    "Search available plugins and connected integration providers when the user needs a capability that is not installed.",
  ),
  define(
    "GetPlugin",
    "bot-workspace",
    "Inspect a plugin, its connection, permissions, health, and dependents.",
  ),
  define(
    "ReactToMessage",
    "bot-workspace",
    "Add or remove an emoji reaction on a visible message.",
    { approval: "send" },
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
  define("WebSearch", "bot-workspace", "Search the public web."),
  define("WebFetch", "bot-workspace", "Fetch and extract a public URL."),
  define(
    "GenerateImage",
    "bot-workspace",
    "Generate a new image, or edit images from this chat, with the image provider the user configured. " +
      'Use operation "generate" with a prompt, or operation "edit" with a prompt and optional inputImages ' +
      "(attachment ids from this chat; defaults to the images on the latest user message). " +
      "Finished images appear in the chat automatically; do not repeat or describe the file data. " +
      'If the result status is "needs-consent", ask the user before retrying with allowProvider.',
    { approval: "production" },
  ),
  define("AddMcpServer", "bot-workspace", "Add an MCP server account.", { approval: "secrets" }),
  define("UninstallMcpServer", "bot-workspace", "Remove an MCP server.", { approval: "delete" }),
  define("RemoveMcpAccount", "bot-workspace", "Remove an MCP account.", { approval: "delete" }),
  define("RenameMcpAccount", "bot-workspace", "Rename an MCP account.", { approval: "secrets" }),
  define("SetMcpInstructions", "bot-workspace", "Set MCP account instructions.", {
    approval: "secrets",
  }),
  define(
    "Task",
    "bot-workspace",
    "Start a temporary worker for a bounded subtask. The worker is a copy of this bot with the same tools and no memory writes, runs in a hidden chat, and ends with this turn. Waits for the result unless background is true. Workers cannot start workers, and one turn can run at most 3 at once.",
  ),
  define(
    "CheckSubagent",
    "bot-workspace",
    "Report a temporary worker's status: Running, Completed with its result, Failed, or Canceled. Set wait to block until it finishes.",
  ),
  define(
    "MessageSubagent",
    "bot-workspace",
    "Send a follow-up instruction to a running temporary worker.",
  ),
  define("StopSubagent", "bot-workspace", "Cancel a temporary worker. It ends as Canceled."),
] satisfies ReadonlyArray<AkeruToolDefinition>;
