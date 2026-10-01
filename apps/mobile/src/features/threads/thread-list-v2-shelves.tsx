import { useMobileI18n } from "../../lib/i18n";
import { memo } from "react";
import { Pressable, View } from "react-native";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

/** Section label + rule: the only structure in an otherwise flat list. */
export const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  const borderColor = useThemeColor("--color-border");
  return (
    <View
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">{props.label}</Text>
      <View className="h-px flex-1" style={{ backgroundColor: borderColor }} />
    </View>
  );
});

const SNOOZE_ACCENT_LIGHT = "#2563eb";
const SNOOZE_ACCENT_DARK = "#60a5fa";

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(props: {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const { t } = useMobileI18n();
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the snoozed chats." : "Expands the snoozed chats."
      }
      accessibilityLabel={props.count === 1 ? "1 snoozed chat" : `${props.count} snoozed chats`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-blue-600 dark:text-blue-400">
        {props.expanded ? t("Snoozed") : `${t("Snoozed")} (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-blue-500/20 dark:bg-blue-400/15" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColor={colorScheme === "dark" ? SNOOZE_ACCENT_DARK : SNOOZE_ACCENT_LIGHT}
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(props: {
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const { t } = useMobileI18n();
  const mutedColor = useThemeColor("--color-foreground-muted");
  return (
    <Pressable
      accessibilityHint={
        props.expanded ? "Collapses the settled chats." : "Expands the settled chats."
      }
      accessibilityLabel={props.count === 1 ? "1 settled chat" : `${props.count} settled chats`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, expanded: props.expanded }}
      className={cn(
        "mb-1.5 mt-4 flex-row items-center gap-2.5",
        props.pane === "sidebar" ? "px-3" : "px-5",
      )}
      disabled={props.disabled}
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        {props.expanded ? t("Settled") : `${t("Settled")} (${props.count})`}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColor={mutedColor}
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
    </Pressable>
  );
});
