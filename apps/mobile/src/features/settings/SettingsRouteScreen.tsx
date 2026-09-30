import { useMobileI18n } from "../../lib/i18n";
import { useAtomValue } from "@effect/atom-react";
import {
  MEMORY_SETTING_DISABLED_HINT,
  SHARED_PROJECT_MEMORY_SETTING,
  sharedProjectMemoryAutoSaves,
  sharedProjectMemoryMode,
} from "@akeru/client-runtime/durable-memory";
import type { MessageKey } from "@akeru/client-runtime/i18n";
import { EnvironmentId } from "@akeru/contracts";
import type { MemorySettingsPatch } from "@akeru/contracts/settings";
import Constants from "expo-constants";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  type AppUpdateCheckState,
  isAppUpdateCheckAvailable,
  registerHiddenUpdateTap,
  runAppUpdateCheck,
} from "../updates/app-updates";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "./components/SettingsRow";
import { LanguageSettingsSection } from "./LanguageSettingsSection";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { RemoteHealthSection } from "./RemoteHealthSection";
import { ReplyReadoutPreference } from "../replyPlayback/ReplyReadoutPreference";
import { useOptionalReplyPlayback } from "../replyPlayback/ReplyPlaybackProvider";
import {
  privacyControlPatch,
  type PrivacyControl,
  resolveSettingsEnvironmentId,
} from "./SettingsRouteScreen.logic";

type SettingsRouteParams = {
  readonly environmentId?: EnvironmentId | ReadonlyArray<string> | null;
};

export function SettingsRouteScreen({ route }: StaticScreenProps<SettingsRouteParams | undefined>) {
  const { t } = useMobileI18n();
  const navigation = useNavigation();
  const rawEnvironmentId = route.params?.environmentId;
  const environmentId =
    typeof rawEnvironmentId === "string"
      ? EnvironmentId.make(rawEnvironmentId)
      : rawEnvironmentId?.[0] === undefined
        ? null
        : EnvironmentId.make(rawEnvironmentId[0]);

  return (
    <>
      <WorkspaceSidebarToolbar />
      {Platform.OS === "android" ? (
        <>
          {/* Android renders its own in-screen header instead of the native bar. */}
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={t("Settings")} onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: t("Close settings"),
                      icon: { name: "xmark", type: "sfSymbol" } as const,
                      identifier: "settings-close",
                      label: "",
                      onPress: () => navigation.goBack(),
                      type: "button",
                    }),
                  ]
                : undefined,
          }}
        />
      )}
      <LocalSettingsRouteScreen environmentId={environmentId} />
    </>
  );
}

function LocalSettingsRouteScreen({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { t } = useMobileI18n();
  const insets = useSafeAreaInsets();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connections = Object.values(savedConnectionsById);
  const environmentCount = connections.length;
  const settingsEnvironmentId = resolveSettingsEnvironmentId(
    environmentId,
    connections.map((connection) => connection.environmentId),
  );

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <SettingsSection title={t("Configuration")}>
          <SettingsRow
            icon="desktopcomputer"
            label={t("Environments")}
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <ProviderSettingsSection environmentId={settingsEnvironmentId} />

        <ErrorsSettingsSection environmentId={connections[0]?.environmentId ?? null} />

        {settingsEnvironmentId !== null ? (
          <RemoteHealthSection environmentId={settingsEnvironmentId} />
        ) : null}

        <LanguageSettingsSection />

        <GeneralSettingsSection />

        <PrivacySettingsSection environmentId={settingsEnvironmentId} />

        <MemorySettingsSection environmentId={settingsEnvironmentId} />

        <SettingsSection title={t("Appearance")}>
          <SettingsRow icon="paintbrush" label={t("Appearance")} target="SettingsAppearance" />
        </SettingsSection>

        <ArchivedThreadsSettingsSection />

        <AppSettingsSection />
      </ScrollView>
    </View>
  );
}

function ProviderSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { t } = useMobileI18n();
  const navigation = useNavigation();
  return (
    <SettingsSection title={t("Providers")}>
      {environmentId === null ? (
        <Text className="text-sm text-foreground-muted">
          {t("Open Settings from an environment to connect a provider.")}
        </Text>
      ) : (
        <>
          <SettingsRow
            icon="key"
            label={t("Provider connections")}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsProviderHealth",
                  params: { environmentId, target: "providers" },
                },
              })
            }
          />
          <SettingsRow
            icon="photo"
            label={t("Image generation")}
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: {
                  screen: "SettingsProviderHealth",
                  params: { environmentId, target: "image-generation" },
                },
              })
            }
          />
        </>
      )}
    </SettingsSection>
  );
}

function ErrorsSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const { t } = useMobileI18n();
  const navigation = useNavigation();
  if (environmentId === null) return null;
  return (
    <SettingsSection title={t("Health")}>
      <SettingsRow
        icon="exclamationmark.triangle"
        label={t("Bot inbox")}
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: "SettingsContent",
            params: {
              screen: "SettingsProviderHealth",
              params: { environmentId, target: "bot-inbox" },
            },
          })
        }
      />
    </SettingsSection>
  );
}

function AutomaticReadoutSettingsRow() {
  const session = useOptionalReplyPlayback();
  if (!session) return null;
  return (
    <View className="px-4 py-3">
      <ReplyReadoutPreference preference={session.preference} />
    </View>
  );
}

function PrivacySettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  if (environmentId === null) return null;
  return <EnvironmentPrivacySettingsSection environmentId={environmentId} />;
}

function EnvironmentPrivacySettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { t } = useMobileI18n();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  if (!settings) return null;

  const updateControl = (control: PrivacyControl, enabled: boolean) => {
    void updateSettings({
      environmentId,
      input: { patch: privacyControlPatch(control, enabled) },
    });
  };

  return (
    <SettingsSection title={t("Privacy")}>
      <SettingsSwitchRow
        icon="chart.bar.xaxis"
        label={t("Anonymous analytics")}
        value={settings.analyticsEnabled}
        onValueChange={(enabled) => updateControl("analytics", enabled)}
      />
      <SettingsSwitchRow
        icon="text.bubble"
        label={t("Product feedback")}
        value={settings.productFeedbackEnabled}
        onValueChange={(enabled) => updateControl("product-feedback", enabled)}
      />
      <SettingsSwitchRow
        icon="bolt.circle"
        label={t("Voice calls")}
        subtitle={t(
          "Controls this environment's web and desktop calls. Native mobile audio calls are not supported. Configure voice services in web or desktop Settings.",
        )}
        value={settings.voice.enabled}
        onValueChange={(enabled) => updateControl("voice", enabled)}
      />
      <AutomaticReadoutSettingsRow />
    </SettingsSection>
  );
}

function MemorySettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  if (environmentId === null) return null;
  return <EnvironmentMemorySettingsSection environmentId={environmentId} />;
}

function EnvironmentMemorySettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const { t } = useMobileI18n();
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  if (!settings) return null;

  const updateMemory = (memory: MemorySettingsPatch) => {
    void updateSettings({ environmentId, input: { patch: { memory } } });
  };
  const memory = settings.memory;
  const memoryHint = (description: MessageKey) =>
    memory.enabled ? t(description) : `${t(description)} ${t(MEMORY_SETTING_DISABLED_HINT)}`;

  return (
    <SettingsSection title={t("Memory")}>
      <SettingsSwitchRow
        icon="doc.text"
        label={t("Memory")}
        subtitle={t("Keep durable facts that bots can use across chats.")}
        value={memory.enabled}
        onValueChange={(enabled) => updateMemory({ enabled })}
      />
      <SettingsSwitchRow
        disabled={!memory.enabled}
        icon="person.crop.circle"
        label={t("Private bot memory")}
        subtitle={memoryHint("Let each bot keep facts about you that only that bot uses.")}
        value={memory.privateBotMemory}
        onValueChange={(privateBotMemory) => updateMemory({ privateBotMemory })}
      />
      <SettingsSwitchRow
        disabled={!memory.enabled}
        icon="folder.fill"
        label={t(SHARED_PROJECT_MEMORY_SETTING.label)}
        subtitle={memoryHint(SHARED_PROJECT_MEMORY_SETTING.description)}
        value={sharedProjectMemoryAutoSaves(memory.sharedProjectMemory)}
        onValueChange={(auto) =>
          updateMemory({ sharedProjectMemory: sharedProjectMemoryMode(auto) })
        }
      />
    </SettingsSection>
  );
}

function GeneralSettingsSection() {
  const { t } = useMobileI18n();
  return (
    <SettingsSection title={t("General")}>
      <SettingsRow icon="folder" label={t("Project Grouping")} target="SettingsProjectGrouping" />
      <SettingsRow icon="chart.bar.xaxis" label={t("Usage")} target="SettingsUsage" />
    </SettingsSection>
  );
}

function AppSettingsSection() {
  const { t } = useMobileI18n();
  const icon = useThemeColor("--color-icon");
  const [updateState, setUpdateState] = useState<AppUpdateCheckState>("idle");
  const updateInFlight = useRef(false);
  const hiddenUpdateTapCount = useRef(0);

  const version = Constants.expoConfig?.version ?? "0.0.0";
  // Fall back to "production" to match resolveAppVariant in app.config.ts, so a
  // missing variant never mislabels a production build as development.
  const variant = (Constants.expoConfig?.extra?.appVariant as string | undefined) ?? "production";
  const variantLabel = variant === "production" ? "" : capitalize(variant);
  const versionLabel = variantLabel ? `${version} · ${variantLabel}` : version;
  const updateCheckAvailable = isAppUpdateCheckAvailable();
  const busy =
    updateState === "checking" || updateState === "downloading" || updateState === "restarting";

  // "Up to date" is a transient acknowledgement, not a state worth persisting —
  // return the version row to its normal, deliberately quiet state.
  useEffect(() => {
    if (updateState !== "current") return;
    const timer = setTimeout(() => setUpdateState("idle"), 3000);
    return () => clearTimeout(timer);
  }, [updateState]);

  const checkForUpdate = useCallback(async () => {
    // `disabled={busy}` only takes effect on the next render, so two taps in the
    // same frame would both get through. The ref closes that window.
    if (updateInFlight.current) return;
    updateInFlight.current = true;
    try {
      // The user asked for this restart by tapping the version row, so it may
      // apply immediately instead of prompting.
      await runAppUpdateCheck({
        applyMode: "immediate",
        onFailure: (message) => Alert.alert(t("Update failed"), message),
        onStateChange: setUpdateState,
      });
    } finally {
      updateInFlight.current = false;
    }
  }, []);

  const handleVersionPress = useCallback(() => {
    if (!updateCheckAvailable || updateInFlight.current) return;
    const tap = registerHiddenUpdateTap(hiddenUpdateTapCount.current);
    hiddenUpdateTapCount.current = tap.nextCount;
    if (tap.shouldCheck) {
      void checkForUpdate();
    }
  }, [checkForUpdate, updateCheckAvailable]);

  const statusLabel =
    updateState === "checking"
      ? t("Checking…")
      : updateState === "downloading"
        ? t("Downloading…")
        : // "ready" appears only when this check joined an in-flight background-mode
          // check; that download installs at the next backgrounding.
          updateState === "ready"
          ? t("Update ready")
          : updateState === "restarting"
            ? t("Restarting…")
            : updateState === "current"
              ? t("Up to date")
              : null;

  const versionRow = (
    <View className="flex-row items-center gap-4 p-4">
      <SymbolView
        name="info.circle"
        size={22}
        tintColor={icon}
        type="monochrome"
        weight="regular"
      />
      <Text className="flex-1 text-lg text-foreground">{t("Version")}</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title={t("App")}>
      <SettingsRow
        icon="internaldrive"
        label={t("Client Storage")}
        target="SettingsClientStorage"
      />
      <SettingsRow icon="doc.text" label={t("Legal")} fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={t("Version {version}", { version: versionLabel })}
          accessibilityRole="text"
          disabled={busy}
          onPress={handleVersionPress}
        >
          {versionRow}
        </Pressable>
      ) : (
        versionRow
      )}
    </SettingsSection>
  );
}

function capitalize(value: string): string {
  return value.length > 0 ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function ArchivedThreadsSettingsSection() {
  const { t } = useMobileI18n();
  return (
    <SettingsSection title={t("Chats")}>
      <SettingsRow icon="archivebox" label={t("Archived chats")} target="SettingsArchive" />
    </SettingsSection>
  );
}
