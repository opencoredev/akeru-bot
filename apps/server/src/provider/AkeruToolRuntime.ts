// @effect-diagnostics globalDate:off
import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, type Workspace } from "@mastra/core/workspace";
import {
  type AkeruDelegationAccessGrant,
  type AkeruMemoryTargetScope,
  AkeruToolInputSchemas,
  type BotId,
  type AkeruToolDefinition,
  type AkeruToolId,
  type AkeruToolReceipt,
  type AkeruToolWorkspaceType,
  type RuntimeMode,
  ThreadId,
  akeruToolApprovalForInput,
  akeruToolRequiresApproval,
  decodeAkeruToolInput,
  filterAkeruTools,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import type { UserActionIncidentInput } from "../bot-inbox/userActionIncidents.ts";
import { redactComputerScreenshot } from "../mcp/PreviewSnapshotRedaction.ts";
import {
  AkeruMemoryToolInputSchemas,
  type AkeruMemoryToolHandler,
  type AkeruMemoryToolId,
} from "../memory/MemoryToolHandlers.ts";
import type { AkeruCatalogToolHandler } from "./AkeruCatalogToolHandlers.ts";
import type { AkeruBotStateRuntime } from "./AkeruBotStateRuntime.ts";

export type AkeruRuntimeToolId = AkeruToolId | AkeruMemoryToolId;

export interface AkeruRuntimeToolDefinition {
  readonly id: AkeruRuntimeToolId;
  readonly description: string;
}

const MEMORY_TOOL_DEFINITIONS = [
  { id: "recall_memory", description: "Search approved memory for the current turn." },
  { id: "remember", description: "Propose a durable fact for the current user and bot context." },
  { id: "update_memory", description: "Propose a revision to an authorized durable fact." },
  { id: "forget_memory", description: "Forget an authorized durable fact immediately." },
] as const satisfies ReadonlyArray<AkeruRuntimeToolDefinition>;

const MEMORY_TOOL_INPUT_DECODERS = {
  recall_memory: Schema.decodeUnknownSync(AkeruMemoryToolInputSchemas.recall_memory),
  remember: Schema.decodeUnknownSync(AkeruMemoryToolInputSchemas.remember),
  update_memory: Schema.decodeUnknownSync(AkeruMemoryToolInputSchemas.update_memory),
  forget_memory: Schema.decodeUnknownSync(AkeruMemoryToolInputSchemas.forget_memory),
} as const;

export function isMemoryToolId(toolId: string): toolId is AkeruMemoryToolId {
  return Object.hasOwn(AkeruMemoryToolInputSchemas, toolId);
}

export interface AkeruToolSession {
  readonly botId?: BotId;
  readonly botName?: string;
  readonly billedBotId?: BotId;
  readonly runtimeMode: RuntimeMode;
  readonly workspaceType: AkeruToolWorkspaceType;
  readonly timezone?: string;
  readonly workspace?: Workspace;
  readonly userComputerWorkspace?: Workspace;
  readonly memoryHandlers?: Record<AkeruMemoryToolId, AkeruMemoryToolHandler>;
  readonly delegation?: {
    readonly depth: number;
    readonly activeDelegations: number;
    readonly access: AkeruDelegationAccessGrant;
    readonly create?: (
      input: (typeof AkeruToolInputSchemas.CreateAgent)["Type"],
    ) => Promise<unknown>;
    readonly check?: (input: (typeof AkeruToolInputSchemas.CheckAgent)["Type"]) => Promise<unknown>;
    readonly send: (input: (typeof AkeruToolInputSchemas.SendToAgent)["Type"]) => Promise<unknown>;
    readonly stop?: (input: (typeof AkeruToolInputSchemas.StopAgent)["Type"]) => Promise<unknown>;
  };
  readonly channels?: {
    readonly create: (
      input: (typeof AkeruToolInputSchemas.CreateChannel)["Type"],
    ) => Promise<string>;
    readonly update: (
      input: (typeof AkeruToolInputSchemas.UpdateChannel)["Type"],
    ) => Promise<string>;
  };
  readonly sendToUser?: (
    input: (typeof AkeruToolInputSchemas.SendToUser)["Type"],
  ) => Promise<AkeruToolReceipt>;
  readonly botState?: Pick<AkeruBotStateRuntime, "updateProfile">;
  readonly reactToMessage?: (
    input: (typeof AkeruToolInputSchemas.ReactToMessage)["Type"],
    toolCallId: string,
  ) => Promise<unknown>;
  readonly catalogHandlers?: Partial<Record<AkeruToolId, AkeruCatalogToolHandler>>;
}

export interface AkeruToolRuntimeOptions {
  readonly onUserActionRequired?: (input: UserActionIncidentInput) => void | Promise<void>;
  readonly onReceipt?: (receipt: AkeruToolReceipt) => void;
  readonly onProgress?: (input: {
    readonly threadId: string;
    readonly toolId: AkeruToolId;
    readonly toolCallId: string;
    readonly summary: string;
  }) => void | Promise<void>;
  readonly now?: () => string;
}

export interface AkeruToolExecution {
  readonly threadId: string;
  readonly toolId: AkeruRuntimeToolId;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly approvalMode: "require-grant";
}

export interface AkeruToolRuntime {
  readonly registerSession: (threadId: string, session: AkeruToolSession) => void;
  readonly unregisterSession: (threadId: string) => void;
  readonly clearApprovals: (threadId: string) => void;
  readonly toolsForThread: (threadId: string) => ReadonlyArray<AkeruRuntimeToolDefinition>;
  readonly requiresApproval: (
    threadId: string,
    toolId: AkeruRuntimeToolId,
    input: unknown,
  ) => Promise<boolean>;
  readonly grantApproval: (input: Omit<AkeruToolExecution, "approvalMode">) => void;
  readonly execute: (input: AkeruToolExecution) => Promise<unknown>;
}

const BACKEND_NAMES: Record<
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

function field(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function requiredString(value: unknown, key: string): string {
  const candidate = field(value, key);
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Tool input field '${key}' is required.`);
  }
  return candidate;
}

function canonicalInput(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInput).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalInput(field(value, key))}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function ensureWorkspaceCwd(toolId: AkeruToolId, input: unknown): void {
  if (toolId !== "Shell" && toolId !== "ExternalShell") return;
  const cwd = field(input, "cwd");
  if (cwd === undefined) return;
  if (typeof cwd !== "string") throw new Error(`Tool '${toolId}' cwd must be a relative path.`);
  if (
    cwd.startsWith("/") ||
    cwd.startsWith("\\") ||
    /^[A-Za-z]:/.test(cwd) ||
    cwd.split(/[\\/]+/).includes("..")
  ) {
    throw new Error(`Tool '${toolId}' cwd must stay inside its workspace.`);
  }
}

function workspaceForTool(toolId: AkeruToolId, session: AkeruToolSession) {
  return toolId === "ExternalShell" || toolId === "ExternalRead" || toolId === "AwaitExternalShell"
    ? session.userComputerWorkspace
    : session.workspace;
}

async function toolsForWorkspace(workspace: Workspace | undefined) {
  if (!workspace) return {};
  return createWorkspaceTools(workspace, {
    requestContext: {},
    workspace,
  });
}

function executable(value: unknown): value is {
  readonly execute: (input: unknown, context: Record<string, unknown>) => Promise<unknown>;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "execute" in value &&
    typeof value.execute === "function"
  );
}

const APPROVAL_RANK = [
  "none",
  "user-computer",
  "send",
  "pay",
  "delete",
  "production",
  "secrets",
] as const;
const RUNTIME_RANK = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;

function requestedSubset<T>(
  requested: ReadonlyArray<T> | undefined,
  ceiling: ReadonlyArray<T>,
  label: string,
): ReadonlyArray<T> {
  if (requested?.some((value) => !ceiling.includes(value))) {
    throw new Error(`Delegation requested ${label} outside the parent turn grant.`);
  }
  return requested ?? ceiling;
}

export function intersectDelegationAccess(input: {
  readonly parent: AkeruDelegationAccessGrant;
  readonly child: AkeruDelegationAccessGrant;
  readonly requested: (typeof AkeruToolInputSchemas.SendToAgent)["Type"];
}): AkeruDelegationAccessGrant {
  const requestedTools = requestedSubset(
    input.requested.allowedToolIds,
    input.parent.allowedToolIds,
    "tools",
  );
  const requestedMemory = requestedSubset<AkeruMemoryTargetScope>(
    input.requested.memoryScopes,
    input.parent.memoryScopes,
    "memory scopes",
  );
  const requestedMcpServers = requestedSubset(
    input.requested.mcpServerIds,
    input.parent.enabledMcpServerIds,
    "MCP servers",
  );
  const requestedRuntime = input.requested.runtimeMode ?? input.parent.runtimeMode;
  if (RUNTIME_RANK.indexOf(requestedRuntime) > RUNTIME_RANK.indexOf(input.parent.runtimeMode)) {
    throw new Error("Delegation requested a runtime mode above the parent turn grant.");
  }
  const requestedApproval = input.requested.approvalCeiling ?? input.parent.approvalCeiling;
  if (
    APPROVAL_RANK.indexOf(requestedApproval) > APPROVAL_RANK.indexOf(input.parent.approvalCeiling)
  ) {
    throw new Error("Delegation requested approvals above the parent turn grant.");
  }
  if (
    input.requested.sandbox !== undefined &&
    input.requested.sandbox !== null &&
    input.requested.sandbox !== input.parent.sandbox
  ) {
    throw new Error("Delegation requested a sandbox outside the parent turn grant.");
  }
  const sandbox =
    input.requested.sandbox === undefined ? input.parent.sandbox : input.requested.sandbox;
  return {
    allowedToolIds: requestedTools.filter((toolId) => input.child.allowedToolIds.includes(toolId)),
    memoryScopes: requestedMemory.filter((scope) => input.child.memoryScopes.includes(scope)),
    sandbox: sandbox === input.child.sandbox ? sandbox : null,
    runtimeMode:
      RUNTIME_RANK.indexOf(requestedRuntime) <= RUNTIME_RANK.indexOf(input.child.runtimeMode)
        ? requestedRuntime
        : input.child.runtimeMode,
    hasUserComputer: input.parent.hasUserComputer && input.child.hasUserComputer,
    enabledMcpServerIds: requestedMcpServers.filter((serverId) =>
      input.child.enabledMcpServerIds.includes(serverId),
    ),
    disabledMcpServerIds: [
      ...new Set([...input.parent.disabledMcpServerIds, ...input.child.disabledMcpServerIds]),
    ],
    approvalCeiling:
      APPROVAL_RANK.indexOf(requestedApproval) <= APPROVAL_RANK.indexOf(input.child.approvalCeiling)
        ? requestedApproval
        : input.child.approvalCeiling,
  };
}

export function createAkeruToolRuntime(options?: AkeruToolRuntimeOptions): AkeruToolRuntime {
  const sessions = new Map<string, AkeruToolSession>();
  const grants = new Map<string, { readonly toolId: AkeruRuntimeToolId; readonly input: string }>();
  const key = (threadId: string, toolCallId: string) => `${threadId}\u0000${toolCallId}`;
  const clearApprovals = (threadId: string) => {
    for (const grantKey of grants.keys()) {
      if (grantKey.startsWith(`${threadId}\u0000`)) grants.delete(grantKey);
    }
  };
  const emitReceipt = (
    input: AkeruToolExecution,
    phase: AkeruToolReceipt["phase"],
    details?: Pick<AkeruToolReceipt, "failureCode" | "summary">,
  ) => {
    try {
      options?.onReceipt?.({
        receiptId: input.toolCallId,
        toolId: input.toolId,
        phase,
        threadId: ThreadId.make(input.threadId),
        fatalToThread: false,
        createdAt: new Date().toISOString(),
        ...details,
      });
    } catch {
      // Receipt observers must not change tool execution.
    }
  };

  const implementedTools = (session: AkeruToolSession) => {
    const tools = new Set<AkeruToolId>();
    if (session.workspace?.sandbox?.executeCommand) tools.add("Shell");
    if (session.workspace?.filesystem) tools.add("Read");
    if (session.workspace?.sandbox?.processes) tools.add("AwaitShell");
    if (session.workspace?.sandbox?.computer) tools.add("Screenshot");
    if (session.userComputerWorkspace?.sandbox?.executeCommand) {
      tools.add("ExternalShell");
    }
    if (session.userComputerWorkspace?.filesystem) {
      tools.add("ExternalRead");
    }
    if (session.userComputerWorkspace?.sandbox?.processes) {
      tools.add("AwaitExternalShell");
    }
    if (session.workspace?.filesystem && session.userComputerWorkspace?.filesystem) {
      tools.add("CopyToBox");
      tools.add("CopyFromBox");
    }
    if (options?.onUserActionRequired && session.workspace && session.botId && session.botName) {
      tools.add("request_box_help");
    }
    if (session.delegation) {
      if (session.delegation.create) tools.add("CreateAgent");
      if (session.delegation.check) tools.add("CheckAgent");
      tools.add("MessageAgent");
      if (session.delegation.stop) tools.add("StopAgent");
      tools.add("SendToAgent");
    }
    if (session.channels) {
      tools.add("CreateChannel");
      tools.add("UpdateChannel");
    }
    if (session.sendToUser) tools.add("SendToUser");
    if (session.botId && session.botState) tools.add("UpdateBotProfile");
    if (session.reactToMessage) tools.add("ReactToMessage");
    for (const toolId of Object.keys(session.catalogHandlers ?? {}) as AkeruToolId[]) {
      tools.add(toolId);
    }
    if (session.delegation) {
      for (const toolId of tools) {
        if (!session.delegation.access.allowedToolIds.includes(toolId)) tools.delete(toolId);
      }
    }
    return tools;
  };

  const toolsForThread = (threadId: string) => {
    const session = sessions.get(threadId);
    if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);
    const implemented = implementedTools(session);
    const workspaceTools = filterAkeruTools({
      capabilities: new Set(["bot-workspace", "user-computer"]),
      workspaceType: session.workspaceType,
      hasUserComputer: Boolean(session.userComputerWorkspace),
      localFullAccess: session.runtimeMode === "full-access",
      implementedTools: implemented,
      ...(session.delegation
        ? {
            delegationDepth: session.delegation.depth,
            activeDelegations: session.delegation.activeDelegations,
          }
        : {}),
    });
    return session.memoryHandlers
      ? [...workspaceTools, ...MEMORY_TOOL_DEFINITIONS]
      : workspaceTools;
  };

  const validatedInput = (toolId: AkeruRuntimeToolId, input: unknown) =>
    Schema.decodeUnknownPromise(
      isMemoryToolId(toolId) ? AkeruMemoryToolInputSchemas[toolId] : AkeruToolInputSchemas[toolId],
    )(input, {
      onExcessProperty: "error",
    });

  const decodedGrantInput = (toolId: AkeruRuntimeToolId, input: unknown) =>
    isMemoryToolId(toolId)
      ? MEMORY_TOOL_INPUT_DECODERS[toolId](input, { onExcessProperty: "error" })
      : decodeAkeruToolInput(toolId, input);

  const requiresApproval = async (
    session: AkeruToolSession,
    tool: AkeruRuntimeToolDefinition,
    input: unknown,
  ) => {
    if (tool.id === "recall_memory") return field(input, "includeSensitive") === true;
    if (tool.id === "remember") {
      return field(input, "scope") !== "private" || field(input, "sensitive") === true;
    }
    if (tool.id === "update_memory" || tool.id === "forget_memory") return true;
    const akeruTool = tool as AkeruToolDefinition;
    ensureWorkspaceCwd(akeruTool.id, input);
    const ceiling = session.delegation?.access.approvalCeiling;
    if (
      ceiling &&
      APPROVAL_RANK.indexOf(
        akeruToolApprovalForInput(akeruTool, input, { workspaceType: session.workspaceType }),
      ) > APPROVAL_RANK.indexOf(ceiling)
    ) {
      throw new Error(`Tool '${tool.id}' exceeds this delegation's approval ceiling.`);
    }
    return akeruToolRequiresApproval(
      akeruTool,
      {
        localFullAccess: session.runtimeMode === "full-access",
        workspaceType: session.workspaceType,
      },
      input,
    );
  };

  return {
    registerSession: (threadId, session) => {
      clearApprovals(threadId);
      sessions.set(threadId, session);
    },
    unregisterSession: (threadId) => {
      sessions.delete(threadId);
      clearApprovals(threadId);
    },
    clearApprovals,
    toolsForThread,
    requiresApproval: async (threadId, toolId, input) => {
      const session = sessions.get(threadId);
      if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);
      const tool = toolsForThread(threadId).find((candidate) => candidate.id === toolId);
      if (!tool) throw new Error(`Tool '${toolId}' is not available for this turn.`);
      return requiresApproval(session, tool, await validatedInput(toolId, input));
    },
    grantApproval: (input) => {
      grants.set(key(input.threadId, input.toolCallId), {
        toolId: input.toolId,
        input: canonicalInput(decodedGrantInput(input.toolId, input.input)),
      });
    },
    execute: async (input) => {
      let failureCode: NonNullable<AkeruToolReceipt["failureCode"]> = "internal";
      emitReceipt(input, "start");
      try {
        failureCode = "not_found";
        const session = sessions.get(input.threadId);
        if (!session) throw new Error(`Tool session '${input.threadId}' is not registered.`);
        const tool = toolsForThread(input.threadId).find(
          (candidate) => candidate.id === input.toolId,
        );
        if (!tool) throw new Error(`Tool '${input.toolId}' is not available for this turn.`);

        failureCode = "validation";
        const decoded = await validatedInput(input.toolId, input.input);
        failureCode = "denied";
        if (await requiresApproval(session, tool, decoded)) {
          const grantKey = key(input.threadId, input.toolCallId);
          const grant = grants.get(grantKey);
          if (
            !grant ||
            input.approvalMode !== "require-grant" ||
            grant.toolId !== input.toolId ||
            grant.input !== canonicalInput(decoded)
          ) {
            throw new Error(`Tool '${input.toolId}' requires approval.`);
          }
          grants.delete(grantKey);
        }

        failureCode = "not_found";
        let result: unknown;
        const catalogHandler = session.catalogHandlers?.[input.toolId as AkeruToolId];
        if (isMemoryToolId(input.toolId)) {
          const handler = session.memoryHandlers?.[input.toolId];
          if (!handler) throw new Error(`Tool '${input.toolId}' has no backend.`);
          failureCode = "internal";
          result = await handler({ ...input, toolId: input.toolId, input: decoded });
        } else if (catalogHandler) {
          failureCode = "internal";
          result = await catalogHandler({
            input: decoded,
            emitProgress: (summary: string) =>
              options?.onProgress?.({
                threadId: input.threadId,
                toolId: input.toolId as AkeruToolId,
                toolCallId: input.toolCallId,
                summary,
              }),
          });
        } else if (input.toolId === "SendToAgent" || input.toolId === "MessageAgent") {
          if (!session.delegation) throw new Error("Delegation is not available for this session.");
          const delegationInput =
            input.toolId === "MessageAgent"
              ? decodeAkeruToolInput("MessageAgent", decoded)
              : decodeAkeruToolInput("SendToAgent", decoded);
          failureCode = "internal";
          try {
            result = await session.delegation.send(delegationInput);
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              billedBotId: delegationInput.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });
            return result;
          }
        } else if (
          input.toolId === "CreateAgent" ||
          input.toolId === "CheckAgent" ||
          input.toolId === "StopAgent"
        ) {
          if (!session.delegation) {
            throw new Error("Bot management is not available for this session.");
          }
          failureCode = "internal";
          let billedBotId = session.botId;
          try {
            if (input.toolId === "CreateAgent") {
              if (!session.delegation.create) throw new Error("Bot creation is not available.");
              result = await session.delegation.create(
                decodeAkeruToolInput("CreateAgent", decoded),
              );
            } else if (input.toolId === "CheckAgent") {
              if (!session.delegation.check) throw new Error("Bot inspection is not available.");
              const checkInput = decodeAkeruToolInput("CheckAgent", decoded);
              billedBotId = checkInput.botId;
              result = await session.delegation.check(checkInput);
            } else {
              if (!session.delegation.stop) throw new Error("Bot cancellation is not available.");
              const stopInput = decodeAkeruToolInput("StopAgent", decoded);
              billedBotId = stopInput.botId;
              result = await session.delegation.stop(stopInput);
            }
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              ...(billedBotId ? { billedBotId } : {}),
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });
            return result;
          }
        } else if (input.toolId === "CreateChannel" || input.toolId === "UpdateChannel") {
          if (!session.channels || !session.botId) {
            throw new Error("Channel management is not available for this session.");
          }
          failureCode = "internal";
          try {
            const channelId =
              input.toolId === "CreateChannel"
                ? await session.channels.create(decodeAkeruToolInput("CreateChannel", decoded))
                : await session.channels.update(decodeAkeruToolInput("UpdateChannel", decoded));
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "success",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary: `Channel '${channelId}' saved.`,
              fatalToThread: false,
              billedBotId: session.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              billedBotId: session.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });
            return result;
          }
        } else if (input.toolId === "SendToUser") {
          if (!session.sendToUser) {
            throw new Error("User messaging is not available for this session.");
          }
          failureCode = "internal";
          try {
            result = await session.sendToUser(decodeAkeruToolInput("SendToUser", decoded));
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });
            return result;
          }
        } else if (input.toolId === "UpdateBotProfile") {
          if (!session.botId || !session.botState) {
            throw new Error("Bot profile management is not available for this session.");
          }
          failureCode = "internal";
          try {
            result = await session.botState.updateProfile(
              ThreadId.make(input.threadId),
              session.botId,
              input.toolCallId,
              decodeAkeruToolInput("UpdateBotProfile", decoded),
            );
          } catch (cause) {
            const summary = cause instanceof Error ? cause.message : String(cause);
            result = {
              receiptId: input.toolCallId,
              toolId: input.toolId,
              phase: "failure",
              threadId: ThreadId.make(input.threadId),
              botId: session.botId,
              summary,
              failureCode,
              fatalToThread: false,
              billedBotId: session.botId,
              createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
            } satisfies AkeruToolReceipt;
            emitReceipt(input, "failure", { failureCode, summary });
            return result;
          }
        } else if (input.toolId === "ReactToMessage") {
          if (!session.reactToMessage) {
            throw new Error("Message reactions are not available for this session.");
          }
          failureCode = "internal";
          result = await session.reactToMessage(
            decodeAkeruToolInput("ReactToMessage", decoded),
            input.toolCallId,
          );
        } else if (input.toolId === "CopyToBox" || input.toolId === "CopyFromBox") {
          const source =
            input.toolId === "CopyToBox" ? session.userComputerWorkspace : session.workspace;
          const destination =
            input.toolId === "CopyToBox" ? session.workspace : session.userComputerWorkspace;
          if (!source?.filesystem || !destination?.filesystem) {
            throw new Error("Both computer boundaries are required for file copy.");
          }
          const sourcePath = requiredString(decoded, "sourcePath");
          const destinationPath = requiredString(decoded, "destinationPath");
          failureCode = "internal";
          await destination.filesystem.writeFile(
            destinationPath,
            await source.filesystem.readFile(sourcePath),
            { recursive: true },
          );
          result = { sourcePath, destinationPath };
        } else if (input.toolId === "request_box_help") {
          if (!options?.onUserActionRequired || !session.botId || !session.botName) {
            throw new Error("Human handoff is not available for this session.");
          }
          failureCode = "internal";
          await options.onUserActionRequired({
            botId: session.botId,
            botName: session.botName,
            toolId: input.toolId,
            summary: requiredString(decoded, "message"),
            nextAction: "Open the bot workspace and complete the requested step.",
            target: requiredString(decoded, "reason"),
          });
          result = { requested: true };
        } else {
          const workspace = workspaceForTool(input.toolId, session);
          const backends = await toolsForWorkspace(workspace);
          const backendNames = BACKEND_NAMES[input.toolId as keyof typeof BACKEND_NAMES] ?? [];
          const backendName = backendNames.find((name) => executable(backends[name]));
          const backend = backendName ? backends[backendName] : undefined;
          if (!executable(backend)) throw new Error(`Tool '${input.toolId}' has no backend.`);
          const backendInput =
            input.toolId === "AwaitShell" || input.toolId === "AwaitExternalShell"
              ? { pid: requiredString(decoded, "handleId"), wait: true }
              : decoded;
          failureCode = "internal";
          result = await backend.execute(backendInput, {
            workspace,
            requestContext: new RequestContext(),
            observe: {
              span: async <A>(_name: string, run: () => A | Promise<A>) => run(),
              log: () => undefined,
            },
          });
        }
        if (input.toolId === "Screenshot") {
          const mediaType = field(result, "mediaType");
          const data = field(result, "data");
          if (mediaType !== "image/png" || typeof data !== "string") {
            throw new Error("Screenshot result is invalid.");
          }
          const redacted = redactComputerScreenshot({
            mediaType,
            data: Buffer.from(data, "base64"),
          });
          result = {
            ...(result as Record<string, unknown>),
            data: Buffer.from(redacted.data).toString("base64"),
          };
        }
        if (field(result, "phase") === "failure") {
          const summary = field(result, "summary");
          emitReceipt(input, "failure", {
            failureCode,
            summary: typeof summary === "string" ? summary : "Tool execution failed.",
          });
          return result;
        }
        emitReceipt(input, "success");
        return result;
      } catch (cause) {
        emitReceipt(input, "failure", { failureCode, summary: "Tool execution failed." });
        throw cause;
      }
    },
  };
}
