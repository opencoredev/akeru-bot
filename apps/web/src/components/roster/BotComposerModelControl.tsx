import { useAtomValue } from "@effect/atom-react";
import { BotId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useI18n } from "../../i18n";
import { resolveShortcutCommand } from "../../keybindings";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { registerComposerModelPicker } from "../../composerModelPickerRegistry";
import { botEnvironment } from "../../state/bots";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { primaryServerKeybindingsAtom, primaryServerProvidersAtom } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { toastManager } from "../ui/toast";
import { resolveStickyBotEngine } from "./botEngineSelection";
import { useRosterStore } from "./rosterStore";

/**
 * The bot's engine at the composer: shows which model answers the next message
 * and opens the shared model picker to change it. Changing the model here
 * writes the bot's engine, the same field the details panel edits.
 */
export function BotComposerModelControl({
  botId,
  disabled = false,
}: {
  readonly botId: string;
  readonly disabled?: boolean;
}) {
  const { t } = useI18n();
  const bot = useRosterStore((state) => state.bots.find((candidate) => candidate.id === botId));
  const environmentId = usePrimaryEnvironmentId();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const settings = usePrimarySettings();
  const updateBot = useAtomCommand(botEnvironment.update, { reportFailure: false });
  const [pickerOpen, setPickerOpen] = useState(false);

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
  const selection = useMemo(
    () =>
      resolveStickyBotEngine({
        engine: bot?.engine ?? null,
        instanceEntries,
        settings,
        providers,
        defaultSelection,
      }),
    [bot?.engine, defaultSelection, instanceEntries, providers, settings],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      getCustomModelOptionsByInstance(
        settings,
        providers,
        selection?.instanceId ?? null,
        selection?.model ?? null,
      ),
    [providers, selection?.instanceId, selection?.model, settings],
  );

  const selectable = selection !== null && !disabled;
  useEffect(() => {
    if (!selectable) return;
    return registerComposerModelPicker({ openModelPicker: () => setPickerOpen(true) });
  }, [selectable]);

  useEffect(() => {
    if (!selectable) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { modelPickerOpen: pickerOpen },
      });
      if (command !== "modelPicker.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      setPickerOpen((open) => !open);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, pickerOpen, selectable]);

  if (selection === null) return null;

  const changeModel = async (instanceId: ProviderInstanceId, model: string) => {
    if (environmentId === null || !bot) return;
    const options =
      defaultSelection.instanceId === instanceId && defaultSelection.model === model
        ? defaultSelection.options
        : undefined;
    const result = await updateBot({
      environmentId,
      input: {
        botId: BotId.make(bot.id),
        engine: { provider: instanceId, model, ...(options ? { options } : {}) },
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: t("Could not change the model") });
    }
  };

  return (
    <ProviderModelPicker
      activeInstanceId={ProviderInstanceId.make(selection.instanceId)}
      model={selection.model}
      lockedProvider={null}
      lockedContinuationGroupKey={null}
      instanceEntries={instanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      compact
      disabled={disabled}
      open={pickerOpen}
      triggerAriaLabel={t("Change model")}
      triggerClassName="max-w-52"
      onOpenChange={setPickerOpen}
      onInstanceModelChange={(instanceId, model) => {
        void changeModel(instanceId, model);
      }}
    />
  );
}
