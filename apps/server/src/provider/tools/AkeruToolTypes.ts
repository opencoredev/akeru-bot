import type { Tool } from "@mastra/core/tools";
import type * as DateTime from "effect/DateTime";
import type { BotApprovalCheck } from "@akeru/shared/botPermissions";
import type { createAkeruNamedActionPermissions } from "./AkeruNamedActionPermissions.ts";
import { type Workspace } from "@mastra/core/workspace";
import {
  type AkeruDelegationAccessGrant,
  AkeruToolInputSchemas,
  type BotActionPrincipal,
  type BotHumanPrincipal,
  type BotId,
  type BotPermissionPolicy,
  type EnvironmentId,
  type AkeruToolId,
  type AkeruToolReceipt,
  type AkeruToolWorkspaceType,
  type AkeruWorkerStatus,
  type RuntimeMode,
} from "@akeru/contracts";
import type { UserActionIncidentInput } from "../../bot-inbox/userActionIncidents.ts";
import {
  type AkeruMemoryToolHandler,
  type AkeruMemoryToolId,
} from "../../memory/BotMemoryToolHandlers.ts";
import type { AkeruCatalogToolHandler } from "./AkeruCatalogTypes.ts";
import type { AkeruBotStateRuntime } from "../AkeruBotStateRuntime.ts";

/** Native and plugin tools use the SDK result contract until tool-specific processing. */
export type AkeruToolResult = Awaited<ReturnType<NonNullable<Tool["execute"]>>>;

export type AkeruRuntimeToolId = AkeruToolId | AkeruMemoryToolId;

export interface AkeruRuntimeToolDefinition {
  readonly id: AkeruRuntimeToolId;
  readonly description: string;
}

/** Who the session acts for and the bot policy that governs it. */
export interface AkeruToolPermissions {
  readonly principal: BotActionPrincipal;
  /** The policy known when the session registered. */
  readonly policy: BotPermissionPolicy;
  /** Reads the current policy. Every async check and every run calls it, so revocation applies at once. */
  readonly readPolicy?: () => Promise<BotPermissionPolicy>;
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
  /** Absent means the owner, under the default bot policy. */
  readonly permissions?: AkeruToolPermissions;
  readonly delegation?: {
    readonly depth: number;
    readonly activeDelegations: number;
    readonly access: AkeruDelegationAccessGrant;
    readonly create?: (
      input: (typeof AkeruToolInputSchemas.CreateAgent)["Type"],
    ) => Promise<AkeruToolResult>;
    readonly check?: (
      input: (typeof AkeruToolInputSchemas.CheckAgent)["Type"],
    ) => Promise<AkeruToolResult>;
    readonly send: (
      input: (typeof AkeruToolInputSchemas.SendToAgent)["Type"],
    ) => Promise<AkeruToolResult>;
    readonly stop?: (
      input: (typeof AkeruToolInputSchemas.StopAgent)["Type"],
    ) => Promise<AkeruToolResult>;
  };
  /** Temporary workers owned by this bot turn. Worker threads never get this. */
  readonly workers?: {
    readonly depth: number;
    readonly spawn: (
      input: (typeof AkeruToolInputSchemas.Task)["Type"],
    ) => Promise<AkeruWorkerStatus>;
    readonly check: (
      input: (typeof AkeruToolInputSchemas.CheckSubagent)["Type"],
    ) => Promise<AkeruWorkerStatus>;
    readonly message: (
      input: (typeof AkeruToolInputSchemas.MessageSubagent)["Type"],
    ) => Promise<AkeruWorkerStatus>;
    readonly stop: (
      input: (typeof AkeruToolInputSchemas.StopSubagent)["Type"],
    ) => Promise<AkeruWorkerStatus>;
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
  ) => Promise<AkeruToolResult>;
  readonly catalogHandlers?: Partial<Record<AkeruToolId, AkeruCatalogToolHandler>>;
  /** Image providers enabled in Settings; gates the GenerateImage tool. */
  readonly imageGeneration?: { readonly chatgptEnabled: boolean; readonly grokEnabled: boolean };
}

export interface AkeruToolRuntimeOptions {
  readonly onUserActionRequired?: (input: UserActionIncidentInput) => void | Promise<void>;
  readonly onReceipt?: (receipt: AkeruToolReceipt) => void;
  readonly onProgress?: (input: {
    readonly threadId: string;
    readonly toolId: AkeruToolId;
    readonly toolCallId: string;
    readonly summary: string;
    readonly authorizationUrl?: string;
  }) => void | Promise<void>;
  readonly now?: () => string;
  /** The environment approvals are bound to. */
  readonly environmentId?: EnvironmentId;
  readonly approvalTtlMillis?: number;
  /** Clock for approval expiry. */
  readonly clock?: () => DateTime.Utc;
  readonly onToolStart?: (input: AkeruToolExecution, session: AkeruToolSession) => Promise<void>;
  readonly onToolFinish?: (input: AkeruToolExecution, session: AkeruToolSession) => Promise<void>;
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
    input: AkeruToolExecution["input"],
  ) => Promise<boolean>;
  /**
   * Who must approve a call, from the last policy this thread read. Use it to
   * decide whether the chat mode may answer for the owner. `none` means an
   * explicit allow for this tool, which skips the chat mode's prompt.
   */
  readonly approvalRequirement: (
    threadId: string,
    toolId: AkeruRuntimeToolId,
    input: AkeruToolExecution["input"],
  ) => "none" | "mode" | "owner" | "blocked";
  /** Binds a pending approval to its requester, answerer, action, environment, and expiry. */
  readonly openApproval: (input: Omit<AkeruToolExecution, "approvalMode">) => void;
  /**
   * Records an approving answer. Environment clients answer as the owner, which
   * is the default. Returns the rejection when the answer is refused.
   */
  readonly grantApproval: (
    input: Omit<AkeruToolExecution, "approvalMode"> & {
      readonly answeredBy?: BotHumanPrincipal;
    },
  ) => BotApprovalCheck;
  /**
   * Records the chat's permission mode approving a routine call. It is refused
   * when the bot policy currently reserves the call for the owner's answer.
   */
  readonly grantModeApproval: (input: Omit<AkeruToolExecution, "approvalMode">) => BotApprovalCheck;
  /** Routine checks and owner approvals for named actions outside the tool catalog. */
  readonly requiresNamedApproval: ReturnType<
    typeof createAkeruNamedActionPermissions
  >["requiresNamedApproval"];
  readonly namedActionRequirement: ReturnType<
    typeof createAkeruNamedActionPermissions
  >["namedActionRequirement"];
  readonly openNamedApproval: ReturnType<
    typeof createAkeruNamedActionPermissions
  >["openNamedApproval"];
  readonly grantNamedApproval: ReturnType<
    typeof createAkeruNamedActionPermissions
  >["grantNamedApproval"];
  readonly authorizeNamedExecution: ReturnType<
    typeof createAkeruNamedActionPermissions
  >["authorizeNamedExecution"];
  readonly authorizeAction: ReturnType<typeof createAkeruNamedActionPermissions>["authorizeAction"];
  readonly execute: (input: AkeruToolExecution) => Promise<AkeruToolResult>;
}
