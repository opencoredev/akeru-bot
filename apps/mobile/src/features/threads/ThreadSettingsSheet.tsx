import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useEffect, useMemo } from "react";
import { View } from "react-native";
import { botEngineModelSelection } from "@akeru/shared/model";
import { useMobileI18n } from "../../lib/i18n";
import { buildModelOptions } from "../../lib/modelOptions";
import { useThreadEngineBot } from "../../state/use-thread-engine-bot";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useNewTaskFlow } from "./new-task-flow-provider";
import {
  ThreadSettingsSessionProvider,
  useExistingThreadSettingsRoutePresentation,
} from "./thread-settings-session";
import { ThreadSettingsPickerNavigator } from "./thread-settings-picker";
import { liveBotThreadSettings } from "./thread-settings-bot-engine";

export {
  ExistingThreadSettingsRouteProvider,
  useExistingThreadSettingsRoutePresentation,
} from "./thread-settings-session";

export type { ExistingThreadSettingsRouteSession } from "./thread-settings-session";

/** Existing-thread model picker hosted by the root RNS form-sheet route. */
export function ExistingThreadSettingsRouteScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<{ ThreadSettings: undefined }>>();
  const presentation = useExistingThreadSettingsRoutePresentation();
  const session = presentation.session;
  const { t } = useMobileI18n();
  const engineBotRef = session?.engineBotRef;
  const bot = useThreadEngineBot(engineBotRef?.environmentId, engineBotRef);
  const runtime = useRemoteEnvironmentRuntime(engineBotRef?.environmentId ?? null);
  const selection = bot?.engine ? botEngineModelSelection(bot.engine) : session?.selectedModel;

  // Same account check as the composer, so the sheet never offers a model Send would block.
  const subscriptionAuth = useEnvironmentQuery(
    engineBotRef
      ? serverEnvironment.subscriptionAuth({ environmentId: engineBotRef.environmentId, input: {} })
      : null,
  );

  const subscriptionStatuses = subscriptionAuth.data?.providers;

  const liveModels = useMemo(
    () =>
      buildModelOptions(runtime?.serverConfig ?? null, selection ?? null, subscriptionStatuses, t),
    [runtime?.serverConfig, selection, subscriptionStatuses, t],
  );

  useEffect(() => {
    if (session) {
      return;
    }

    navigation.goBack();
  }, [navigation, session]);

  if (!session) {
    return <View className="flex-1 bg-sheet" />;
  }

  const {
    ownerId: _ownerId,
    engineBotRef: _engineBotRef,
    ...settings
  } = liveBotThreadSettings(session, bot, liveModels);

  return (
    <ThreadSettingsSessionProvider {...settings}>
      <ThreadSettingsPickerNavigator onClose={() => navigation.goBack()} />
    </ThreadSettingsSessionProvider>
  );
}

/**
 * Native stack hosted by the New Task navigator's form-sheet route. Keeping
 * the sheet presentation in RNS gives UIKit ownership of nested dismissal,
 * while Reasoning and Runtime remain regular pushes inside this navigator.
 */
export function NewTaskThreadSettingsRouteScreen() {
  const flow = useNewTaskFlow();
  const navigation = useNavigation<NativeStackNavigationProp<{ ThreadSettings: undefined }>>();

  const optionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: flow.selectedModelOption?.capabilities,
        selections: flow.selectedModel?.options,
      }),
    [flow.selectedModel?.options, flow.selectedModelOption?.capabilities],
  );

  return (
    <ThreadSettingsSessionProvider
      providerGroups={flow.providerGroups}
      selectedModel={flow.selectedModel}
      onSelectModel={(option) => flow.setSelectedModelKey(option.key, option.selection.options)}
      optionDescriptors={optionDescriptors}
      onUpdateOptionSelections={flow.setSelectedModelOptions}
      runtimeMode={flow.runtimeMode}
      onUpdateRuntimeMode={flow.setRuntimeMode}
    >
      <ThreadSettingsPickerNavigator onClose={() => navigation.goBack()} />
    </ThreadSettingsSessionProvider>
  );
}
