import * as Predicate from "effect/Predicate";
import { AKERU_DELEGATION_MAX_CONCURRENCY, AKERU_DELEGATION_MAX_DEPTH } from "./akeruDelegation.ts";
import { AKERU_WORKER_MAX_DEPTH } from "./akeruWorkers.ts";
import {
  AkeruToolId,
  AkeruToolApprovalClass,
  AkeruProtectedApprovalClass,
  AKERU_PROTECTED_APPROVAL_CLASSES,
  AkeruToolCapability,
  AkeruToolWorkspaceType,
  type AkeruCopyDirection,
  type AkeruToolDefinition,
  AKERU_TOOL_CATALOG,
} from "./akeruTools/catalog.ts";

export interface AkeruToolAvailabilityContext {
  readonly capabilities: ReadonlySet<AkeruToolCapability>;
  readonly workspaceType: AkeruToolWorkspaceType;
  readonly hasUserComputer: boolean;
  readonly localFullAccess: boolean;
  readonly implementedTools: ReadonlySet<string>;
  readonly delegationDepth?: number;
  readonly activeDelegations?: number;
  /** 0 for a bot turn, 1 inside a temporary worker. */
  readonly workerDepth?: number;
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

    if (tool.id === "Task" && (context.workerDepth ?? 0) >= AKERU_WORKER_MAX_DEPTH) return false;

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
    Predicate.isString(input.command)
  ) {
    const protectedClass = classifyAkeruExternalCommand(input.command);

    if (protectedClass) return protectedClass;
  }

  if (tool.id === "ExternalRead" && "path" in input && Predicate.isString(input.path)) {
    return classifyAkeruSensitivePath(input.path) ?? tool.approval;
  }

  if (tool.id === "CopyToBox" && "sourcePath" in input && Predicate.isString(input.sourcePath)) {
    return classifyAkeruSensitivePath(input.sourcePath) ?? tool.approval;
  }

  if (tool.id === "CopyFromBox" && "sourcePath" in input && Predicate.isString(input.sourcePath)) {
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

export {
  AKERU_COMMAND_MAX_CHARS,
  AKERU_PATH_MAX_CHARS,
  AkeruAwaitHandleId,
  AkeruPluginRecommendation,
  AkeruPluginSearchResult,
  AkeruComputerBoundary,
  AKERU_DELEGATION_CONTEXT_MAX_CHARS,
  AkeruToolInputSchemas,
  AkeruMessageReactionResult,
  decodeAkeruToolInput,
} from "./akeruTools/inputs.ts";

export {
  AkeruToolId,
  AkeruToolApprovalClass,
  AkeruProtectedApprovalClass,
  AKERU_PROTECTED_APPROVAL_CLASSES,
  AkeruToolCapability,
  AkeruToolWorkspaceType,
  type AkeruToolWorkspaceRequirement,
  type AkeruCopyDirection,
  type AkeruToolDefinition,
  AKERU_TOOL_CATALOG,
} from "./akeruTools/catalog.ts";

export {
  AkeruToolReceiptPhase,
  AkeruToolFailureCode,
  AkeruToolReceipt,
} from "./akeruTools/receipts.ts";
