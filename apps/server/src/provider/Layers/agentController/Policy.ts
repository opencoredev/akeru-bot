import * as NodeCrypto from "node:crypto";

import { type McpManager } from "@mastra/code-sdk/mcp/index";
import { TOOL_NAME_OVERRIDES } from "@mastra/code-sdk/tool-names";
import type { MastraDBMessage, MastraMessagePart } from "@mastra/core/agent-controller";
import {
  CommandId,
  ProviderDriverKind,
  ProviderInstanceId,
  McpServerId,
  AKERU_TOOL_CATALOG,
  type ProviderApprovalDecision,
  type ProviderSession,
  type RuntimeMode,
  ThreadId,
} from "@akeru/contracts";
import { driverSupportsDelegation } from "@akeru/shared/delegationProviders";

import { getModelSelectionStringOptionValue } from "@akeru/shared/model";

import { getCodexServiceTierOptionValue } from "../../../codexModelOptions.ts";

import { akeruToolCategory } from "../../AkeruMastraHarness.ts";

import { type AkeruPluginRuntimeOptions } from "../../AkeruCatalogToolHandlers.ts";

import { isMemoryToolId } from "../../AkeruToolRuntime.ts";

import { isCodexComputerUseServer } from "../../CodexComputerUse.ts";
import { ProviderValidationError } from "../../Errors.ts";

import { type ResolvedEngine, type ActiveSession } from "./State.ts";

import { nowIso } from "./EventIdentity.ts";
import { mcpServerDependentBots } from "./McpConfiguration.ts";
export const DEFAULT_MODE_ID = "build";
export const BUILTIN_MASTRA_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(TOOL_NAME_OVERRIDES).map((tool) => tool.name),
);
export function omitNullToolFields(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}
export function mastraModelOptions(resolved: ResolvedEngine) {
  if (resolved.provider !== "codex") return undefined;
  const reasoningEffort = getModelSelectionStringOptionValue(
    resolved.modelSelection,
    "reasoningEffort",
  );
  const serviceTier = getCodexServiceTierOptionValue(resolved.modelSelection);
  return {
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}
export function isMissingSuspendedRun(detail: string): boolean {
  return (
    detail.includes(MISSING_SUSPENDED_RUN) || detail.includes("could not find a suspended run")
  );
}
export function failureDetail(cause: unknown): string {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return isMissingSuspendedRun(detail) ? RESUME_FAILED_MESSAGE : detail;
}
export function sessionFailureDetail(
  active: Pick<ActiveSession, "mcpServerIds">,
  cause: unknown,
): string {
  return active.mcpServerIds.some((id) => isCodexComputerUseServer(String(id)))
    ? "Computer Use session failed."
    : failureDetail(cause);
}
export async function deleteCatalogMcpServer(
  runtime: Pick<AkeruPluginRuntimeOptions, "readSnapshot" | "dispatch">,
  serverId: string,
  commandPrefix: "mcp-delete" | "mcp-remove",
) {
  const snapshot = await runtime.readSnapshot();
  const dependentBots = mcpServerDependentBots(snapshot, serverId);
  await runtime.dispatch({
    type: "mcp-server.delete",
    commandId: CommandId.make(`catalog:${commandPrefix}:${NodeCrypto.randomUUID()}`),
    mcpServerId: McpServerId.make(serverId),
  });
  const sweptBots = snapshot.bots.filter((bot) =>
    bot.disabledMcpServerIds.some((id) => String(id) === serverId),
  );
  for (const swept of sweptBots) {
    // Each bot's list is re-read so a setting saved since the first snapshot
    // survives the sweep.
    const bot = (await runtime.readSnapshot()).bots.find((entry) => entry.id === swept.id);
    if (!bot?.disabledMcpServerIds.some((id) => String(id) === serverId)) continue;
    await runtime.dispatch({
      type: "bot.update",
      commandId: CommandId.make(`catalog:mcp-sweep:${NodeCrypto.randomUUID()}`),
      botId: bot.id,
      disabledMcpServerIds: bot.disabledMcpServerIds.filter((id) => String(id) !== serverId),
    });
  }
  return {
    serverId,
    removed: true,
    dependentBots,
    clearedDisabledFor: sweptBots.map((bot) => ({ id: bot.id, name: bot.name })),
  };
}
export function messageText(message: MastraDBMessage): string {
  return message.content.parts
    .filter(
      (part): part is MastraMessagePart & { text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("");
}
export function permissionPolicy(
  runtimeMode: RuntimeMode,
  category: ReturnType<typeof akeruToolCategory>,
): "allow" | "ask" {
  if (runtimeMode === "full-access" || runtimeMode === "auto") return "allow";
  if (category === "read") return "allow";
  if (runtimeMode === "auto-accept-edits" && category === "edit") return "allow";
  return "ask";
}
export function mcpToolNeedsApproval(manager: McpManager | undefined, toolName: string): boolean {
  const tool = manager?.getTools()?.[toolName] as
    | { readonly mcp?: { readonly annotations?: { readonly readOnlyHint?: boolean } } }
    | undefined;
  if (tool) return tool.mcp?.annotations?.readOnlyHint !== true;
  // Akeru's own tools declare their risk; plain workspace tools follow the bot's mode.
  const akeruTool = AKERU_TOOL_CATALOG.find((entry) => entry.id === toolName);
  if (akeruTool) return akeruTool.approval !== "none";
  if (isMemoryToolId(toolName)) return false;
  return !BUILTIN_MASTRA_TOOL_NAMES.has(toolName);
}
export function approvalDetail(toolName: string, action: string | null, oneUse: boolean): string {
  if (!oneUse) return `Allow ${toolName}?`;
  const target = action ? `${action} action with ${toolName}` : `action with ${toolName}`;
  return `Approve this ${target}? This approval applies only to the pending action. It cannot undo completed work.`;
}
export function usesMastraCode(provider: ProviderDriverKind): boolean {
  return driverSupportsDelegation(provider);
}
export function disabledProviderError(
  operation: string,
  providerInstanceId: ProviderInstanceId,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue: `Provider instance '${providerInstanceId}' is disabled in Akeru Bot settings.`,
  });
}
export function itemType(
  toolName: string,
): "command_execution" | "file_change" | "mcp_tool_call" | "dynamic_tool_call" {
  if (/execute|command|shell|terminal/i.test(toolName)) return "command_execution";
  if (/edit|write|delete|mkdir|file/i.test(toolName)) return "file_change";
  if (/mcp/i.test(toolName)) return "mcp_tool_call";
  return "dynamic_tool_call";
}
export function ThreadIdBrand(value: string): ThreadId {
  return value as ThreadId;
}
export function approvalDecision(decision: ProviderApprovalDecision): "approve" | "decline" {
  if (decision === "decline" || decision === "cancel") return "decline";
  return "approve";
}
export function toProviderSession(threadId: ThreadId, active: ActiveSession): ProviderSession {
  return {
    provider: active.provider,
    providerInstanceId: active.providerInstanceId,
    status: active.status,
    runtimeMode: active.runtimeMode,
    ...(active.cwd ? { cwd: active.cwd } : {}),
    model: active.model,
    threadId,
    mcpServerIds: active.mcpServerIds,
    ...(active.activeTurn ? { activeTurnId: active.activeTurn.turnId } : {}),
    createdAt: active.createdAt,
    updatedAt: nowIso(),
  };
}

const MISSING_SUSPENDED_RUN = "AGENT_SEND_STREAM_RESUME_NO_SUSPENDED_THREAD_RUN";
const RESUME_FAILED_MESSAGE = "This response could not resume. Send your reply again.";
