import type * as EffectAcpSchema from "effect-acp/schema";

import { isRecord } from "./AcpProtocolValues.ts";
import {
  type AcpSessionMode,
  type AcpSessionModeState,
  type AcpSessionSetupResponse,
} from "./AcpRuntimeTypes.ts";

export function isSessionModelState(value: unknown): value is EffectAcpSchema.SessionModelState {
  if (!isRecord(value) || typeof value.currentModelId !== "string") {
    return false;
  }

  if (!Array.isArray(value.availableModels)) {
    return false;
  }

  return value.availableModels.every(
    (model) =>
      isRecord(model) &&
      typeof model.modelId === "string" &&
      typeof model.name === "string" &&
      (model.description === undefined ||
        model.description === null ||
        typeof model.description === "string"),
  );
}

export function isSessionModeState(value: unknown): value is EffectAcpSchema.SessionModeState {
  if (!isRecord(value) || typeof value.currentModeId !== "string") {
    return false;
  }

  if (!Array.isArray(value.availableModes)) {
    return false;
  }

  return value.availableModes.every(
    (mode) =>
      isRecord(mode) &&
      typeof mode.id === "string" &&
      typeof mode.name === "string" &&
      (mode.description === undefined || typeof mode.description === "string"),
  );
}

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined {
  const configOptions = sessionResponse.configOptions;

  if (!configOptions) return undefined;

  for (const opt of configOptions) {
    if (opt.category === "model" && opt.id.trim().length > 0) {
      return opt.id.trim();
    }
  }

  return undefined;
}

export function findSessionConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }

  const normalizedConfigId = configId.trim();

  if (!normalizedConfigId) {
    return undefined;
  }

  return configOptions.find((option) => option.id.trim() === normalizedConfigId);
}

export function collectSessionConfigOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string> {
  if (configOption.type !== "select") {
    return [];
  }

  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

export function parseSessionModeState(
  sessionResponse: AcpSessionSetupResponse,
): AcpSessionModeState | undefined {
  const modes = sessionResponse.modes;

  if (!modes) return undefined;
  const currentModeId = modes.currentModeId.trim();

  if (!currentModeId) {
    return undefined;
  }

  const availableModes: Array<AcpSessionMode> = [];

  for (const mode of modes.availableModes) {
    const id = mode.id.trim();
    const name = mode.name.trim();

    if (!id || !name) {
      continue;
    }

    const description = mode.description?.trim() || undefined;
    availableModes.push(
      description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode),
    );
  }

  if (availableModes.length === 0) {
    return undefined;
  }

  return {
    currentModeId,
    availableModes,
  };
}

/**
 * Model state some agents (Grok) advertise in `initialize._meta.modelState`, before any
 * session exists. Undefined when the agent does not advertise it or the shape is unknown.
 */
export function sessionModelStateFromInitialize(
  initializeResult: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.SessionModelState | undefined {
  const meta = initializeResult._meta;
  const modelState = isRecord(meta) ? meta.modelState : undefined;

  return isSessionModelState(modelState) ? modelState : undefined;
}

export function syntheticLoadSessionResponseFromInitialize(
  initializeResult: EffectAcpSchema.InitializeResponse,
): EffectAcpSchema.LoadSessionResponse {
  const meta = initializeResult._meta;
  const modeState = isRecord(meta) ? meta.modeState : undefined;
  const models = sessionModelStateFromInitialize(initializeResult);
  const modes = isSessionModeState(modeState) ? modeState : undefined;

  return {
    ...(models ? { models } : {}),
    ...(modes ? { modes } : {}),
    _meta: {
      t3SessionLoadReady: "replay_idle",
    },
  };
}
