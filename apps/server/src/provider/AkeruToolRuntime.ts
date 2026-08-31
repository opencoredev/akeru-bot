import { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, type Workspace } from "@mastra/core/workspace";
import {
  AkeruToolInputSchemas,
  type AkeruToolDefinition,
  type AkeruToolId,
  type AkeruToolWorkspaceType,
  type RuntimeMode,
  akeruToolRequiresApproval,
  decodeAkeruToolInput,
  filterAkeruTools,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export interface AkeruToolSession {
  readonly runtimeMode: RuntimeMode;
  readonly workspaceType: AkeruToolWorkspaceType;
  readonly workspace?: Workspace;
  readonly userComputerWorkspace?: Workspace;
}

export interface AkeruToolExecution {
  readonly threadId: string;
  readonly toolId: AkeruToolId;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly approvalMode: "require-grant";
}

export interface AkeruToolRuntime {
  readonly registerSession: (threadId: string, session: AkeruToolSession) => void;
  readonly unregisterSession: (threadId: string) => void;
  readonly toolsForThread: (threadId: string) => ReadonlyArray<AkeruToolDefinition>;
  readonly requiresApproval: (
    threadId: string,
    toolId: AkeruToolId,
    input: unknown,
  ) => Promise<boolean>;
  readonly grantApproval: (input: Omit<AkeruToolExecution, "approvalMode">) => void;
  readonly execute: (input: AkeruToolExecution) => Promise<unknown>;
}

const BACKEND_NAMES: Record<
  Exclude<AkeruToolId, "CopyToBox" | "CopyFromBox" | "request_box_help">,
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

export function createAkeruToolRuntime(): AkeruToolRuntime {
  const sessions = new Map<string, AkeruToolSession>();
  const grants = new Map<string, { readonly toolId: AkeruToolId; readonly input: string }>();
  const key = (threadId: string, toolCallId: string) => `${threadId}\u0000${toolCallId}`;

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
    return tools;
  };

  const toolsForThread = (threadId: string) => {
    const session = sessions.get(threadId);
    if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);
    const implemented = implementedTools(session);
    return filterAkeruTools({
      capabilities: new Set(["bot-workspace", "user-computer"]),
      workspaceType: session.workspaceType,
      hasUserComputer: Boolean(session.userComputerWorkspace),
      localFullAccess: session.runtimeMode === "full-access",
      implementedTools: implemented,
    });
  };

  const validatedInput = (toolId: AkeruToolId, input: unknown) =>
    Schema.decodeUnknownPromise(AkeruToolInputSchemas[toolId])(input, {
      onExcessProperty: "error",
    });

  return {
    registerSession: (threadId, session) => {
      sessions.set(threadId, session);
    },
    unregisterSession: (threadId) => {
      sessions.delete(threadId);
      for (const grantKey of grants.keys()) {
        if (grantKey.startsWith(`${threadId}\u0000`)) grants.delete(grantKey);
      }
    },
    toolsForThread,
    requiresApproval: async (threadId, toolId, input) => {
      const session = sessions.get(threadId);
      if (!session) throw new Error(`Tool session '${threadId}' is not registered.`);
      const tool = toolsForThread(threadId).find((candidate) => candidate.id === toolId);
      if (!tool) throw new Error(`Tool '${toolId}' is not available for this turn.`);
      return akeruToolRequiresApproval(
        tool,
        {
          localFullAccess: session.runtimeMode === "full-access",
          workspaceType: session.workspaceType,
        },
        await validatedInput(toolId, input),
      );
    },
    grantApproval: (input) => {
      grants.set(key(input.threadId, input.toolCallId), {
        toolId: input.toolId,
        input: canonicalInput(decodeAkeruToolInput(input.toolId, input.input)),
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
      if (
        akeruToolRequiresApproval(
          tool,
          {
            localFullAccess: session.runtimeMode === "full-access",
            workspaceType: session.workspaceType,
          },
          decoded,
        )
      ) {
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
        throw new Error("Human handoff is not available for this session.");
      }

      const workspace = workspaceForTool(input.toolId, session);
      const backends = await toolsForWorkspace(workspace);
      const backendName = BACKEND_NAMES[input.toolId].find((name) => executable(backends[name]));
      const backend = backendName ? backends[backendName] : undefined;
      if (!executable(backend)) throw new Error(`Tool '${input.toolId}' has no backend.`);
      const backendInput =
        input.toolId === "AwaitShell" || input.toolId === "AwaitExternalShell"
          ? { pid: requiredString(decoded, "handleId"), wait: true }
          : decoded;
      return backend.execute(backendInput, {
        workspace,
        requestContext: new RequestContext(),
        observe: {
          span: async <A>(_name: string, run: () => A | Promise<A>) => run(),
          log: () => undefined,
        },
      });
    },
  };
}
