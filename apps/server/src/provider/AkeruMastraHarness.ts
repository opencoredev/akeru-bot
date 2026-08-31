import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { openaiCodexProvider } from "@mastra/code-sdk/providers/openai-codex";
import type { ToolsInput } from "@mastra/core/agent";
import {
  AgentController as MastraAgentController,
  type Session,
} from "@mastra/core/agent-controller";
import { createCodingAgent } from "@mastra/core/coding-agent";
import type { RequestContext } from "@mastra/core/request-context";
import { createWorkspaceTools, type Workspace } from "@mastra/core/workspace";

import { AKERU_AGENT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";

const DEFAULT_MODEL_ID = "openai/gpt-5.6-sol";

export interface AkeruMastraState {
  readonly projectPath?: string;
  readonly yolo?: boolean;
}

export type AkeruMastraSession = Session<AkeruMastraState>;

export interface AkeruMastraHarnessOptions {
  readonly authStorage: AuthStorage;
  readonly getThreadTools: (threadId: string) => ToolsInput;
  readonly getThreadWorkspace: (threadId: string) => Workspace | undefined;
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

function codexModelName(modelId: string): string {
  return modelId.startsWith("openai/") ? modelId.slice("openai/".length) : modelId;
}

export async function resolveAkeruTools(
  requestContext: RequestContext,
  options: AkeruMastraHarnessOptions,
): Promise<ToolsInput> {
  const threadId = controllerResourceId(requestContext);
  if (!threadId) return {};
  const workspace = options.getThreadWorkspace(threadId);
  const workspaceTools = workspace
    ? await createWorkspaceTools(workspace, {
        requestContext: Object.fromEntries(requestContext.entries()),
        workspace,
      })
    : {};
  return { ...workspaceTools, ...options.getThreadTools(threadId) };
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
        const action = criticalActionFromText(entry);
        if (action) return { action, hasUnclassifiedIntent: false };
        if (MUTATING_INTENT_KEYS.has(normalizedKey)) {
          const tokens = textTokens(entry);
          if (![...tokens].some((token) => READ_ONLY_INTENT_TOKENS.has(token))) {
            hasUnclassifiedIntent = true;
          }
        }
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
      openaiCodexProvider(codexModelName(controllerModelId(requestContext)), {
        authStorage: options.authStorage,
      }),
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
