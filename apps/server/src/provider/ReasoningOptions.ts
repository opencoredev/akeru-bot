import * as Predicate from "effect/Predicate";
import {
  type ModelCapabilities,
  type ModelSelection,
  type ProviderDriverKind,
} from "@akeru/contracts";
import {
  createModelCapabilities,
  getModelSelectionStringOptionValue,
  getModelSelectionBooleanOptionValue,
} from "@akeru/shared/model";
import * as Schema from "effect/Schema";
import { openCodeGoProtocol } from "./AkeruOpenCodeGoProvider.ts";
import { getClaudeModelCapabilities } from "./Layers/claude/ClaudeModels.ts";
import { type CatalogModel } from "./modelCatalogData.ts";

export const AkeruModelOptions = Schema.Struct({
  namespace: Schema.optionalKey(Schema.Literals(["openai", "anthropic", "xai", "opencode-go"])),
  reasoningEffort: Schema.optionalKey(Schema.String),
  serviceTier: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  thinking: Schema.optionalKey(Schema.Boolean),
  thinkingMode: Schema.optionalKey(Schema.Literals(["adaptive", "enabled"])),
});

export type AkeruModelOptions = typeof AkeruModelOptions.Type;

const NATIVE_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function reasoningCapabilities(
  driver: ProviderDriverKind,
  slug: string,
  entry: CatalogModel | undefined,
): ModelCapabilities {
  const levels = entry?.efforts?.filter((level) => NATIVE_EFFORTS.has(level)) ?? [];

  const anthropic =
    driver === "claudeAgent" ||
    driver === "kimi" ||
    (driver === "opencodeGo" && openCodeGoProtocol(slug) === "anthropic");

  return createModelCapabilities({
    optionDescriptors:
      levels.length === 0
        ? []
        : [
            {
              id: anthropic ? "effort" : "reasoningEffort",
              label: "Reasoning",
              type: "select",
              currentValue: "default",
              options: [
                { id: "default", label: "Provider default", isDefault: true },
                ...levels.map((id) => ({
                  id,
                  label: id === "xhigh" ? "Extra High" : id[0]!.toUpperCase() + id.slice(1),
                })),
              ],
            },
          ],
  });
}

export function nativeModelOptions(
  driver: ProviderDriverKind,
  selection: ModelSelection,
): AkeruModelOptions | undefined {
  const reasoningEffort = getModelSelectionStringOptionValue(selection, "reasoningEffort");
  const effort = getModelSelectionStringOptionValue(selection, "effort");

  const thinking =
    driver === "claudeAgent" &&
    getClaudeModelCapabilities(selection.model).optionDescriptors?.some(
      (descriptor) => descriptor.id === "thinking",
    )
      ? getModelSelectionBooleanOptionValue(selection, "thinking")
      : undefined;

  const serviceTier =
    driver === "codex" ? getModelSelectionStringOptionValue(selection, "serviceTier") : undefined;

  const anthropic =
    driver === "claudeAgent" ||
    driver === "kimi" ||
    (driver === "opencodeGo" && openCodeGoProtocol(selection.model) === "anthropic");

  const namespace = anthropic
    ? "anthropic"
    : driver === "grok"
      ? "xai"
      : driver === "opencodeGo" && openCodeGoProtocol(selection.model) === "chat-completions"
        ? "opencode-go"
        : "openai";

  const rawEffort = anthropic ? (effort ?? reasoningEffort) : reasoningEffort;
  const normalized = rawEffort === "off" && !anthropic ? "none" : rawEffort;
  const nativeEffort = normalized && NATIVE_EFFORTS.has(normalized) ? normalized : undefined;

  const adaptive =
    driver === "kimi" || (driver === "claudeAgent" && supportsAdaptiveThinking(selection.model));

  if (!nativeEffort && thinking === undefined && !serviceTier) return undefined;

  return {
    ...(driver === "codex" ? {} : { namespace }),
    ...(nativeEffort
      ? anthropic
        ? { effort: nativeEffort }
        : { reasoningEffort: nativeEffort }
      : {}),
    ...(thinking !== undefined
      ? { thinking, thinkingMode: "enabled" as const }
      : nativeEffort && adaptive
        ? { thinking: true, thinkingMode: "adaptive" as const }
        : {}),
    ...(serviceTier ? { serviceTier } : {}),
  };
}

export function supportsAdaptiveThinking(slug: string): boolean {
  const version = /^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?/.exec(slug);

  return (
    version !== null &&
    (Number(version[1]) > 4 || (Number(version[1]) === 4 && Number(version[2]) >= 6))
  );
}

/** Older snapshots without descriptors cannot authoritatively reject a saved selection. */
export function invalidReasoningSelection(
  selection: ModelSelection,
  capabilities: ModelCapabilities | null | undefined,
): string | undefined {
  for (const option of selection.options ?? []) {
    if (!["reasoningEffort", "effort", "thinking"].includes(option.id)) continue;

    const descriptor = capabilities?.optionDescriptors?.find(
      (candidate) => candidate.id === option.id,
    );

    if (option.value === "default" && option.id !== "thinking") continue;

    if (!descriptor) {
      if (capabilities?.optionDescriptors === undefined) continue;

      return `Reasoning option '${option.id}' is not supported for '${selection.model}'.`;
    }

    // `off` is the stored Codex spelling of the native `none` level.
    const value =
      option.id === "reasoningEffort" &&
      option.value === "off" &&
      descriptor.type === "select" &&
      descriptor.options.some((candidate) => candidate.id === "none")
        ? "none"
        : option.value;

    if (
      descriptor.type === "boolean"
        ? !Predicate.isBoolean(value)
        : !Predicate.isString(value) ||
          !descriptor.options.some((candidate) => candidate.id === value)
    ) {
      return `Reasoning option '${option.id}' does not support '${String(option.value)}' for '${selection.model}'.`;
    }
  }

  return undefined;
}
