/**
 * Risk classes for bot actions. A protected action the classifier recognizes
 * (delete, send, pay, production, secrets, publish, sign, refund, account) is
 * always `write-outside`, whatever tool runs it and wherever it runs.
 */
import {
  akeruToolApprovalForInput,
  type AkeruToolDefinition,
  type AkeruToolId,
  type AkeruToolWorkspaceType,
  type BotActionRiskClass,
} from "@akeru/contracts";

import { criticalAkeruAction, textTokens } from "./akeruActions.ts";

/**
 * The base risk class of every catalog tool. The Record type makes a new tool id
 * fail to compile until it gets a class, so no tool falls through to a default.
 * A recognized protected action or a protected approval class for the input
 * raises a call above its base class.
 */
export const AKERU_TOOL_BASE_RISK_CLASSES = {
  Shell: "write-workspace",
  Read: "read",
  Screenshot: "read",
  CopyToBox: "environment-access",
  CopyFromBox: "environment-access",
  request_box_help: "write-workspace",
  ExternalShell: "environment-access",
  ExternalRead: "environment-access",
  AwaitShell: "read",
  // Reads command output from the user's computer.
  AwaitExternalShell: "environment-access",
  CreateAgent: "write-workspace",
  CheckAgent: "read",
  MessageAgent: "write-outside",
  StopAgent: "write-outside",
  SendToAgent: "write-outside",
  CreateChannel: "write-workspace",
  UpdateChannel: "write-workspace",
  SendToUser: "write-outside",
  SearchPlugins: "read",
  GetPlugin: "read",
  ReactToMessage: "write-outside",
  InstallPlugin: "write-outside",
  UninstallPlugin: "write-outside",
  GetMcpServerStatus: "read",
  TestMcpServer: "write-outside",
  ReconnectMcpServer: "write-outside",
  UpdateBotProfile: "write-workspace",
  AuthenticateMcpServer: "write-outside",
  RestartMcpServers: "write-outside",
  WebSearch: "read",
  WebFetch: "read",
  GenerateImage: "write-outside",
  AddMcpServer: "write-outside",
  UninstallMcpServer: "write-outside",
  RemoveMcpAccount: "write-outside",
  RenameMcpAccount: "write-outside",
  SetMcpInstructions: "write-outside",
  Task: "write-workspace",
  CheckSubagent: "read",
  MessageSubagent: "write-workspace",
  StopSubagent: "write-workspace",
  list_environments: "read",
} as const satisfies Record<AkeruToolId, BotActionRiskClass>;

const READ_ONLY_NAME_TOKENS = new Set(["get", "list", "read", "search", "status", "view"]);

/** The risk class of one built-in tool call. */
export function akeruToolRiskClassForInput<Input>(
  tool: AkeruToolDefinition,
  input: Input,
  context?: { readonly workspaceType?: AkeruToolWorkspaceType },
): BotActionRiskClass {
  if (criticalAkeruAction(tool.id, input) !== null) return "write-outside";
  const approval = akeruToolApprovalForInput(tool, input, context);

  if (approval === "none") return AKERU_TOOL_BASE_RISK_CLASSES[tool.id];

  return approval === "user-computer" ? "environment-access" : "write-outside";
}

/**
 * The risk class of a named action outside the tool catalog, such as routine
 * management. Names that only read are `read`; everything else writes in the
 * environment unless the classifier recognizes a protected action.
 */
export function namedActionRiskClass<Input>(toolName: string, input: Input): BotActionRiskClass {
  if (criticalAkeruAction(toolName, input) !== null) return "write-outside";

  return [...textTokens(toolName)].some((token) => READ_ONLY_NAME_TOKENS.has(token))
    ? "read"
    : "write-workspace";
}

/** Claude Code tools that only read or plan. */
const CLAUDE_CODE_READ_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "NotebookRead",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "BashOutput",
  "ToolSearch",
  "ListMcpResourcesTool",
  "ReadMcpResourceTool",
  "AskUserQuestion",
  "ExitPlanMode",
  "Task",
  "Agent",
]);

/** Claude Code tools that change files in the bot's workspace. */
const CLAUDE_CODE_WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "KillShell",
  "KillBash",
]);

/** Akeru's own MCP server, as Claude Code names its tools. */
const AKERU_MCP_TOOL_PREFIX = "mcp__akeru__";

/**
 * Akeru MCP tools that share a catalog tool's risk. Image generation sends the prompt to the
 * image provider, so it is `write-outside` like `GenerateImage`, not a guess from its name.
 */
const AKERU_MCP_TOOL_RISK_CLASSES = new Map<string, BotActionRiskClass>([
  ["memory", "write-workspace"],
  ["generate_image", AKERU_TOOL_BASE_RISK_CLASSES.GenerateImage],
]);

/**
 * The risk class of one Claude Code tool call. Claude Code runs on the user's
 * own machine, so its shell is `environment-access`. A file tool that reaches
 * outside the bot's workspace reads the user's computer (`environment-access`)
 * or writes outside (`write-outside`); the caller resolves the path and passes
 * `reach`. Tools from MCP servers other than Akeru's, and tools this list does
 * not know, are `write-outside`.
 */
export function claudeCodeToolRiskClass<Input>(
  toolName: string,
  input: Input,
  reach: "inside" | "outside" = "inside",
): BotActionRiskClass {
  if (criticalAkeruAction(toolName, input) !== null) return "write-outside";

  if (CLAUDE_CODE_READ_TOOL_NAMES.has(toolName)) {
    return reach === "outside" ? "environment-access" : "read";
  }

  if (CLAUDE_CODE_WORKSPACE_TOOL_NAMES.has(toolName)) {
    return reach === "outside" ? "write-outside" : "write-workspace";
  }

  if (toolName === "Bash") return "environment-access";

  if (toolName.startsWith(AKERU_MCP_TOOL_PREFIX)) {
    const akeruToolName = toolName.slice(AKERU_MCP_TOOL_PREFIX.length);

    return (
      AKERU_MCP_TOOL_RISK_CLASSES.get(akeruToolName) ?? namedActionRiskClass(akeruToolName, input)
    );
  }

  return "write-outside";
}
