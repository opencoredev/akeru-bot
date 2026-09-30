import { useMobileI18n } from "../../lib/i18n";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { SidebarProjectGroupingMode } from "@akeru/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  mobileProjectGroupingModePatch,
  resolveMobileProjectGroupingSettings,
} from "../../state/project-grouping";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";

export function SettingsProjectGroupingRouteScreen() {
  const { t } = useMobileI18n();
  const groupingOptions: ReadonlyArray<{
    readonly mode: SidebarProjectGroupingMode;
    readonly label: string;
    readonly description: string;
  }> = [
    {
      mode: "repository",
      label: t("Group by repository"),
      description: t("Matching repositories appear as one project."),
    },
    {
      mode: "repository_path",
      label: t("Group by repository path"),
      description: t("Keep monorepo paths separate."),
    },
    {
      mode: "separate",
      label: t("Keep separate"),
      description: t("Show every workspace as its own project."),
    },
  ];
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const checkmarkColor = useThemeColor("--color-icon");
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const preferencesReady = AsyncResult.isSuccess(preferencesResult) && !preferencesResult.waiting;
  const selectedMode = AsyncResult.isSuccess(preferencesResult)
    ? resolveMobileProjectGroupingSettings(preferencesResult.value).sidebarProjectGroupingMode
    : null;

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader title={t("Project Grouping")} onBack={() => navigation.goBack()} />
        </>
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-3 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <SettingsSection title={t("Default grouping")}>
          {groupingOptions.map((option, index) => (
            <Pressable
              key={option.mode}
              accessibilityRole="radio"
              accessibilityState={{
                checked: selectedMode === option.mode,
                disabled: !preferencesReady,
              }}
              disabled={!preferencesReady}
              onPress={() => savePreferences(mobileProjectGroupingModePatch(option.mode))}
              className={
                index === 0
                  ? "flex-row items-center gap-4 p-4"
                  : "flex-row items-center gap-4 border-t border-border-subtle p-4"
              }
            >
              <View className="min-w-0 flex-1 gap-1">
                <Text className="text-lg text-foreground">{option.label}</Text>
                <Text className="text-sm leading-normal text-foreground-muted">
                  {option.description}
                </Text>
              </View>
              {selectedMode === option.mode ? (
                <SymbolView
                  name="checkmark"
                  size={18}
                  tintColor={checkmarkColor}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </Pressable>
          ))}
        </SettingsSection>
      </ScrollView>
    </View>
  );
}
