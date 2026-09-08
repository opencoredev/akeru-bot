import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import Constants from "expo-constants";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import { WorkspaceSidebarToolbar } from "../layout/workspace-sidebar-toolbar";
import { useThemeColor } from "../../lib/useThemeColor";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
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
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import {
  privacyControlPatch,
  type PrivacyControl,
  resolveSettingsEnvironmentId,
} from "./SettingsRouteScreen.logic";

type SettingsRouteParams = {
  readonly environmentId?: EnvironmentId | ReadonlyArray<string> | null;
};

export function SettingsRouteScreen({ route }: StaticScreenProps<SettingsRouteParams | undefined>) {
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
          <AndroidScreenHeader title="Settings" onBack={() => navigation.goBack()} />
        </>
      ) : (
        <NativeStackScreenOptions
          options={{
            unstable_headerRightItems:
              Platform.OS === "ios"
                ? () => [
                    withNativeGlassHeaderItem({
                      accessibilityLabel: "Close settings",
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
        <SettingsSection title="Configuration">
          <SettingsRow
            icon="desktopcomputer"
            label="Environments"
            value={`${environmentCount}`}
            target="SettingsEnvironments"
          />
        </SettingsSection>

        <ProviderSettingsSection environmentId={settingsEnvironmentId} />

        <ErrorsSettingsSection environmentId={connections[0]?.environmentId ?? null} />

        <GeneralSettingsSection />

        <PrivacySettingsSection environmentId={settingsEnvironmentId} />

        <SettingsSection title="Appearance">
          <SettingsRow icon="paintbrush" label="Appearance" target="SettingsAppearance" />
        </SettingsSection>

        <LegacySettingsSection />

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
  const navigation = useNavigation();
  return (
    <SettingsSection title="Providers">
      {environmentId === null ? (
        <Text className="text-sm text-foreground-muted">
          Open Settings from an environment to connect a provider.
        </Text>
      ) : (
        <SettingsRow
          icon="key"
          label="Provider connections"
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
      )}
    </SettingsSection>
  );
}

function ErrorsSettingsSection({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const navigation = useNavigation();
  if (environmentId === null) return null;
  return (
    <SettingsSection title="Health">
      <SettingsRow
        icon="exclamationmark.triangle"
        label="Errors"
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
    <SettingsSection title="Privacy">
      <SettingsSwitchRow
        icon="chart.bar.xaxis"
        label="Anonymous analytics"
        value={settings.analyticsEnabled}
        onValueChange={(enabled) => updateControl("analytics", enabled)}
      />
      <SettingsSwitchRow
        icon="text.bubble"
        label="Product feedback"
        value={settings.productFeedbackEnabled}
        onValueChange={(enabled) => updateControl("product-feedback", enabled)}
      />
      <SettingsSwitchRow
        icon="bolt.circle"
        label="Voice calls"
        value={settings.voice.enabled}
        onValueChange={(enabled) => updateControl("voice", enabled)}
      />
      <SettingsSwitchRow
        icon="arrow.clockwise"
        label="Provider update checks"
        value={settings.enableProviderUpdateChecks}
        onValueChange={(enabled) => updateControl("provider-update-checks", enabled)}
      />
    </SettingsSection>
  );
}

function GeneralSettingsSection() {
  return (
    <SettingsSection title="General">
      <SettingsRow icon="folder" label="Project Grouping" target="SettingsProjectGrouping" />
      <SettingsRow icon="chart.bar.xaxis" label="Usage" target="SettingsUsage" />
    </SettingsSection>
  );
}

/**
 * Device-local legacy toggles. Mobile has no client-settings sync, so this is
 * the counterpart of web's Settings → General → Legacy features backed by
 * mobile preferences.
 */
function LegacySettingsSection() {
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const threadListV2Enabled = useThreadListV2Enabled();
  const planModeEnabled =
    AsyncResult.isSuccess(preferences) && preferences.value.planModeEnabled === true;

  return (
    <View className="gap-3">
      <SettingsSection title="Legacy">
        <SettingsSwitchRow
          icon="sidebar.left"
          label="Legacy Chat List"
          value={!threadListV2Enabled}
          onValueChange={(value) => savePreferences({ legacyThreadListEnabled: value })}
        />
        <SettingsSwitchRow
          icon="hammer"
          label="Plan Mode"
          value={planModeEnabled}
          onValueChange={(value) => savePreferences({ planModeEnabled: value })}
        />
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Opt into retired interfaces kept for compatibility. Plan Mode restores the Build/Plan
        control; otherwise every task runs in Build mode.
      </Text>
    </View>
  );
}

function AppSettingsSection() {
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
        onFailure: (message) => Alert.alert("Update failed", message),
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
      ? "Checking…"
      : updateState === "downloading"
        ? "Downloading…"
        : // "ready" appears only when this check joined an in-flight background-mode
          // check; that download installs at the next backgrounding.
          updateState === "ready"
          ? "Update ready"
          : updateState === "restarting"
            ? "Restarting…"
            : updateState === "current"
              ? "Up to date"
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
      <Text className="flex-1 text-lg text-foreground">Version</Text>
      <View className="items-end">
        <Text className="text-lg text-foreground-muted">{versionLabel}</Text>
        {statusLabel ? (
          <Text className="text-xs text-foreground-muted/70">{statusLabel}</Text>
        ) : null}
      </View>
    </View>
  );

  return (
    <SettingsSection title="App">
      <SettingsRow icon="internaldrive" label="Client Storage" target="SettingsClientStorage" />
      <SettingsRow icon="doc.text" label="Legal" fullScreenTarget="SettingsLegal" />
      {updateCheckAvailable ? (
        <Pressable
          accessibilityLabel={`Version ${versionLabel}`}
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
  return (
    <SettingsSection title="Chats">
      <SettingsRow icon="archivebox" label="Archived conversations" target="SettingsArchive" />
    </SettingsSection>
  );
}
