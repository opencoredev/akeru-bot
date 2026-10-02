import { useMobileI18n } from "../../lib/i18n";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useMemo } from "react";
import { Platform } from "react-native";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions, nativeHeaderScrollEdgeEffects } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import { ThreadMemoryScreen } from "./ThreadMemoryScreen";
import { ThreadRoutinesScreen } from "./ThreadRoutinesScreen";
import {
  type ThreadSettingsPickerPresentation,
  ThreadSettingsPickerPresentationContext,
  ThreadSettingsPickerStack,
  type ThreadSettingsPickerStackParams,
} from "./thread-settings-picker-context";
import { ThreadSettingsChoiceContent } from "./thread-settings-content";
import { ThreadSettingsModelsScreen } from "./thread-settings-catalog";

const THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(
  Platform.OS,
  Platform.Version,
);

function ThreadSettingsChoiceScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const route = useRoute<RouteProp<ThreadSettingsPickerStackParams, "ThreadSettingsChoice">>();

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: Platform.OS !== "android" }} />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={route.params.title} onBack={() => navigation.goBack()} />
      ) : null}
      <ThreadSettingsChoiceContent submenu={route.params} onSelected={() => navigation.goBack()} />
    </>
  );
}

export function ThreadSettingsPickerNavigator(props: ThreadSettingsPickerPresentation) {
  const { t } = useMobileI18n();
  const solidSheetBackground = String(useThemeColor("--color-sheet-solid"));
  const foreground = String(useThemeColor("--color-foreground"));

  const presentation = useMemo(
    () => ({
      onClose: props.onClose,
    }),
    [props.onClose],
  );

  return (
    <ThreadSettingsPickerPresentationContext.Provider value={presentation}>
      <ThreadSettingsPickerStack.Navigator
        initialRouteName="ThreadSettingsModels"
        screenOptions={{
          animation: "slide_from_right",
          contentStyle: { backgroundColor: solidSheetBackground },
          gestureEnabled: true,
          headerBackButtonDisplayMode: "minimal",
          headerBackTitle: "",
          headerShadowVisible: false,
          headerStyle: {
            backgroundColor: NATIVE_LIQUID_GLASS_SUPPORTED ? "transparent" : solidSheetBackground,
          },
          headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
          headerTintColor: foreground,
          headerTitleStyle: { fontSize: 17, fontWeight: "700" },
          scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED
            ? THREAD_SETTINGS_HEADER_SCROLL_EDGE_EFFECTS
            : undefined,
        }}
      >
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsModels"
          component={ThreadSettingsModelsScreen}
          options={{ headerBackVisible: false, title: t("Chat settings") }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsMemory"
          component={ThreadMemoryScreen}
          options={{ title: t("Memory") }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsRoutines"
          component={ThreadRoutinesScreen}
          options={{ title: t("Routines") }}
        />
        <ThreadSettingsPickerStack.Screen
          name="ThreadSettingsChoice"
          component={ThreadSettingsChoiceScreen}
          options={({ route }) => ({ title: route.params.title })}
        />
      </ThreadSettingsPickerStack.Navigator>
    </ThreadSettingsPickerPresentationContext.Provider>
  );
}
