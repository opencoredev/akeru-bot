import { Predicate } from "effect";
import { useAtomValue } from "@effect/atom-react";
import { BotId, ProviderInstanceId, type BotEngine } from "@akeru/contracts";
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
import { botEngineForModelPick, resolveStickyBotEngine } from "./botEngineSelection";
import { useRosterStore } from "./rosterStore";

/**
 * The bot's engine at the composer: shows which model answers the next message
 * and opens the shared model picker. Model changes retain the bot's saved
 * reasoning when the selected model supports it.
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

  // Only a live bot's own composer edits an engine; a group or archived bot never does.
  if (selection === null || !bot || bot.archivedAt !== null) return null;

  const saveEngine = async (engine: BotEngine, failureTitle: string) => {
    if (environmentId === null) return;

    const result = await updateBot({
      environmentId,
      input: { botId: BotId.make(bot.id), engine },
    });

    if (Predicate.isTagged(result, "Failure")) {
      toastManager.add({ type: "error", title: failureTitle });
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
      triggerFit="capped"
      onOpenChange={setPickerOpen}
      onInstanceModelChange={(instanceId, model) => {
        void saveEngine(
          botEngineForModelPick({ previous: selection, instanceId, model, instanceEntries }),
          t("Could not change the model"),
        );
      }}
    />
  );
}
