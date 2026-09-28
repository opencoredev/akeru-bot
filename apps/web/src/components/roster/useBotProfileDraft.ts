import { useAtomValue } from "@effect/atom-react";
import {
  ProviderInstanceId,
  isImageProviderId,
  type BotEngine,
  type ImageProviderId,
  type McpServerId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionForInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { shouldRenderTraitsControls } from "../chat/TraitsPicker";
import { botEngineUnavailability } from "./botEngineSelection";
import { canonicalizeBotPersonalityTone } from "./botPersonalityTone";
import { botSandboxChoice, type BotSandboxChoice } from "./botSandbox";
import type { Bot } from "./types";

type BotModelOptions = BotEngine["options"];

const TOOL_ID_SEPARATOR = "\u0000";

export function rebaseUneditedValue<T>(
  current: T,
  previous: T,
  next: T,
  equal: (left: T, right: T) => boolean = Object.is,
): T {
  return equal(current, previous) ? next : current;
}

function mcpServerIdsKey(ids: readonly McpServerId[]): string {
  return [...ids].sort().join(TOOL_ID_SEPARATOR);
}

export interface BotProfileUpdate {
  readonly name: string;
  readonly label: string | null;
  readonly description: string | null;
  readonly engine: Bot["engine"];
  readonly usageCap: Bot["usageCap"];
  readonly sandbox: Bot["sandbox"];
  readonly personalityTone: number;
  readonly voiceEnabled: boolean;
  readonly imageProvider: ImageProviderId | null;
  readonly disabledMcpServerIds: readonly McpServerId[];
}

/** Select value for "use the global default" in the bot image provider picker. */
export const BOT_IMAGE_PROVIDER_DEFAULT = "default";

/** Maps the bot image provider picker value to the saved field; anything unknown means the global default. */
export function botImageProviderFromSelectValue(value: string | null): ImageProviderId | null {
  return value !== null && isImageProviderId(value) ? value : null;
}

export function parseBotUsageCapInput(input: string): {
  readonly valid: boolean;
  readonly value: Bot["usageCap"];
} {
  if (input.trim().length === 0) return { valid: true, value: null };
  const limit = Number(input);
  if (!Number.isSafeInteger(limit) || limit <= 0) return { valid: false, value: null };
  return { valid: true, value: { unit: "tokens", limit } };
}

export function resolveBotUsageCapForProvider(
  input: string,
  providerDriver?: string,
): {
  readonly available: boolean;
  readonly valid: boolean;
  readonly value: Bot["usageCap"];
} {
  if (providerDriver === "cursor" || providerDriver === "grok") {
    return { available: false, valid: true, value: null };
  }
  return { available: true, ...parseBotUsageCapInput(input) };
}

/**
 * Draft state for every editable bot field, shared by the in-chat bot panel
 * and the full bot settings page. Both surfaces read dirtiness and build the
 * save payload from here, so the two cannot drift apart.
 */
export function useBotProfileDraft(
  bot: Bot,
  onSave?: (input: BotProfileUpdate) => Promise<boolean>,
) {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const { t } = useI18n();
  const settings = usePrimarySettings();

  const [name, setName] = useState(bot.name);
  const [label, setLabel] = useState(bot.label ?? "");
  const [description, setDescription] = useState(bot.description ?? "");
  const [usageCap, setUsageCap] = useState(() => bot.usageCap?.limit.toString() ?? "");
  const [sandbox, setSandbox] = useState<BotSandboxChoice>(() => botSandboxChoice(bot.sandbox));
  const [personalityTone, setPersonalityTone] = useState(() =>
    canonicalizeBotPersonalityTone(bot.personalityTone),
  );
  const [voiceEnabled, setVoiceEnabled] = useState(bot.voiceEnabled);
  const [imageProvider, setImageProvider] = useState<ImageProviderId | null>(
    bot.imageProvider ?? null,
  );
  const [disabledMcpServerIds, setDisabledMcpServerIds] = useState<readonly McpServerId[]>(
    bot.disabledMcpServerIds,
  );
  const [engineChanged, setEngineChanged] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const previousBot = useRef(bot);

  const instanceEntries = useMemo(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
      ),
    [providers, settings],
  );
  const defaultSelection = useMemo(
    () => resolveAppModelSelectionState(settings, providers),
    [providers, settings],
  );
  const [provider, setProvider] = useState(bot.engine?.provider ?? defaultSelection.instanceId);
  // The saved instance wins even when it cannot run, so the picker keeps showing
  // the bot's real choice; `engineUnavailability` says why it is blocked.
  const activeEntry = useMemo(
    () =>
      instanceEntries.find((entry) => entry.instanceId === provider) ??
      (bot.engine === null && !engineChanged
        ? resolveSelectableProviderInstanceEntry(instanceEntries, ProviderInstanceId.make(provider))
        : undefined),
    [bot.engine, engineChanged, instanceEntries, provider],
  );
  const providerInstanceId =
    bot.engine === null && !engineChanged && activeEntry
      ? activeEntry.instanceId
      : ProviderInstanceId.make(provider);
  const [model, setModel] = useState<string>(
    () =>
      bot.engine?.model ??
      (activeEntry
        ? resolveAppModelSelectionForInstance(activeEntry.instanceId, settings, providers, null)
        : null) ??
      defaultSelection.model,
  );
  const [modelOptions, setModelOptions] = useState<BotModelOptions>(
    () =>
      bot.engine?.options ??
      (bot.engine?.provider === defaultSelection.instanceId &&
      bot.engine.model === defaultSelection.model
        ? defaultSelection.options
        : undefined),
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        ProviderInstanceId.make(provider),
        model,
      ),
    [model, provider, providers, settings],
  );
  const engineUnavailability = useMemo(
    () =>
      botEngineUnavailability(
        model ? { instanceId: providerInstanceId, model } : null,
        instanceEntries,
        t,
      ),
    [instanceEntries, model, providerInstanceId, t],
  );

  useEffect(() => {
    if (engineChanged) return;
    setProvider(bot.engine?.provider ?? defaultSelection.instanceId);
    if (bot.engine?.model) setModel(bot.engine.model);
    setModelOptions(
      bot.engine?.options ??
        (bot.engine?.provider === defaultSelection.instanceId &&
        bot.engine.model === defaultSelection.model
          ? defaultSelection.options
          : undefined),
    );
  }, [bot.engine, defaultSelection, engineChanged]);

  useEffect(() => {
    const previous = previousBot.current;
    previousBot.current = bot;
    if (previous.id !== bot.id) return;

    setName((current) => rebaseUneditedValue(current, previous.name, bot.name));
    setLabel((current) => rebaseUneditedValue(current, previous.label ?? "", bot.label ?? ""));
    setDescription((current) =>
      rebaseUneditedValue(current, previous.description ?? "", bot.description ?? ""),
    );
    setUsageCap((current) =>
      rebaseUneditedValue(
        current,
        previous.usageCap?.limit.toString() ?? "",
        bot.usageCap?.limit.toString() ?? "",
      ),
    );
    setSandbox((current) =>
      rebaseUneditedValue(
        current,
        botSandboxChoice(previous.sandbox),
        botSandboxChoice(bot.sandbox),
      ),
    );
    setPersonalityTone((current) =>
      rebaseUneditedValue(
        current,
        canonicalizeBotPersonalityTone(previous.personalityTone),
        canonicalizeBotPersonalityTone(bot.personalityTone),
      ),
    );
    setVoiceEnabled((current) =>
      rebaseUneditedValue(current, previous.voiceEnabled, bot.voiceEnabled),
    );
    setImageProvider((current) =>
      rebaseUneditedValue(current, previous.imageProvider ?? null, bot.imageProvider ?? null),
    );
    setDisabledMcpServerIds((current) =>
      rebaseUneditedValue(
        current,
        previous.disabledMcpServerIds,
        bot.disabledMcpServerIds,
        (a, b) => mcpServerIdsKey(a) === mcpServerIdsKey(b),
      ),
    );
  }, [bot]);

  const markChanged = () => setSaved(false);

  const normalizedLabel = label.trim() || null;
  const normalizedDescription = description.trim() || null;
  const savedTone = canonicalizeBotPersonalityTone(bot.personalityTone);
  const nextEngine: Bot["engine"] =
    engineChanged && model
      ? { provider, model, ...(modelOptions ? { options: modelOptions } : {}) }
      : bot.engine;
  const showModelOptions =
    activeEntry !== undefined &&
    model.length > 0 &&
    shouldRenderTraitsControls({
      provider: activeEntry.driverKind,
      models: activeEntry.models,
      model,
      prompt: "",
      modelOptions,
      allowPromptInjectedEffort: false,
    });
  const resolvedUsageCap = resolveBotUsageCapForProvider(usageCap, activeEntry?.driverKind);
  const usageCapDirty =
    !resolvedUsageCap.valid || resolvedUsageCap.value?.limit !== bot.usageCap?.limit;
  const toolOverridesDirty =
    mcpServerIdsKey(disabledMcpServerIds) !== mcpServerIdsKey(bot.disabledMcpServerIds);
  const sandboxDirty = sandbox !== botSandboxChoice(bot.sandbox);
  const dirty =
    name.trim() !== bot.name ||
    normalizedLabel !== bot.label ||
    normalizedDescription !== bot.description ||
    engineChanged ||
    usageCapDirty ||
    sandboxDirty ||
    personalityTone !== savedTone ||
    voiceEnabled !== bot.voiceEnabled ||
    imageProvider !== (bot.imageProvider ?? null) ||
    toolOverridesDirty;
  const canSave = Boolean(onSave) && dirty && name.trim().length > 0 && resolvedUsageCap.valid;

  return {
    // Provider context shared by both model pickers.
    settings,
    instanceEntries,
    defaultSelection,
    activeEntry,
    providerInstanceId,
    engineUnavailability,
    modelOptionsByInstance,
    showModelOptions,

    name,
    setName,
    label,
    setLabel,
    description,
    setDescription,
    usageCap,
    setUsageCap,
    resolvedUsageCap,
    sandbox,
    setSandbox,
    personalityTone,
    setPersonalityTone,
    voiceEnabled,
    setVoiceEnabled,
    imageProvider,
    setImageProvider,
    disabledMcpServerIds,
    setDisabledMcpServerIds,
    model,
    modelOptions,

    /** Applies a model pick, including the option reset the picker implies. */
    selectModel: (instanceId: string, nextModel: string) => {
      setProvider(instanceId);
      setModel(nextModel);
      setModelOptions(
        defaultSelection.instanceId === instanceId && defaultSelection.model === nextModel
          ? defaultSelection.options
          : undefined,
      );
      setEngineChanged(true);
      markChanged();
    },
    selectModelOptions: (nextOptions: BotModelOptions) => {
      setModelOptions(nextOptions);
      setEngineChanged(true);
      markChanged();
    },

    markChanged,
    dirty,
    canSave,
    saving,
    saved,
    save: () => {
      if (!onSave || !canSave) return;
      setSaving(true);
      void onSave({
        name: name.trim(),
        label: normalizedLabel,
        description: normalizedDescription,
        engine: nextEngine,
        usageCap: resolvedUsageCap.value,
        sandbox,
        personalityTone,
        voiceEnabled,
        imageProvider,
        disabledMcpServerIds,
      }).then((success) => {
        setSaving(false);
        setSaved(success);
        if (success) setEngineChanged(false);
      });
    },
  };
}
