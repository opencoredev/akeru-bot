// @effect-diagnostics globalFetch:off nodeBuiltinImport:off
import { createWorkspaceTools, type Workspace } from "@mastra/core/workspace";
import { type AkeruToolId } from "@akeru/contracts";
import { type AkeruToolSession } from "./AkeruToolTypes.ts";

export const BACKEND_NAMES: Record<
  Exclude<
    AkeruToolId,
    | "CopyToBox"
    | "CopyFromBox"
    | "request_box_help"
    | "CreateAgent"
    | "CheckAgent"
    | "MessageAgent"
    | "StopAgent"
    | "SendToAgent"
    | "Task"
    | "CheckSubagent"
    | "MessageSubagent"
    | "StopSubagent"
    | "CreateChannel"
    | "UpdateChannel"
    | "SendToUser"
    | "UpdateBotProfile"
    | "SearchPlugins"
    | "GetPlugin"
    | "ReactToMessage"
    | "InstallPlugin"
    | "UninstallPlugin"
    | "GetMcpServerStatus"
    | "TestMcpServer"
    | "ReconnectMcpServer"
    | "AuthenticateMcpServer"
    | "RestartMcpServers"
    | "WebSearch"
    | "WebFetch"
    | "GenerateImage"
    | "generate_image"
    | "AddMcpServer"
    | "UninstallMcpServer"
    | "RemoveMcpAccount"
    | "RenameMcpAccount"
    | "SetMcpInstructions"
  >,
  ReadonlyArray<string>
> = {
  Shell: ["execute_command", "mastra_workspace_execute_command"],
  Read: ["view", "mastra_workspace_read_file"],
  Screenshot: ["mastra_workspace_computer_screenshot"],
  ExternalShell: ["execute_command", "mastra_workspace_execute_command"],
  ExternalRead: ["view", "mastra_workspace_read_file"],
  AwaitShell: ["get_process_output", "mastra_workspace_get_process_output"],
  AwaitExternalShell: ["get_process_output", "mastra_workspace_get_process_output"],
};

export function workspaceForTool(toolId: AkeruToolId, session: AkeruToolSession) {
  return toolId === "ExternalShell" || toolId === "ExternalRead" || toolId === "AwaitExternalShell"
    ? session.userComputerWorkspace
    : session.workspace;
}

export async function toolsForWorkspace(workspace: Workspace | undefined) {
  if (!workspace) return {};
  return createWorkspaceTools(workspace, {
    requestContext: {},
    workspace,
  });
}

export function executable(value: unknown): value is {
  readonly execute: (input: unknown, context: Record<string, unknown>) => Promise<unknown>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}
