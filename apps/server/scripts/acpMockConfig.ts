import * as Predicate from "effect/Predicate";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import type * as AcpSchema from "effect-acp/schema";

export interface AcpScenarioState {
  currentModeId: string;
  currentModelId: string;
  parameterizedModelPicker: boolean;
  currentReasoning: string;
  currentContext: string;
  currentFast: boolean;
  promptCount: number;
  overlappingFirstPromptId: string | undefined;
}

export const scenarioState: AcpScenarioState = {
  currentModeId: "ask",
  currentModelId: "default",
  parameterizedModelPicker: false,
  currentReasoning: "medium",
  currentContext: "272k",
  currentFast: false,
  promptCount: 0,
  overlappingFirstPromptId: undefined,
};

export const requestLogPath = process.env.T3_ACP_REQUEST_LOG_PATH;

export const exitLogPath = process.env.T3_ACP_EXIT_LOG_PATH;

export const emitToolCalls = process.env.T3_ACP_EMIT_TOOL_CALLS === "1";

export const emitInterleavedAssistantToolCalls =
  process.env.T3_ACP_EMIT_INTERLEAVED_ASSISTANT_TOOL_CALLS === "1";

export const emitGenericToolPlaceholders =
  process.env.T3_ACP_EMIT_GENERIC_TOOL_PLACEHOLDERS === "1";

export const emitAskQuestion = process.env.T3_ACP_EMIT_ASK_QUESTION === "1";

export const emitXAiAskUserQuestion = process.env.T3_ACP_EMIT_XAI_ASK_USER_QUESTION === "1";

export const emitXAiPromptCompleteThenHang =
  process.env.T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG === "1";

export const emitForeignSessionUpdates = process.env.T3_ACP_EMIT_FOREIGN_SESSION_UPDATES === "1";

export const hangPromptForever = process.env.T3_ACP_HANG_PROMPT_FOREVER === "1";

export const hangFirstPromptForever = process.env.T3_ACP_HANG_FIRST_PROMPT_FOREVER === "1";

export const emitLateUpdateAfterCancel = process.env.T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL === "1";

export const omitXAiPromptCompleteStopReason =
  process.env.T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON === "1";

export const failLoadSession = process.env.T3_ACP_FAIL_LOAD_SESSION === "1";

export const emitLoadReplay = process.env.T3_ACP_EMIT_LOAD_REPLAY === "1";

export const hangLoadSessionAfterReplay = process.env.T3_ACP_HANG_LOAD_SESSION_AFTER_REPLAY === "1";

export const delayLoadSessionAfterReplay =
  process.env.T3_ACP_DELAY_LOAD_SESSION_AFTER_REPLAY === "1";

export const loadSessionDelayMs = Number(process.env.T3_ACP_LOAD_SESSION_DELAY_MS ?? "5000");

export const emitStaleXAiPromptCompleteBeforeSecondHang =
  process.env.T3_ACP_EMIT_STALE_XAI_PROMPT_COMPLETE_BEFORE_SECOND_HANG === "1";

export const emitOverlappingXAiPromptCompleteOutOfOrder =
  process.env.T3_ACP_EMIT_OVERLAPPING_XAI_PROMPT_COMPLETE_OUT_OF_ORDER === "1";

export const failPrompt = process.env.T3_ACP_FAIL_PROMPT === "1";

export const failSetConfigOption = process.env.T3_ACP_FAIL_SET_CONFIG_OPTION === "1";

export const exitOnSetConfigOption = process.env.T3_ACP_EXIT_ON_SET_CONFIG_OPTION === "1";

export const promptResponseText = process.env.T3_ACP_PROMPT_RESPONSE_TEXT;

export const promptDelayMs = Number(process.env.T3_ACP_PROMPT_DELAY_MS ?? "0");

export const permissionOptionIds = {
  allowOnce: process.env.T3_ACP_ALLOW_ONCE_OPTION_ID ?? "allow-once",
  allowAlways: process.env.T3_ACP_ALLOW_ALWAYS_OPTION_ID ?? "allow-always",
  rejectOnce: process.env.T3_ACP_REJECT_ONCE_OPTION_ID ?? "reject-once",
};

export const sessionId = "mock-session-1";

export const cancelledSessions = new Set<string>();

export function promptIdFromRequestMeta(
  request: Pick<AcpSchema.PromptRequest, "_meta">,
): string | undefined {
  const meta = request._meta;

  if (meta === null || !Predicate.isObjectOrArray(meta)) {
    return undefined;
  }

  const promptId = meta.promptId ?? meta.requestId;

  return Predicate.isString(promptId) && promptId.length > 0 ? promptId : undefined;
}

export function logExit(reason: string): void {
  if (!exitLogPath) {
    return;
  }

  NodeFS.appendFileSync(exitLogPath, `${reason}\n`, "utf8");
}

export function writeJsonRpcNotification<Value>(method: string, params: Value): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
}

process.once("SIGTERM", () => {
  logExit("SIGTERM");
  process.exit(0);
});

process.once("SIGINT", () => {
  logExit("SIGINT");
  process.exit(0);
});

process.once("exit", (code) => {
  logExit(`exit:${code}`);
});

export function configOptions(): ReadonlyArray<AcpSchema.SessionConfigOption> {
  if (scenarioState.parameterizedModelPicker) {
    const baseOptions: Array<AcpSchema.SessionConfigOption> = [
      {
        id: "mode",
        name: "Mode",
        category: "mode",
        type: "select",
        currentValue: scenarioState.currentModeId,
        options: availableModes.map((mode) => ({
          value: mode.id,
          name: mode.name,
          ...(mode.description ? { description: mode.description } : {}),
        })),
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: scenarioState.currentModelId,
        options: [
          { value: "default", name: "Auto" },
          { value: "composer-2", name: "Composer 2" },
          { value: "gpt-5.4", name: "GPT-5.4" },
          { value: "claude-opus-4-6", name: "Opus 4.6" },
        ],
      },
    ];

    switch (scenarioState.currentModelId) {
      case "gpt-5.4":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: scenarioState.currentReasoning,
            options: [
              { value: "none", name: "None" },
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
              { value: "extra-high", name: "Extra High" },
            ],
          },
          {
            id: "context",
            name: "Context",
            category: "model_config",
            type: "select",
            currentValue: scenarioState.currentContext,
            options: [
              { value: "272k", name: "272K" },
              { value: "1m", name: "1M" },
            ],
          },
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(scenarioState.currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "composer-2":
        return [
          ...baseOptions,
          {
            id: "fast",
            name: "Fast",
            category: "model_config",
            type: "select",
            currentValue: String(scenarioState.currentFast),
            options: [
              { value: "false", name: "Off" },
              { value: "true", name: "Fast" },
            ],
          },
        ];
      case "claude-opus-4-6":
        return [
          ...baseOptions,
          {
            id: "reasoning",
            name: "Reasoning",
            category: "thought_level",
            type: "select",
            currentValue: scenarioState.currentReasoning,
            options: [
              { value: "low", name: "Low" },
              { value: "medium", name: "Medium" },
              { value: "high", name: "High" },
            ],
          },
          {
            id: "thinking",
            name: "Thinking",
            category: "model_config",
            type: "boolean",
            currentValue: true,
          },
        ];
      default:
        return baseOptions;
    }
  }

  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select" as const,
      currentValue: scenarioState.currentModelId,
      options: [
        { value: "default", name: "Auto" },
        { value: "composer-2", name: "Composer 2" },
        { value: "composer-2[fast=true]", name: "Composer 2 Fast" },
        { value: "gpt-5.3-codex[reasoning=medium,fast=false]", name: "Codex 5.3" },
      ],
    },
  ];
}

export function modelConfigOptionsFor(
  modelId: string,
): ReadonlyArray<AcpSchema.SessionConfigOption> {
  const previousModelId = scenarioState.currentModelId;

  try {
    scenarioState.currentModelId = modelId;

    return configOptions().filter(
      (option) => option.category !== "mode" && option.category !== "model",
    );
  } finally {
    scenarioState.currentModelId = previousModelId;
  }
}

export function availableModels(): ReadonlyArray<{
  readonly value: string;
  readonly name: string;
  readonly configOptions: ReadonlyArray<AcpSchema.SessionConfigOption>;
}> {
  return [
    { value: "default", name: "Auto" },
    { value: "composer-2", name: "Composer 2" },
    { value: "gpt-5.4", name: "GPT-5.4" },
    { value: "claude-opus-4-6", name: "Opus 4.6" },
  ].map((model) => ({
    value: model.value,
    name: model.name,
    configOptions: modelConfigOptionsFor(model.value),
  }));
}

export const availableModes: ReadonlyArray<AcpSchema.SessionMode> = [
  {
    id: "ask",
    name: "Ask",
    description: "Request permission before making any changes",
  },
  {
    id: "architect",
    name: "Architect",
    description: "Design and plan software systems without implementation",
  },
  {
    id: "code",
    name: "Code",
    description: "Write and modify code with full tool access",
  },
];

export function modeState(): AcpSchema.SessionModeState {
  return {
    currentModeId: scenarioState.currentModeId,
    availableModes,
  };
}

export // Mirrors the real Grok ACP: it advertises versioned model ids, never the CLI's own
// "grok-build" product name, and it rejects unknown ids in session/set_model.
const grokAcpModels: ReadonlyArray<AcpSchema.ModelInfo> = [
  { modelId: "grok-4.6", name: "Grok 4.6" },
  { modelId: "grok-mock-alt", name: "Grok Mock Alt" },
];

export function modelState(): AcpSchema.SessionModelState {
  const modelId = grokAcpModels.some((model) => model.modelId === scenarioState.currentModelId)
    ? scenarioState.currentModelId
    : "grok-4.6";

  return {
    currentModelId: modelId,
    availableModels: grokAcpModels,
  };
}
