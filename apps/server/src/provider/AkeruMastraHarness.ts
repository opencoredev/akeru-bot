// @effect-diagnostics nodeBuiltinImport:off
import * as NodeURL from "node:url";

import { AuthStorage } from "@mastra/code-sdk/auth/storage";
import { openaiCodexProvider } from "@mastra/code-sdk/providers/openai-codex";
import type { ToolsInput } from "@mastra/core/agent";
import {
  AgentController as MastraAgentController,
  type Session,
} from "@mastra/core/agent-controller";
import { createCodingAgent } from "@mastra/core/coding-agent";
import { RequestContext } from "@mastra/core/request-context";
import type {
  Processor,
  ProcessInputStepArgs,
  ProcessOutputResultArgs,
} from "@mastra/core/processors";
import type { StandardSchemaWithJSON } from "@mastra/core/schema";
import { createTool, type NeedsApprovalFn } from "@mastra/core/tools";
import { LibSQLStore } from "@mastra/libsql";
import { Memory } from "@mastra/memory";
import {
  ObservationalMemory,
  OBSERVATION_CONTINUATION_HINT,
  type ObserveHooks,
} from "@mastra/memory/processors";
import {
  AKERU_PRODUCT_FEEDBACK_TOOL_NAME,
  AKERU_CREATE_ROUTINE_TOOL_NAME,
  AkeruCreateRoutineInput,
  ProductFeedbackToolDraft,
  classifyAkeruExternalCommand,
  classifyAkeruSensitivePath,
  type AkeruConversationMemorySnapshot,
  type ProviderDriverKind,
  type ProductFeedbackToolDraft as ProductFeedbackToolDraftValue,
  type AkeruCreateRoutineInput as AkeruCreateRoutineInputValue,
} from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { z } from "zod";

import { AKERU_AGENT_INSTRUCTIONS, AKERU_BOT_INSTRUCTIONS } from "./AkeruAgentInstructions.ts";
import { akeruKimiProvider, type AkeruKimiAccess } from "./AkeruKimiProvider.ts";
import { akeruOpenCodeGoProvider } from "./AkeruOpenCodeGoProvider.ts";
import { createAkeruMastraTools } from "./AkeruMastraTools.ts";
import type { AkeruToolRuntime } from "./AkeruToolRuntime.ts";
import { isCodexComputerUseTool } from "./CodexComputerUse.ts";

const DEFAULT_MODEL_ID = "openai/gpt-5.6-sol";
export const AKERU_RECENT_MESSAGE_LIMIT = 10;
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

const routineTime = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const AKERU_LIST_ROUTINES_TOOL_NAME = "akeru_list_routines";
export const AKERU_DELETE_ROUTINES_TOOL_NAME = "akeru_delete_routines";
export const routineToolInputSchema = z.object({
  name: z.string().trim().min(1),
  instructions: z.string().trim().min(1),
  schedule: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("daily"), time: routineTime }),
    z.object({ kind: z.literal("weekdays"), time: routineTime }),
    z.object({
      kind: z.literal("weekly"),
      weekdays: z
        .array(
          z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]),
        )
        .min(1),
      time: routineTime,
    }),
  ]),
  skillNames: z.array(z.string().trim().min(1)).nullish(),
  connectorNames: z.array(z.string().trim().min(1)).nullish(),
});
const routineListOutputSchema = z.object({
  routines: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      enabled: z.boolean(),
      lifecycle: z.enum([
        "draft",
        "approved",
        "enabled",
        "running",
        "paused",
        "blocked",
        "failed",
        "completed",
      ]),
    }),
  ),
});
export type AkeruRoutineListResult = z.infer<typeof routineListOutputSchema>;
const routineDeleteResultSchema = z.object({
  status: z.enum(["deleted", "cancelled", "not-found"]),
  deletedRoutineIds: z.array(z.string()),
});
export type AkeruRoutineDeleteResult = z.infer<typeof routineDeleteResultSchema>;

export interface AkeruMastraState {
  readonly projectPath?: string;
  readonly yolo?: boolean;
  readonly botConversation?: boolean;
}

export type AkeruMastraSession = Session<AkeruMastraState>;

export interface AkeruMastraHarnessOptions {
  readonly authStorage: AuthStorage;
  readonly getKimiAccess?: () => Promise<AkeruKimiAccess | undefined>;
  readonly getOpenCodeGoApiKey?: () => Promise<string | undefined>;
  readonly memoryDbPath: string;
  readonly startMemoryCall?: (input: {
    readonly threadId: string;
    readonly category: "observer" | "reflector";
  }) => Promise<string | undefined>;
  readonly finishMemoryCall?: (input: {
    readonly callId: string;
    readonly category: "observer" | "reflector";
    readonly usage?: {
      readonly inputTokens?: number;
      readonly outputTokens?: number;
      readonly totalTokens?: number;
    };
    readonly error?: Error;
  }) => Promise<void>;
  readonly getThreadTools: (threadId: string) => ToolsInput;
  readonly syncThreadToolApproval?: (
    threadId: string,
    toolName: string,
    protectedAction: boolean,
  ) => Promise<void>;
  readonly toolRuntime: AkeruToolRuntime;
  readonly createRoutine?: (
    threadId: string,
    input: AkeruCreateRoutineInputValue,
  ) => Promise<unknown>;
  readonly listRoutines?: (threadId: string) => Promise<AkeruRoutineListResult>;
  readonly deleteRoutines?: (
    threadId: string,
    routineIds: ReadonlyArray<string>,
  ) => Promise<AkeruRoutineDeleteResult>;
}

export interface AkeruMastraHarness {
  readonly controller: Pick<
    MastraAgentController<AkeruMastraState>,
    "init" | "createSession" | "deleteSession" | "destroy"
  >;
  readonly clearObservationalMemory?: (threadId: string, resourceId?: string) => Promise<void>;
  readonly readObservationalMemory?: (
    threadId: string,
    resourceId?: string,
  ) => Promise<AkeruConversationMemorySnapshot>;
  readonly observeAfterTurn?: (input: AkeruBackgroundObservationInput) => Promise<void>;
  readonly destroy: () => void | Promise<void>;
}

export interface AkeruBackgroundObservationInput {
  readonly threadId: string;
  readonly resourceId?: string;
  readonly modelId: string;
  readonly hooks?: ObserveHooks;
}

type AkeruMastraToolOptions = Pick<
  AkeruMastraHarnessOptions,
  | "authStorage"
  | "getKimiAccess"
  | "getOpenCodeGoApiKey"
  | "getThreadTools"
  | "syncThreadToolApproval"
  | "toolRuntime"
  | "createRoutine"
  | "listRoutines"
  | "deleteRoutines"
>;

export function createAkeruObserveHooks(
  options: Pick<AkeruMastraHarnessOptions, "startMemoryCall" | "finishMemoryCall">,
): ObserveHooks {
  const active = new Map<string, string>();
  const start = async (threadId: string | undefined, category: "observer" | "reflector") => {
    if (!threadId) return;
    const callId = await options.startMemoryCall?.({ threadId, category });
    if (callId) active.set(`${threadId}:${category}`, callId);
  };
  const finish = async (
    category: "observer" | "reflector",
    result: Parameters<NonNullable<ObserveHooks["onObservationEnd"]>>[0],
  ) => {
    if (!result.threadId) return;
    const key = `${result.threadId}:${category}`;
    const callId = active.get(key);
    if (!callId) return;
    active.delete(key);
    await options.finishMemoryCall?.({
      callId,
      category,
      ...(result.usage ? { usage: result.usage } : {}),
      ...(result.error ? { error: result.error } : {}),
    });
  };
  return {
    onObservationStart: ({ threadId } = {}) => start(threadId, "observer"),
    onObservationEnd: (result) => finish("observer", result),
    onReflectionStart: ({ threadId } = {}) => start(threadId, "reflector"),
    onReflectionEnd: (result) => finish("reflector", result),
  };
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

export class AkeruPassiveObservationalMemoryProcessor implements Processor<"observational-memory"> {
  readonly id = "observational-memory" as const;
  readonly name = "Akeru Observational Memory";
  readonly engine: ObservationalMemory;
  private readonly memory: Memory;

  constructor(engine: ObservationalMemory, memory: Memory) {
    this.engine = engine;
    this.memory = memory;
  }

  async processInputStep(args: ProcessInputStepArgs) {
    if (args.stepNumber !== 0) return args.messageList;
    const context = this.engine.getThreadContext(args.requestContext, args.messageList);
    if (!context) return args.messageList;
    const recent = await this.memory.recall({ threadId: context.threadId });
    for (const message of recent.messages) {
      if (message.role !== "system") args.messageList.add(message, "memory");
    }
    const record = await this.engine.getOrCreateRecord(context.threadId, context.resourceId);
    const chunks = await this.engine.buildContextSystemMessages({ ...context, record });
    args.messageList.clearSystemMessages("observational-memory");
    for (const chunk of chunks ?? []) args.messageList.addSystem(chunk, "observational-memory");
    args.messageList.clearSystemMessages("om-continuation");
    if (record.activeObservations) {
      args.messageList.addSystem(
        `<system-reminder>${OBSERVATION_CONTINUATION_HINT}</system-reminder>`,
        "om-continuation",
      );
    }
    return args.messageList;
  }

  async processOutputResult(args: ProcessOutputResultArgs) {
    const messages = [
      ...args.messageList.get.input.db(),
      ...args.messageList.get.response.db(),
    ].filter((message) => args.messageList.isNewMessage(message));
    if (messages.length > 0) await this.memory.persistMessages(messages);
    return args.messageList;
  }
}

export async function createAkeruMastraMemory(
  options: Pick<
    AkeruMastraHarnessOptions,
    "authStorage" | "getKimiAccess" | "getOpenCodeGoApiKey" | "memoryDbPath"
  >,
) {
  const storage = new LibSQLStore({
    id: "akeru-observational-memory",
    url: NodeURL.pathToFileURL(options.memoryDbPath).toString(),
    connectionTimeoutMs: 5_000,
  });
  await storage.init();
  const model = ({ requestContext }: { readonly requestContext: RequestContext }) =>
    resolveAkeruMastraModel(
      controllerModelId(requestContext),
      options.authStorage,
      options.getKimiAccess,
      options.getOpenCodeGoApiKey,
    );
  const memory = new Memory({
    storage,
    options: {
      lastMessages: AKERU_RECENT_MESSAGE_LIMIT,
      semanticRecall: false,
      workingMemory: { enabled: false },
      observationalMemory: false,
    },
  });
  const memoryStore = await storage.getStore("memory");
  if (!memoryStore?.supportsObservationalMemory) {
    await storage.close();
    throw new Error("The configured memory store does not support observational memory.");
  }
  const engine = new ObservationalMemory({
    storage: memoryStore,
    memory,
    scope: "thread",
    model,
    retrieval: false,
    hookExecution: "await",
    observation: {
      bufferTokens: false,
      bufferOnIdle: false,
      continuationHints: { currentTask: true, suggestedResponse: true },
    },
    reflection: {
      continuationHints: { currentTask: true, suggestedResponse: true },
    },
  });
  const processor = new AkeruPassiveObservationalMemoryProcessor(engine, memory);
  let closePromise: Promise<void> | undefined;
  return {
    memory,
    storage,
    engine,
    processor,
    close: async () => {
      closePromise ??= (async () => {
        await engine.settled();
        await storage.close();
      })();
      await closePromise;
    },
  };
}

const MASTRA_MODEL_PREFIX = {
  codex: "openai",
  kimi: "kimi-for-coding",
  opencodeGo: "opencode-go",
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
  getOpenCodeGoApiKey?: () => Promise<string | undefined>,
) {
  const trimmed = modelId.trim();
  if (trimmed.startsWith("openai/")) {
    return openaiCodexProvider(trimmed.slice("openai/".length), { authStorage });
  }
  if (trimmed.startsWith("kimi-for-coding/")) {
    if (!getKimiAccess) throw new Error("Kimi For Coding subscription access is unavailable.");
    return akeruKimiProvider(trimmed.slice("kimi-for-coding/".length), getKimiAccess);
  }
  if (trimmed.startsWith("opencode-go/")) {
    if (!getOpenCodeGoApiKey) throw new Error("OpenCode Go subscription access is unavailable.");
    return akeruOpenCodeGoProvider(trimmed.slice("opencode-go/".length), getOpenCodeGoApiKey);
  }
  throw new Error(`Mastra has no subscription transport for model '${modelId}'.`);
}

export function resolveAkeruInstructions(requestContext: RequestContext): string {
  const state = controllerContext(requestContext)?.state;
  return typeof state === "object" &&
    state !== null &&
    "botConversation" in state &&
    state.botConversation === true
    ? AKERU_BOT_INSTRUCTIONS
    : AKERU_AGENT_INSTRUCTIONS;
}

export async function resolveAkeruTools(
  requestContext: RequestContext,
  options: AkeruMastraToolOptions,
): Promise<ToolsInput> {
  const threadId = controllerResourceId(requestContext);
  if (!threadId) return {};
  const routineTool = options.createRoutine
    ? createTool({
        id: AKERU_CREATE_ROUTINE_TOOL_NAME,
        description:
          "Create a disabled routine for recurring work in this chat. Call this tool as soon as the routine details are complete. The app previews the tool arguments and asks the user before execution, so do not ask for separate confirmation. Use the current chat and device timezone by default. Only name plugins or skills the user explicitly requests.",
        inputSchema: routineToolInputSchema,
        requireApproval: false,
        execute: async ({ skillNames, connectorNames, ...input }) =>
          options.createRoutine!(
            threadId,
            await Schema.decodeUnknownPromise(AkeruCreateRoutineInput)(
              {
                ...input,
                ...(skillNames ? { skillNames } : {}),
                ...(connectorNames ? { connectorNames } : {}),
              },
              {
                onExcessProperty: "error",
              },
            ),
          ),
      })
    : undefined;
  const listRoutinesTool = options.listRoutines
    ? createTool({
        id: AKERU_LIST_ROUTINES_TOOL_NAME,
        description:
          "List this bot's routines and show whether each schedule is enabled or disabled, plus its exact lifecycle. Use this before answering questions about routine state.",
        inputSchema: z.object({}),
        outputSchema: routineListOutputSchema,
        strict: true,
        requireApproval: false,
        execute: async () => options.listRoutines!(threadId),
      })
    : undefined;
  const deleteRoutinesTool =
    options.listRoutines && options.deleteRoutines
      ? createTool({
          id: AKERU_DELETE_ROUTINES_TOOL_NAME,
          description:
            "Delete one or more routines owned by this bot. Pass routine IDs from akeru_list_routines. This tool asks the user for confirmation before deleting anything, so do not ask for separate confirmation.",
          inputSchema: z.object({
            routineIds: z.array(z.string().trim().min(1)).min(1),
          }),
          outputSchema: routineDeleteResultSchema,
          suspendSchema: z.object({
            question: z.string(),
            options: z.array(
              z.object({
                label: z.string(),
                description: z.string(),
              }),
            ),
            selectionMode: z.literal("single_select"),
          }),
          resumeSchema: z.string(),
          strict: true,
          requireApproval: false,
          execute: async ({ routineIds }, context) => {
            const uniqueIds = [...new Set(routineIds)];
            const available = await options.listRoutines!(threadId);
            const requested = available.routines.filter((routine) =>
              uniqueIds.includes(routine.id),
            );
            if (requested.length !== uniqueIds.length) {
              return { status: "not-found" as const, deletedRoutineIds: [] };
            }
            const answer = context?.agent?.resumeData;
            if (answer === undefined) {
              const suspend = context?.agent?.suspend;
              if (!suspend) return { status: "cancelled" as const, deletedRoutineIds: [] };
              const names = requested.map((routine) => `"${routine.name}"`).join(", ");
              await suspend({
                question:
                  requested.length === 1
                    ? `Are you sure you want to delete ${names}?`
                    : `Are you sure you want to delete these routines: ${names}?`,
                options: [
                  {
                    label: "Delete routines",
                    description: "Stop these schedules and hide them from the routines list.",
                  },
                  { label: "Cancel", description: "Keep every routine." },
                ],
                selectionMode: "single_select",
              });
              return;
            }
            if (answer !== "Delete routines") {
              return { status: "cancelled" as const, deletedRoutineIds: [] };
            }
            return options.deleteRoutines!(threadId, uniqueIds);
          },
        })
      : undefined;
  return {
    ...approvalAwareTools(threadId, options.getThreadTools(threadId), options),
    ...createAkeruMastraTools(threadId, options.toolRuntime),
    [AKERU_PRODUCT_FEEDBACK_TOOL_NAME]: productFeedbackTool,
    ...(routineTool ? { [AKERU_CREATE_ROUTINE_TOOL_NAME]: routineTool } : {}),
    ...(listRoutinesTool ? { [AKERU_LIST_ROUTINES_TOOL_NAME]: listRoutinesTool } : {}),
    ...(deleteRoutinesTool ? { [AKERU_DELETE_ROUTINES_TOOL_NAME]: deleteRoutinesTool } : {}),
  };
}

function approvalAwareTools(
  threadId: string,
  tools: ToolsInput,
  options: AkeruMastraToolOptions,
): ToolsInput {
  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const configured = tool as unknown as {
        readonly requireApproval?: boolean | NeedsApprovalFn;
        readonly needsApprovalFn?: NeedsApprovalFn;
      };
      const existing = configured.needsApprovalFn ?? configured.requireApproval;
      const needsApproval: NeedsApprovalFn = async (input, context) => {
        const protectedAction =
          isCodexComputerUseTool(name) || akeruActionNeedsApproval(name, input);
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
const CRITICAL_SHELL_ACTIONS: ReadonlyArray<readonly [AkeruCriticalAction, RegExp]> = [
  [
    "delete",
    /(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|rmdir|unlink)\b|\b(?:drop|truncate)\s+(?:database|schema|table)\b|\bdelete\s+from\b/i,
  ],
  ["publish", /(?:^|[;&|]\s*)git\s+push\b/i],
  [
    "production",
    /(?:^|[;&|]\s*)(?:kubectl\s+(?:apply|delete|replace|rollout)|terraform\s+(?:apply|destroy)|docker\s+push)\b/i,
  ],
  [
    "secrets",
    /(?:^|[;&|]\s*)(?:(?:printenv|env)(?:\s|$)|(?:cat|head|tail|less|more|sed|awk|grep|rg)\b[^\n;&|]*(?:\.env\b|\/\.ssh\/id_[\w-]+|credentials?|secrets?|tokens?)|gh\s+auth\s+token|security\s+find-(?:generic|internet)-password|op\s+(?:read|get)|vault\s+(?:kv\s+)?get|aws\s+secretsmanager\s+get-secret-value|gcloud\s+secrets\s+versions\s+access|kubectl\s+get\s+secrets?)\b/i,
  ],
  [
    "send",
    /(?:^|[;&|]\s*)(?:(?:mail|mailx)\b|curl\b[^\n;&|]*(?:--data(?:-raw|-binary)?|-d\b|--form|-F\b|--request\s+post|-X\s*post))/i,
  ],
];

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

function criticalActionFromShellCommand(value: string): AkeruCriticalAction | null {
  for (const [action, pattern] of CRITICAL_SHELL_ACTIONS) {
    if (pattern.test(value)) return action;
  }
  return criticalActionFromText(value);
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
        const action =
          normalizedKey === "command"
            ? criticalActionFromShellCommand(entry)
            : criticalActionFromText(entry);
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
  return { action: null, hasUnclassifiedIntent: hasUnclassifiedIntent || pending.length > 0 };
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

export function routineToolNeedsGlobalApproval(toolName: string): boolean {
  return (
    toolName !== AKERU_CREATE_ROUTINE_TOOL_NAME &&
    toolName !== AKERU_LIST_ROUTINES_TOOL_NAME &&
    toolName !== AKERU_DELETE_ROUTINES_TOOL_NAME
  );
}

export async function createAkeruMastraHarness(
  options: AkeruMastraHarnessOptions,
): Promise<AkeruMastraHarness> {
  const observationalMemory = await createAkeruMastraMemory(options);
  const observeHooks = createAkeruObserveHooks(options);
  const observationTails = new Map<string, Promise<void>>();
  let closing = false;
  const agent = createCodingAgent({
    id: "akeru-agent",
    name: "Akeru",
    instructions: ({ requestContext }) => resolveAkeruInstructions(requestContext),
    model: ({ requestContext }) =>
      resolveAkeruMastraModel(
        controllerModelId(requestContext),
        options.authStorage,
        options.getKimiAccess,
        options.getOpenCodeGoApiKey,
      ),
    tools: ({ requestContext }) => resolveAkeruTools(requestContext, options),
    memory: observationalMemory.memory,
    inputProcessors: [observationalMemory.processor],
    outputProcessors: [observationalMemory.processor],
    workspace: undefined,
  });

  const controller = new MastraAgentController<AkeruMastraState>({
    id: "akeru-codex",
    agent,
    storage: observationalMemory.storage,
    memory: observationalMemory.memory,
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
  const controllerWithRunOptions = controller as unknown as {
    buildSharedRunOptions: (session: unknown) => {
      readonly requireToolApproval?: boolean | ((input: { readonly toolName: string }) => boolean);
      readonly [key: string]: unknown;
    };
  };
  const buildSharedRunOptions = controllerWithRunOptions.buildSharedRunOptions.bind(controller);
  controllerWithRunOptions.buildSharedRunOptions = (session) => {
    const runOptions = buildSharedRunOptions(session);
    if (runOptions.requireToolApproval !== true) return runOptions;
    return {
      ...runOptions,
      requireToolApproval: ({ toolName }) => routineToolNeedsGlobalApproval(toolName),
    };
  };

  const observeAfterTurn = (input: AkeruBackgroundObservationInput) => {
    if (closing) return Promise.reject(new Error("Akeru observational memory is closing."));
    const resourceId = input.resourceId ?? input.threadId;
    const key = `${input.threadId}\u0000${resourceId}`;
    const prior = observationTails.get(key) ?? Promise.resolve();
    const work = prior
      .catch(() => undefined)
      .then(async () => {
        const requestContext = new RequestContext();
        requestContext.setRaw("controller", {
          resourceId,
          session: { modelId: input.modelId },
        });
        await observationalMemory.engine.observe({
          threadId: input.threadId,
          resourceId,
          requestContext,
          trigger: "manual",
          hooks: input.hooks ?? observeHooks,
        });
      });
    observationTails.set(key, work);
    void work
      .finally(() => {
        if (observationTails.get(key) === work) observationTails.delete(key);
      })
      .catch(() => undefined);
    return work;
  };

  return {
    controller,
    clearObservationalMemory: (threadId, resourceId) =>
      observationalMemory.engine.clear(threadId, resourceId),
    readObservationalMemory: async (threadId, resourceId) => {
      const normalize = (
        record: Awaited<ReturnType<typeof observationalMemory.engine.getRecord>>,
      ) => {
        if (!record) return null;
        return {
          id: record.id,
          generationCount: record.generationCount,
          originType: record.originType,
          activeObservations: record.activeObservations,
          bufferedObservations: [
            ...(record.bufferedObservationChunks?.map((chunk) => chunk.observations) ?? []),
            ...(record.bufferedObservations ? [record.bufferedObservations] : []),
          ].join("\n\n"),
          bufferedReflection: record.bufferedReflection ?? null,
          totalTokensObserved: record.totalTokensObserved,
          observationTokenCount: record.observationTokenCount,
          createdAt: record.createdAt.toISOString(),
          updatedAt: record.updatedAt.toISOString(),
        };
      };
      const [current, history] = await Promise.all([
        observationalMemory.engine.getRecord(threadId, resourceId),
        observationalMemory.engine.getHistory(threadId, resourceId, 50),
      ]);
      return { current: normalize(current), history: history.map((record) => normalize(record)!) };
    },
    observeAfterTurn,
    destroy: async () => {
      closing = true;
      await Promise.allSettled([...observationTails.values()]);
      await observationalMemory.close();
    },
  };
}
