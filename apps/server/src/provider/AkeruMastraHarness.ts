import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { openaiCodexProvider } from "@mastra/code-sdk/providers/openai-codex";
import type { ToolsInput } from "@mastra/core/agent";
import {
  AgentController as MastraAgentController,
  type Session,
} from "@mastra/core/agent-controller";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import type { StandardSchemaWithJSON } from "@mastra/core/schema";
import { createTool, type NeedsApprovalFn } from "@mastra/core/tools";
import {
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  ProductFeedbackToolDraft,
  classifyAkeruExternalCommand,
  classifyAkeruSensitivePath,
  type ProviderDriverKind,
  type ProductFeedbackToolDraft as ProductFeedbackToolDraftValue,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { AKERU_AGENT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";
import { akeruKimiProvider, type AkeruKimiAccess } from "./AkeruKimiProvider.ts";
import { createAkeruMastraTools } from "./AkeruMastraTools.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";

const DEFAULT_MODEL_ID = "openai/gpt-5.6-sol";
const decodeProductFeedbackToolDraft = Schema.decodeUnknownExit(ProductFeedbackToolDraft, {
  onExcessProperty: "error",
});
const productFeedbackToolJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    feedback: { type: "string", minLength: 1, maxLength: 4_000 },
  },
  required: ["feedback"],
} as const;

export const productFeedbackToolInputSchema: StandardSchemaWithJSON<ProductFeedbackToolDraftValue> =
  {
    "~standard": {
      version: 1,
      vendor: "akeru-effect",
      validate: (value) => {
        const decoded = decodeProductFeedbackToolDraft(value);
        return Exit.isSuccess(decoded)
          ? { value: decoded.value }
          : { issues: [{ message: "Invalid product feedback draft." }] };
      },
      jsonSchema: {
        input: () => productFeedbackToolJsonSchema,
        output: () => productFeedbackToolJsonSchema,
      },
    },
  };

const productFeedbackTool = createTool({
  id: AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  description:
    "Draft anonymous Akeru Bot product feedback for the user to review and send. This tool never sends feedback.",
  inputSchema: productFeedbackToolInputSchema,
  requireApproval: true,
  execute: async () => ({ status: "draft-opened" as const }),
});

export interface AkeruMastraState {
  readonly projectPath?: string;
  readonly yolo?: boolean;
}

export type AkeruMastraSession = Session<AkeruMastraState>;

export interface AkeruMastraHarnessOptions {
  readonly authStorage: AuthStorage;
  readonly getKimiAccess?: () => Promise<AkeruKimiAccess | undefined>;
  readonly getThreadTools: (threadId: string) => ToolsInput;
  readonly syncThreadToolApproval?: (
    threadId: string,
    toolName: string,
    protectedAction: boolean,
  ) => Promise<void>;
  readonly toolRuntime: AkeruToolRuntime;
}

export interface AkeruMastraHarness {
  readonly controller: Pick<
    MastraAgentController<AkeruMastraState>,
    "init" | "createSession" | "deleteSession" | "destroy"
  >;
  readonly destroy: () => void;
}

function controllerContext(requestContext: RequestContext): Record<string, unknown> | undefined {
  const value = requestContext.getRaw("controller");
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function controllerModelId(requestContext: RequestContext): string {
  const value = controllerContext(requestContext);
  if (!value || !("session" in value)) return DEFAULT_MODEL_ID;
  const session = value.session;
  if (typeof session !== "object" || session === null || !("modelId" in session)) {
    return DEFAULT_MODEL_ID;
  }
  return typeof session.modelId === "string" ? session.modelId : DEFAULT_MODEL_ID;
}

function controllerResourceId(requestContext: RequestContext): string | undefined {
  const value = controllerContext(requestContext)?.resourceId;
  return typeof value === "string" ? value : undefined;
}

const MASTRA_MODEL_PREFIX = {
  codex: "openai",
  kimi: "kimi-for-coding",
} as const;

export function mastraModelId(provider: ProviderDriverKind, model: string): string {
  const trimmed = model.trim();
  const prefix = MASTRA_MODEL_PREFIX[provider as keyof typeof MASTRA_MODEL_PREFIX];
  if (!prefix) return trimmed.includes("/") ? trimmed : `${provider}/${trimmed}`;
  const token = `${prefix}/`;
  return trimmed.startsWith(token) ? trimmed : `${token}${trimmed}`;
}

export function resolveAkeruMastraModel(
  modelId: string,
  authStorage: AuthStorage,
  getKimiAccess?: () => Promise<AkeruKimiAccess | undefined>,
) {
  const trimmed = modelId.trim();
  if (trimmed.startsWith("openai/")) {
    return openaiCodexProvider(trimmed.slice("openai/".length), { authStorage });
  }
  if (trimmed.startsWith("kimi-for-coding/")) {
    if (!getKimiAccess) throw new Error("Kimi For Coding subscription access is unavailable.");
    return akeruKimiProvider(trimmed.slice("kimi-for-coding/".length), getKimiAccess);
  }
  throw new Error(`Mastra has no subscription transport for model '${modelId}'.`);
}

export async function resolveAkeruTools(
  requestContext: RequestContext,
  options: AkeruMastraHarnessOptions,
): Promise<ToolsInput> {
  const threadId = controllerResourceId(requestContext);
  if (!threadId) return {};
  return {
    ...approvalAwareTools(threadId, options.getThreadTools(threadId), options),
    ...createAkeruMastraTools(threadId, options.toolRuntime),
    [AKERU_PRODUCT_FEEDBACK_TOOL_NAME]: productFeedbackTool,
  };
}

function approvalAwareTools(
  threadId: string,
  tools: ToolsInput,
  options: AkeruMastraHarnessOptions,
): ToolsInput {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const configured = tool as unknown as {
        readonly requireApproval?: boolean | NeedsApprovalFn;
        readonly needsApprovalFn?: NeedsApprovalFn;
      };
      const existing = configured.needsApprovalFn ?? configured.requireApproval;
      const needsApproval: NeedsApprovalFn = async (input, context) => {
        const protectedAction = akeruActionNeedsApproval(name, input);
        await options.syncThreadToolApproval?.(threadId, name, protectedAction);
        return (
          protectedAction ||
          (typeof existing === "function" ? await existing(input, context) : existing === true)
        );
      };
      return [name, { ...tool, requireApproval: needsApproval, needsApprovalFn: needsApproval }];
    }),
  );
}

export type AkeruToolCategory = "read" | "edit" | "execute" | "mcp" | "other";
export type AkeruCriticalAction =
  | "send"
  | "pay"
  | "delete"
  | "production"
  | "secrets"
  | "publish"
  | "sign"
  | "refund"
  | "account";

const CRITICAL_ACTION_TOKENS: ReadonlyArray<readonly [AkeruCriticalAction, ReadonlySet<string>]> = [
  ["send", new Set(["send", "reply", "dispatch", "deliver"])],
  ["pay", new Set(["pay", "charge", "purchase", "checkout", "transfer"])],
  ["delete", new Set(["delete", "remove", "destroy", "erase", "purge"])],
  ["production", new Set(["deploy", "release", "promote", "prod", "production"])],
  ["secrets", new Set(["secret", "secrets", "credential", "credentials", "password", "token"])],
  ["publish", new Set(["publish", "post", "broadcast"])],
  ["sign", new Set(["sign", "signature", "countersign"])],
  ["refund", new Set(["refund", "reimburse", "reimbursement"])],
];

const ACCOUNT_SCOPE_TOKENS = new Set(["account", "organization", "workspace", "tenant"]);
const CHANGE_TOKENS = new Set([
  "change",
  "create",
  "disable",
  "enable",
  "invite",
  "remove",
  "rename",
  "reset",
  "set",
  "update",
]);
const MUTATING_INTENT_KEYS = new Set([
  "action",
  "intent",
  "method",
  "operation",
  "requesttype",
  "verb",
]);
const ACTION_TEXT_KEYS = new Set([...MUTATING_INTENT_KEYS, "command", "deliverymode"]);
const READ_ONLY_INTENT_TOKENS = new Set([
  "find",
  "get",
  "inspect",
  "list",
  "read",
  "search",
  "stat",
  "status",
  "view",
]);

function textTokens(value: string): ReadonlySet<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );
}

function criticalActionFromText(value: string): AkeruCriticalAction | null {
  const tokens = textTokens(value);
  if (tokens.has("restart") && tokens.has("mcp")) return "production";
  for (const [action, actionTokens] of CRITICAL_ACTION_TOKENS) {
    if ([...actionTokens].some((token) => tokens.has(token))) return action;
  }
  if (
    [...ACCOUNT_SCOPE_TOKENS].some((token) => tokens.has(token)) &&
    [...CHANGE_TOKENS].some((token) => tokens.has(token))
  ) {
    return "account";
  }
  return null;
}

type AkeruActionInspection = {
  readonly action: AkeruCriticalAction | null;
  readonly hasUnclassifiedIntent: boolean;
};

function inspectAkeruAction(toolName: string, args?: unknown): AkeruActionInspection {
  const namedAction = criticalActionFromText(toolName);
  if (namedAction) return { action: namedAction, hasUnclassifiedIntent: false };

  const pending: unknown[] = [args];
  let inspected = 0;
  let hasUnclassifiedIntent = false;
  while (pending.length > 0 && inspected < 100) {
    const value = pending.pop();
    inspected += 1;
    if (Array.isArray(value)) {
      pending.push(...value.filter((entry) => typeof entry === "object" && entry !== null));
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.toLowerCase();
      const keyedAction = criticalActionFromText(key);
      if (keyedAction) return { action: keyedAction, hasUnclassifiedIntent: false };
      if (ACTION_TEXT_KEYS.has(normalizedKey) && typeof entry === "string") {
        if (normalizedKey === "command") {
          const action = classifyAkeruExternalCommand(entry);
          if (action) return { action, hasUnclassifiedIntent: false };
        }
        const action = criticalActionFromText(entry);
        if (action) return { action, hasUnclassifiedIntent: false };
        if (MUTATING_INTENT_KEYS.has(normalizedKey)) {
          const tokens = textTokens(entry);
          if (![...tokens].some((token) => READ_ONLY_INTENT_TOKENS.has(token))) {
            hasUnclassifiedIntent = true;
          }
        }
      }
      if (
        typeof entry === "string" &&
        (normalizedKey === "path" || normalizedKey.endsWith("path")) &&
        classifyAkeruSensitivePath(entry)
      ) {
        return { action: "secrets", hasUnclassifiedIntent: false };
      }
      if (typeof entry === "object" && entry !== null) pending.push(entry);
    }
  }
  return { action: null, hasUnclassifiedIntent };
}

export function criticalAkeruAction(toolName: string, args?: unknown): AkeruCriticalAction | null {
  return inspectAkeruAction(toolName, args).action;
}

export function akeruActionNeedsApproval(toolName: string, args?: unknown): boolean {
  const inspection = inspectAkeruAction(toolName, args);
  return inspection.action !== null || inspection.hasUnclassifiedIntent;
}

export function akeruToolCategory(toolName: string): AkeruToolCategory {
  if (/read|view|grep|search|find|list|stat/i.test(toolName)) return "read";
  if (/edit|write|delete|mkdir|move|rename/i.test(toolName)) return "edit";
  if (/execute|command|shell|process|terminal/i.test(toolName)) return "execute";
  if (/mcp/i.test(toolName)) return "mcp";
  return "other";
}

export async function createAkeruMastraHarness(
  options: AkeruMastraHarnessOptions,
): Promise<AkeruMastraHarness> {
  const agent = createCodingAgent({
    id: "akeru-agent",
    name: "Akeru",
    instructions: AKERU_AGENT_INSTRUCTIONS,
    model: ({ requestContext }) =>
      resolveAkeruMastraModel(
        controllerModelId(requestContext),
        options.authStorage,
        options.getKimiAccess,
      ),
    tools: ({ requestContext }) => resolveAkeruTools(requestContext, options),
    workspace: undefined,
  });

  const controller = new MastraAgentController<AkeruMastraState>({
    id: "akeru-codex",
    agent,
    modes: [
      { id: "build", name: "Build", defaultModelId: DEFAULT_MODEL_ID },
      {
        id: "plan",
        name: "Plan",
        defaultModelId: DEFAULT_MODEL_ID,
        instructions: "Inspect and explain. Do not change files or run mutating commands.",
      },
    ],
    defaultModeId: "build",
    disableBuiltinTools: [
      "submit_plan",
      "task_write",
      "task_update",
      "task_complete",
      "task_check",
      "subagent",
    ],
    toolCategoryResolver: akeruToolCategory,
    intervalHandlers: [],
  });

  return {
    controller,
    destroy: () => undefined,
  };
}
