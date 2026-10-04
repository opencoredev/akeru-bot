import { Predicate } from "effect";
import type {
  EnvironmentId,
  ModelSelection,
  OrchestrationBot,
  OrchestrationThreadShell,
  RuntimeMode,
  ServerConfig,
  SubscriptionProviderStatus,
} from "@akeru/contracts";
import { squashAtomCommandFailure } from "@akeru/client-runtime/state/runtime";
import { useCallback, useEffect, useMemo } from "react";

import { useMobileI18n } from "../../lib/i18n";
import { buildModelOptions, groupByProvider } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { botEnvironment } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ExistingThreadSettingsRouteSession } from "./ThreadSettingsSheet";

/**
 * The composer's model and settings sheet: the chat's model row, the session
 * the settings sheet edits, and the action that opens it. Model and option
 * changes go through `onUpdateModelSelection`, which decides whether they land
 * on the chat draft or on a direct bot's engine.
 */
export function useThreadComposerSettings(input: {
  readonly environmentId: EnvironmentId;
  readonly selectedThread: OrchestrationThreadShell;
  readonly serverConfig: ServerConfig | null;
  readonly subscriptionStatuses: ReadonlyArray<SubscriptionProviderStatus> | undefined;
  readonly bot: OrchestrationBot | undefined;
  readonly settingsOwnerId: string;
  readonly settingsRoutePresentation: {
    readonly present: (session: ExistingThreadSettingsRouteSession) => void;
  };
  readonly settingsSheetPresentation: { readonly isActive: boolean; readonly open: () => void };
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
}) {
  const {
    environmentId,
    selectedThread,
    serverConfig,
    subscriptionStatuses,
    bot,
    settingsOwnerId,
    onUpdateModelSelection,
    onUpdateRuntimeMode,
  } = input;

  const presentSettingsRoute = input.settingsRoutePresentation.present;
  const settingsSheetActive = input.settingsSheetPresentation.isActive;
  const openSettingsSheet = input.settingsSheetPresentation.open;
  const { t } = useMobileI18n();
  const deleteBot = useAtomCommand(botEnvironment.delete, { reportFailure: false });
  const currentModelSelection = selectedThread.modelSelection;
  const currentRuntimeMode = selectedThread.runtimeMode;

  const modelOptions = useMemo(
    () => buildModelOptions(serverConfig, currentModelSelection, subscriptionStatuses, t),
    [serverConfig, currentModelSelection, subscriptionStatuses, t],
  );

  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);

  // An existing thread is bound to its harness: sessions can't move between
  // provider instances, so the picker only offers the thread's own group.
  const threadProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.providerKey === currentModelSelection.instanceId),
    [providerGroups, currentModelSelection.instanceId],
  );

  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;

  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );

  const deleteThreadBot = useCallback(async () => {
    if (!bot) return t("The command failed.");

    const result = await deleteBot({
      environmentId: environmentId,
      input: { botId: bot.id },
    });

    if (!Predicate.isTagged(result, "Failure")) return null;
    const error = squashAtomCommandFailure(result);

    return error instanceof Error ? error.message : t("The command failed.");
  }, [bot, deleteBot, environmentId, t]);

  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      ...(bot && bot.archivedAt === null && selectedThread.groupId === null
        ? { engineBotRef: { environmentId, botId: bot.id } }
        : {}),
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: onUpdateRuntimeMode,
      ...(bot
        ? {
            memoryThreadRef: {
              environmentId: environmentId,
              threadId: selectedThread.id,
            },
            routinesRef: {
              environmentId: environmentId,
              botId: bot.id,
              botName: bot.name,
            },
          }
        : {}),
      ...(bot
        ? {
            onDeleteBot: deleteThreadBot,
          }
        : {}),
    }),
    [
      currentModelSelection,
      currentRuntimeMode,
      bot,
      deleteThreadBot,
      environmentId,
      onUpdateModelSelection,
      onUpdateRuntimeMode,
      selectedThread.id,
      selectedThread.groupId,
      providerOptionDescriptors,
      settingsOwnerId,
      threadProviderGroups,
    ],
  );

  const openSettings = useCallback(() => {
    presentSettingsRoute(settingsRouteSession);
    openSettingsSheet();
  }, [presentSettingsRoute, settingsRouteSession, openSettingsSheet]);

  useEffect(() => {
    if (settingsSheetActive) {
      presentSettingsRoute(settingsRouteSession);
    }
  }, [presentSettingsRoute, settingsRouteSession, settingsSheetActive]);

  return { currentModelSelection, currentModelOption, openSettings };
}
