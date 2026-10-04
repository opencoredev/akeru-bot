import * as Predicate from "effect/Predicate";
import {
  type BotEngine,
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  MODEL_SLUG_ALIASES_BY_PROVIDER,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@akeru/contracts";

const DEFAULT_PROVIDER_DRIVER_KIND = ProviderDriverKind.make("codex");

export interface SelectableModelOption {
  slug: string;
  name: string;
}

export function createModelCapabilities(input: {
  optionDescriptors: ReadonlyArray<ProviderOptionDescriptor>;
}): ModelCapabilities {
  return {
    optionDescriptors: input.optionDescriptors.map(cloneDescriptor),
  };
}

function getRawSelectionValueById(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  const selection = selections?.find((candidate) => candidate.id === id);

  return selection?.value;
}

export function getProviderOptionSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | boolean | undefined {
  return getRawSelectionValueById(selections, id);
}

export function getProviderOptionStringSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): string | undefined {
  const value = getProviderOptionSelectionValue(selections, id);

  return Predicate.isString(value) ? value : undefined;
}

export function getProviderOptionBooleanSelectionValue(
  selections: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  id: string,
): boolean | undefined {
  const value = getProviderOptionSelectionValue(selections, id);

  return Predicate.isBoolean(value) ? value : undefined;
}

export function getModelSelectionOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | boolean | undefined {
  return getProviderOptionSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionStringOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): string | undefined {
  return getProviderOptionStringSelectionValue(modelSelection?.options, id);
}

export function getModelSelectionBooleanOptionValue(
  modelSelection: ModelSelection | null | undefined,
  id: string,
): boolean | undefined {
  return getProviderOptionBooleanSelectionValue(modelSelection?.options, id);
}

function normalizeDescriptorSelectionValue(
  descriptor: ProviderOptionDescriptor,
  value: string | boolean,
): string | boolean {
  return descriptor.type === "select" &&
    descriptor.id === "reasoningEffort" &&
    value === "off" &&
    !descriptor.options.some((option) => option.id === "off") &&
    descriptor.options.some((option) => option.id === "none")
    ? "none"
    : value;
}

function resolveDescriptorChoiceValue(
  descriptor: Extract<ProviderOptionDescriptor, { type: "select" }>,
  raw: string | null | undefined,
): string | undefined {
  const trimmedRaw = trimOrNull(raw);
  const trimmed = trimmedRaw ? normalizeDescriptorSelectionValue(descriptor, trimmedRaw) : null;

  if (!trimmed) {
    return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
  }

  if (descriptor.options.length === 0) {
    return Predicate.isString(trimmed) ? trimmed : undefined;
  }

  if (
    Predicate.isString(trimmed) &&
    descriptor.promptInjectedValues?.includes(trimmed) &&
    descriptor.options.some((option) => option.id === trimmed)
  ) {
    return descriptor.options.find((option) => option.isDefault)?.id;
  }

  if (descriptor.options.some((option) => option.id === trimmed)) {
    return Predicate.isString(trimmed) ? trimmed : undefined;
  }

  return descriptor.currentValue ?? descriptor.options.find((option) => option.isDefault)?.id;
}

function cloneDescriptor(descriptor: ProviderOptionDescriptor): ProviderOptionDescriptor {
  return descriptor.type === "select"
    ? {
        ...descriptor,
        options: [...descriptor.options],
        ...(descriptor.promptInjectedValues
          ? { promptInjectedValues: [...descriptor.promptInjectedValues] }
          : {}),
      }
    : { ...descriptor };
}

function cloneSelection(selection: ProviderOptionSelection): ProviderOptionSelection {
  return { ...selection };
}

function withDescriptorCurrentValue(
  descriptor: ProviderOptionDescriptor,
  rawCurrentValue: string | boolean | undefined,
): ProviderOptionDescriptor {
  if (descriptor.type === "boolean") {
    if (Predicate.isBoolean(rawCurrentValue)) {
      return {
        ...descriptor,
        currentValue: rawCurrentValue,
      };
    }

    return descriptor;
  }

  const currentValue = Predicate.isString(rawCurrentValue)
    ? resolveDescriptorChoiceValue(descriptor, rawCurrentValue)
    : resolveDescriptorChoiceValue(descriptor, descriptor.currentValue);

  if (!currentValue) {
    const { currentValue: _unusedCurrentValue, ...rest } = descriptor;

    return rest;
  }

  return {
    ...descriptor,
    currentValue,
  };
}

export function getProviderOptionDescriptors(input: {
  caps: ModelCapabilities;
  selections?: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): ReadonlyArray<ProviderOptionDescriptor> {
  const { caps, selections } = input;
  const baseDescriptors = (caps.optionDescriptors ?? []).map(cloneDescriptor);

  return baseDescriptors.map((descriptor) =>
    withDescriptorCurrentValue(
      descriptor,
      getRawSelectionValueById(selections, descriptor.id) ?? descriptor.currentValue,
    ),
  );
}

export function getProviderOptionCurrentValue(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | boolean | undefined {
  if (!descriptor) {
    return undefined;
  }

  if (descriptor.type === "boolean") {
    return descriptor.currentValue;
  }

  if (descriptor.currentValue) {
    return descriptor.currentValue;
  }

  return descriptor.options.find((option) => option.isDefault)?.id;
}

export function getProviderOptionCurrentLabel(
  descriptor: ProviderOptionDescriptor | null | undefined,
): string | undefined {
  if (!descriptor) {
    return undefined;
  }

  if (descriptor.type === "boolean") {
    return Predicate.isBoolean(descriptor.currentValue)
      ? descriptor.currentValue
        ? "On"
        : "Off"
      : undefined;
  }

  const currentValue = getProviderOptionCurrentValue(descriptor);

  if (!Predicate.isString(currentValue)) {
    return undefined;
  }

  return descriptor.options.find((option) => option.id === currentValue)?.label;
}

export function buildProviderOptionSelectionsFromDescriptors(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!descriptors || descriptors.length === 0) {
    return undefined;
  }

  const nextSelections: Array<ProviderOptionSelection> = [];

  for (const descriptor of descriptors) {
    const value = getProviderOptionCurrentValue(descriptor);

    if (Predicate.isString(value) || Predicate.isBoolean(value)) {
      nextSelections.push({ id: descriptor.id, value });
    }
  }

  return nextSelections.length > 0 ? nextSelections : undefined;
}

export function getModelSelectionOptionDescriptors(
  modelSelection: ModelSelection | null | undefined,
  caps?: ModelCapabilities | null | undefined,
): ReadonlyArray<ProviderOptionDescriptor> {
  if (!modelSelection) {
    return [];
  }

  if (!caps) {
    return [];
  }

  return getProviderOptionDescriptors({
    caps,
    selections: modelSelection.options,
  });
}

export function isClaudeUltrathinkPrompt(text: string | null | undefined): boolean {
  return Predicate.isString(text) && /\bultrathink\b/i.test(text);
}

export function normalizeModelSlug(
  model: string | null | undefined,
  provider: ProviderDriverKind = DEFAULT_PROVIDER_DRIVER_KIND,
): string | null {
  const trimmed = normalizeCustomModelSlug(model);

  if (!trimmed) {
    return null;
  }

  const aliases = MODEL_SLUG_ALIASES_BY_PROVIDER[provider] ?? {};

  const aliased = Object.prototype.hasOwnProperty.call(aliases, trimmed)
    ? aliases[trimmed]
    : undefined;

  return Predicate.isString(aliased) ? aliased : trimmed;
}

/** Custom model identifiers are provider-owned, so only trim them; never expand aliases. */
export function normalizeCustomModelSlug(model: string | null | undefined): string | null {
  if (!Predicate.isString(model)) {
    return null;
  }

  return model.trim() || null;
}

export function resolveSelectableModel(
  provider: ProviderDriverKind,
  value: string | null | undefined,
  options: ReadonlyArray<SelectableModelOption>,
): string | null {
  if (!Predicate.isString(value)) {
    return null;
  }

  const trimmed = value.trim();

  if (!trimmed) {
    return null;
  }

  const direct = options.find((option) => option.slug === trimmed);

  if (direct) {
    return direct.slug;
  }

  const byName = options.find((option) => option.name.toLowerCase() === trimmed.toLowerCase());

  if (byName) {
    return byName.slug;
  }

  const normalized = normalizeModelSlug(trimmed, provider);

  if (!normalized) {
    return null;
  }

  const resolved = options.find((option) => option.slug === normalized);

  return resolved ? resolved.slug : null;
}

function resolveModelSlug(model: string | null | undefined, provider: ProviderDriverKind): string {
  const normalized = normalizeModelSlug(model, provider);

  if (!normalized) {
    return DEFAULT_MODEL_BY_PROVIDER[provider] ?? DEFAULT_MODEL;
  }

  return normalized;
}

export function resolveModelSlugForProvider(
  provider: ProviderDriverKind,
  model: string | null | undefined,
): string {
  return resolveModelSlug(model, provider);
}

/** Trim a string, returning null for empty/missing values. */
export function trimOrNull(value: string | null | undefined) {
  if (!Predicate.isString(value)) return null;
  const trimmed = value.trim();

  return trimmed || null;
}

function cloneSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
): Array<ProviderOptionSelection> {
  return selections.map(cloneSelection);
}

export function createModelSelection(
  instanceId: ProviderInstanceId,
  model: string,
  options?: ReadonlyArray<ProviderOptionSelection> | null,
): ModelSelection {
  const selections = options ? cloneSelections(options) : [];

  const base: ModelSelection = {
    instanceId,
    model,
  };

  return selections.length > 0 ? { ...base, options: selections } : base;
}

function isChosenProviderOption(
  descriptor: ProviderOptionDescriptor,
  value: string | boolean,
): boolean {
  if (descriptor.type === "boolean") {
    return Predicate.isBoolean(value) && value !== descriptor.currentValue;
  }

  return (
    Predicate.isString(value) &&
    descriptor.options.some((option) => option.id === value && option.isDefault !== true) &&
    !descriptor.promptInjectedValues?.includes(value)
  );
}

/**
 * The options a user actually chose for a model: each names an advertised
 * descriptor and choice and differs from that descriptor's default, so picking
 * the default removes the option. Capabilities that are unknown (`null`, or a
 * snapshot without a descriptor list) cannot reject anything, so the options
 * are kept as they are. Returns undefined when nothing remains.
 */
export function retainChosenProviderOptions(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  caps: ModelCapabilities | null | undefined,
): Array<ProviderOptionSelection> | undefined {
  if (!options || options.length === 0) return undefined;

  const descriptors = caps?.optionDescriptors;

  if (descriptors === undefined) return cloneSelections(options);

  const seen = new Set<string>();

  const kept = options.flatMap((option) => {
    if (seen.has(option.id)) return [];
    seen.add(option.id);
    const descriptor = descriptors.find((candidate) => candidate.id === option.id);

    if (!descriptor) return [];

    const value = normalizeDescriptorSelectionValue(descriptor, option.value);

    return isChosenProviderOption(descriptor, value) ? [{ id: option.id, value }] : [];
  });

  return kept.length > 0 ? cloneSelections(kept) : undefined;
}

/**
 * The options a model pick carries over from `previous`. Another provider
 * instance starts clean. The same instance keeps the choices the next model
 * supports; a next model with unknown capabilities starts clean, because
 * nothing confirms the old choices apply to it.
 */
export function providerOptionsForModelChange(input: {
  readonly previous: ModelSelection | null | undefined;
  readonly instanceId: string;
  readonly nextCaps: ModelCapabilities | null | undefined;
}): Array<ProviderOptionSelection> | undefined {
  if (!input.previous || input.previous.instanceId !== input.instanceId) return undefined;

  if (input.nextCaps?.optionDescriptors === undefined) return undefined;

  return retainChosenProviderOptions(input.previous.options, input.nextCaps);
}

/**
 * A bot's saved engine as the selection it runs with. The saved options are
 * the bot's own: the app's default selection never fills them in.
 */
export function botEngineModelSelection(engine: BotEngine): ModelSelection {
  return createModelSelection(
    ProviderInstanceId.make(engine.provider),
    engine.model,
    engine.options,
  );
}

/** The engine to save for a selection, keeping only options the user chose. */
export function botEngineFromModelSelection(
  selection: ModelSelection,
  caps: ModelCapabilities | null | undefined,
): BotEngine {
  const options = retainChosenProviderOptions(selection.options, caps);

  return {
    provider: selection.instanceId,
    model: selection.model,
    ...(options ? { options } : {}),
  };
}

/**
 * Returns the effort value if it is a prompt-injected value according to
 * any select descriptor in the given capabilities, or null otherwise.
 *
 * Unlike a single `find`, this checks every descriptor so that the
 * correct descriptor's `promptInjectedValues` list is consulted even when
 * multiple select descriptors exist.
 */
export function resolvePromptInjectedEffort(
  caps: ModelCapabilities,
  rawEffort: string | null | undefined,
): string | null {
  const trimmed = trimOrNull(rawEffort);

  if (!trimmed) return null;
  const descriptors = getProviderOptionDescriptors({ caps });

  for (const descriptor of descriptors) {
    if (descriptor.type === "select" && descriptor.promptInjectedValues?.includes(trimmed)) {
      return trimmed;
    }
  }

  return null;
}

export function applyClaudePromptEffortPrefix(
  text: string,
  effort: string | null | undefined,
): string {
  const trimmed = text.trim();

  if (!trimmed) {
    return trimmed;
  }

  // Prefixing a slash command turns it into plain prose, so Claude never
  // runs it. Command names come from arbitrary file names ("/deploy.prod",
  // "/plugin:skill"), so accept any first token without a second slash;
  // absolute paths like "/home/theo/app.ts" keep the prefix.
  if (effort !== "ultrathink" || /^\/[^\s/]+(?:\s|$)/u.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("Ultrathink:")) {
    return trimmed;
  }

  return `Ultrathink:\n${trimmed}`;
}

const MODEL_NAME_BRANDS = new Map([
  ["gpt", "GPT"],
  ["glm", "GLM"],
  ["deepseek", "DeepSeek"],
  ["minimax", "MiniMax"],
  ["mimo", "MiMo"],
  ["longcat", "LongCat"],
]);

/** Brands written with a hyphen before their version, as in "GPT-6.1". */
const HYPHENATED_MODEL_BRANDS = new Set(["GPT", "GLM"]);

/**
 * Readable fallback name for a model slug the provider did not name, such as
 * "gpt-5.5" → "GPT-5.5" or "claude-opus-4-8" → "Claude Opus 4.8". Use the
 * provider's own model name when one exists.
 */
export function formatModelSlug(slug: string): string {
  const parts = (slug.split("/").at(-1) ?? slug).split("-").filter((part) => part.length > 0);
  const words: string[] = [];

  for (const part of parts) {
    const previous = words.at(-1);

    // Claude slugs spell versions with hyphens: "opus-4-8" is Opus 4.8.
    if (/^\d+$/.test(part) && previous !== undefined && /^\d+(\.\d+)*$/.test(previous)) {
      words[words.length - 1] = `${previous}.${part}`;
      continue;
    }

    const brand = MODEL_NAME_BRANDS.get(part.toLowerCase());
    words.push(
      brand ?? (/^\d/.test(part) ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)),
    );
  }

  return words.reduce((name, word, index) => {
    if (index === 0) return word;

    const separator =
      index === 1 && HYPHENATED_MODEL_BRANDS.has(words[0]!) && /^\d/.test(word) ? "-" : " ";

    return `${name}${separator}${word}`;
  }, "");
}
