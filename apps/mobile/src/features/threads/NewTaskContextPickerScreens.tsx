import { useMobileI18n } from "../../lib/i18n";
import * as Haptics from "expo-haptics";
import { useNavigation } from "@react-navigation/native";
import { type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useNewTaskFlow } from "./new-task-flow-provider";

function SelectionRow(props: {
  readonly icon?: "desktopcomputer";
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected: boolean;
  readonly isLast?: boolean;
  readonly subtitle?: string;
  readonly title: string;
}) {
  const iconColor = useThemeColor("--color-icon-muted");
  const checkmarkColor = useThemeColor("--color-icon");

  return (
    <Pressable
      accessibilityLabel={[props.title, props.subtitle].filter(Boolean).join(", ")}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
      style={{ opacity: props.disabled ? 0.45 : 1 }}
    >
      {props.icon ? (
        <SymbolView name={props.icon} size={17} tintColor={iconColor} type="monochrome" />
      ) : null}
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.title}
        </Text>
        {props.subtitle ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.subtitle}
          </Text>
        ) : null}
      </View>
      {props.selected ? (
        <SymbolView
          name="checkmark"
          size={16}
          tintColor={checkmarkColor}
          type="monochrome"
          weight="semibold"
        />
      ) : null}
    </Pressable>
  );
}

function PickerSurface(props: { readonly children: ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-card">{props.children}</View>;
}

export function NewTaskEnvironmentPickerRouteScreen() {
  const { t } = useMobileI18n();
  const flow = useNewTaskFlow();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-sheet" collapsable={false}>
      <NativeStackScreenOptions
        options={{
          headerShown: Platform.OS !== "android",
          title: "Environment",
        }}
      />
      {Platform.OS === "android" ? (
        <AndroidScreenHeader title={t("Environment")} onBack={() => navigation.goBack()} />
      ) : null}
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: 16,
          paddingTop: 16,
        }}
        showsVerticalScrollIndicator={false}
      >
        <PickerSurface>
          {flow.environments.map((environment, index) => (
            <SelectionRow
              key={String(environment.environmentId)}
              icon="desktopcomputer"
              isLast={index === flow.environments.length - 1}
              onPress={() => {
                void Haptics.selectionAsync();
                flow.selectEnvironment(environment.environmentId);
                navigation.goBack();
              }}
              selected={flow.selectedEnvironmentId === environment.environmentId}
              title={environment.environmentLabel}
            />
          ))}
        </PickerSurface>
      </ScrollView>
    </View>
  );
}
const { t } = useMobileI18n();
