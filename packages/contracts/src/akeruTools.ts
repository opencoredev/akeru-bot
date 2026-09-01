import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  BotId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

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
  SendToAgent: Schema.Struct({
    botId: BotId,
    task: TrimmedNonEmptyString,
    expectedResult: TrimmedNonEmptyString,
  }),
} as const;
export type AkeruToolId = keyof typeof AkeruToolInputSchemas;

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
  define("SendToAgent", "bot-workspace", "Delegate a task to another bot.", {
    approval: "send",
  }),
] satisfies ReadonlyArray<AkeruToolDefinition>;

export interface AkeruToolAvailabilityContext {
  readonly capabilities: ReadonlySet<AkeruToolCapability>;
  readonly workspaceType: AkeruToolWorkspaceType;
  readonly hasUserComputer: boolean;
  readonly localFullAccess: boolean;
  readonly implementedTools: ReadonlySet<string>;
}

export function filterAkeruTools(
  context: AkeruToolAvailabilityContext,
): ReadonlyArray<AkeruToolDefinition> {
  return AKERU_TOOL_CATALOG.filter((tool) => {
    if (!context.capabilities.has(tool.capability)) return false;
    if (!context.implementedTools.has(tool.id)) return false;
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
  return Schema.decodeUnknownSync(AkeruToolInputSchemas[toolId])(input, {
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
