import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, type Workspace } from "@mastra/core/workspace";
import {
  AkeruToolInputSchemas,
  type AkeruToolReceipt,
  type BotId,
  type AkeruToolDefinition,
  type AkeruToolId,
  type AkeruToolWorkspaceType,
  type RuntimeMode,
  ThreadId,
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
  readonly runtimeMode: RuntimeMode;
  readonly workspaceType: AkeruToolWorkspaceType;
  readonly workspace?: Workspace;
  readonly userComputerWorkspace?: Workspace;
  readonly memoryHandlers?: Record<AkeruMemoryToolId, AkeruMemoryToolHandler>;
  readonly delegation?: {
    readonly send: (
      input: (typeof AkeruToolInputSchemas.SendToAgent)["Type"],
    ) => Promise<AkeruToolReceipt>;
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
  readonly catalogHandlers?: Partial<Record<AkeruToolId, AkeruCatalogToolHandler>>;
}

export interface AkeruToolRuntimeOptions {
  readonly onUserActionRequired?: (input: UserActionIncidentInput) => void | Promise<void>;
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
    | "SendToAgent"
    | "CreateChannel"
    | "UpdateChannel"
    | "SendToUser"
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

export function createAkeruToolRuntime(options?: AkeruToolRuntimeOptions): AkeruToolRuntime {
  const sessions = new Map<string, AkeruToolSession>();
  const grants = new Map<string, { readonly toolId: AkeruRuntimeToolId; readonly input: string }>();
  const key = (threadId: string, toolCallId: string) => `${threadId}\u0000${toolCallId}`;
  const clearGrants = (threadId: string) => {
    for (const grantKey of grants.keys()) {
      if (grantKey.startsWith(`${threadId}\u0000`)) grants.delete(grantKey);
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
    if (session.delegation) tools.add("SendToAgent");
    if (session.channels) {
      tools.add("CreateChannel");
      tools.add("UpdateChannel");
    }
    if (session.sendToUser) tools.add("SendToUser");
    for (const toolId of Object.keys(session.catalogHandlers ?? {}) as AkeruToolId[]) {
      tools.add(toolId);
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
    return akeruToolRequiresApproval(
      tool as AkeruToolDefinition,
      {
        localFullAccess: session.runtimeMode === "full-access",
        workspaceType: session.workspaceType,
      },
      input,
    );
  };

  return {
    registerSession: (threadId, session) => {
      clearGrants(threadId);
      sessions.set(threadId, session);
    },
    unregisterSession: (threadId) => {
      sessions.delete(threadId);
      clearGrants(threadId);
    },
    clearApprovals: clearGrants,
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
      const session = sessions.get(input.threadId);
      if (!session) throw new Error(`Tool session '${input.threadId}' is not registered.`);
      const tool = toolsForThread(input.threadId).find(
        (candidate) => candidate.id === input.toolId,
      );
      if (!tool) throw new Error(`Tool '${input.toolId}' is not available for this turn.`);
      const decoded = await validatedInput(input.toolId, input.input);
      if (await requiresApproval(session, tool, decoded)) {
        const grantKey = key(input.threadId, input.toolCallId);
        const grant = grants.get(grantKey);
        if (
          !grant ||
          input.approvalMode !== "require-grant" ||
          grant?.toolId !== input.toolId ||
          grant.input !== canonicalInput(decoded)
        ) {
          throw new Error(`Tool '${input.toolId}' requires approval.`);
        }
        grants.delete(grantKey);
      }

      if (isMemoryToolId(input.toolId)) {
        const handler = session.memoryHandlers?.[input.toolId];
        if (!handler) throw new Error(`Tool '${input.toolId}' has no backend.`);
        return handler({ ...input, toolId: input.toolId, input: decoded });
      }

      const catalogHandler = session.catalogHandlers?.[input.toolId];
      if (catalogHandler) {
        return catalogHandler({
          input: decoded,
          emitProgress: (summary) =>
            options?.onProgress?.({
              threadId: input.threadId,
              toolId: input.toolId as AkeruToolId,
              toolCallId: input.toolCallId,
              summary,
            }),
        });
      }

      if (input.toolId === "SendToAgent") {
        if (!session.delegation) throw new Error("Delegation is not available for this session.");
        const delegationInput = decodeAkeruToolInput("SendToAgent", decoded);
        try {
          return await session.delegation.send(delegationInput);
        } catch (cause) {
          return {
            receiptId: input.toolCallId,
            toolId: input.toolId,
            phase: "failure",
            threadId: ThreadId.make(input.threadId),
            botId: session.botId,
            summary: cause instanceof Error ? cause.message : String(cause),
            failureCode: "internal",
            fatalToThread: false,
            billedBotId: delegationInput.botId,
            createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
          } satisfies AkeruToolReceipt;
        }
      }

      if (input.toolId === "CreateChannel" || input.toolId === "UpdateChannel") {
        if (!session.channels || !session.botId) {
          throw new Error("Channel management is not available for this session.");
        }
        try {
          const channelId =
            input.toolId === "CreateChannel"
              ? await session.channels.create(decodeAkeruToolInput("CreateChannel", decoded))
              : await session.channels.update(decodeAkeruToolInput("UpdateChannel", decoded));
          return {
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
          return {
            receiptId: input.toolCallId,
            toolId: input.toolId,
            phase: "failure",
            threadId: ThreadId.make(input.threadId),
            botId: session.botId,
            summary: cause instanceof Error ? cause.message : String(cause),
            failureCode: "internal",
            fatalToThread: false,
            billedBotId: session.botId,
            createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
          } satisfies AkeruToolReceipt;
        }
      }

      if (input.toolId === "SendToUser") {
        if (!session.sendToUser)
          throw new Error("User messaging is not available for this session.");
        try {
          return await session.sendToUser(decodeAkeruToolInput("SendToUser", decoded));
        } catch (cause) {
          return {
            receiptId: input.toolCallId,
            toolId: input.toolId,
            phase: "failure",
            threadId: ThreadId.make(input.threadId),
            botId: session.botId,
            summary: cause instanceof Error ? cause.message : String(cause),
            failureCode: "internal",
            fatalToThread: false,
            createdAt: options?.now?.() ?? DateTime.formatIso(DateTime.nowUnsafe()),
          } satisfies AkeruToolReceipt;
        }
      }

      if (input.toolId === "CopyToBox" || input.toolId === "CopyFromBox") {
        const source =
          input.toolId === "CopyToBox" ? session.userComputerWorkspace : session.workspace;
        const destination =
          input.toolId === "CopyToBox" ? session.workspace : session.userComputerWorkspace;
        if (!source?.filesystem || !destination?.filesystem) {
          throw new Error("Both computer boundaries are required for file copy.");
        }
        const sourcePath = requiredString(decoded, "sourcePath");
        const destinationPath = requiredString(decoded, "destinationPath");
        await destination.filesystem.writeFile(
          destinationPath,
          await source.filesystem.readFile(sourcePath),
          { recursive: true },
        );
        return { sourcePath, destinationPath };
      }
      if (input.toolId === "request_box_help") {
        if (!options?.onUserActionRequired || !session.botId || !session.botName) {
          throw new Error("Human handoff is not available for this session.");
        }
        await options.onUserActionRequired({
          botId: session.botId,
          botName: session.botName,
          toolId: input.toolId,
          summary: requiredString(decoded, "message"),
          nextAction: "Open the bot workspace and complete the requested step.",
          target: requiredString(decoded, "reason"),
        });
        return { requested: true };
      }

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
      const result = await backend.execute(backendInput, {
        workspace,
        requestContext: new RequestContext(),
        observe: {
          span: async <A>(_name: string, run: () => A | Promise<A>) => run(),
          log: () => undefined,
        },
      });
      if (input.toolId !== "Screenshot") return result;

      const mediaType = field(result, "mediaType");
      const data = field(result, "data");
      if (mediaType !== "image/png" || typeof data !== "string") {
        throw new Error("Screenshot result is invalid.");
      }
      const redacted = redactComputerScreenshot({
        mediaType,
        data: Buffer.from(data, "base64"),
      });
      return {
        ...(result as Record<string, unknown>),
        data: Buffer.from(redacted.data).toString("base64"),
      };
    },
  };
}
