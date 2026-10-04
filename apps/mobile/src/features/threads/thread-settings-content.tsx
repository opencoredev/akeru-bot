import { useMobileI18n } from "../../lib/i18n";
import { getProviderOptionCurrentLabel, getProviderOptionCurrentValue } from "@akeru/shared/model";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Alert, Platform, Pressable, ScrollView, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { ThemedSwitch } from "../../components/ThemedSwitch";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { RUNTIME_MODE_CHOICES, selectableChoices } from "./thread-settings-options";
import {
  type ThreadSettingsSubmenuPage,
  useThreadSettingsSession,
} from "./thread-settings-session";
import { useThreadSettingsPickerPresentation } from "./thread-settings-picker-context";

const THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION = LinearTransition.duration(180);

const THREAD_SETTINGS_OPTION_ENTER_TRANSITION = FadeIn.duration(140);

const THREAD_SETTINGS_OPTION_EXIT_TRANSITION = FadeOut.duration(100);

/** Compact row that opens a single-choice submenu panel. */
function DisclosureRow(props: {
  readonly label: string;
  readonly value: string | undefined;
  readonly onPress: () => void;
  readonly isLast?: boolean;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");

  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className={cn(
        "min-h-11 flex-row items-center gap-2 bg-card px-4 py-2 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <View className="flex-1" />
      {props.value ? (
        <Text className="text-sm text-foreground-muted" numberOfLines={1}>
          {props.value}
        </Text>
      ) : null}
      <SymbolView name="chevron.right" size={12} tintColor={iconSubtle} type="monochrome" />
    </Pressable>
  );
}

/** Single option inside a submenu panel. */
function ChoiceRow(props: {
  readonly label: string;
  readonly description?: string;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isLast: boolean;
}) {
  const checkmarkColor = useThemeColor("--color-icon");

  return (
    <Pressable
      accessibilityLabel={props.description ? `${props.label}. ${props.description}` : props.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected }}
      onPress={props.onPress}
      className={cn(
        "min-h-14 flex-row items-center gap-3 bg-card px-4 py-3 active:bg-subtle",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <View className="min-w-0 flex-1 gap-0.5">
        <Text className="text-base font-t3-medium text-foreground">{props.label}</Text>
        {props.description ? (
          <Text className="text-sm leading-5 text-foreground-muted">{props.description}</Text>
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

function SwitchRow(props: {
  readonly label: string;
  readonly value: boolean;
  readonly onValueChange: (value: boolean) => void;
  readonly isLast?: boolean;
}) {
  return (
    <View
      className={cn(
        "min-h-11 flex-row items-center justify-between bg-card px-4 py-1",
        !props.isLast && "border-b border-border-subtle",
      )}
    >
      <Text className="text-sm font-t3-medium text-foreground">{props.label}</Text>
      <ThemedSwitch
        accessibilityLabel={props.label}
        onValueChange={props.onValueChange}
        value={props.value}
      />
    </View>
  );
}

export function ThreadSettingsOptionsItem(props: {
  readonly animationsReady: boolean;
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const { t } = useMobileI18n();
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();

  const bottomToolbarInset =
    Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
      ? NATIVE_MAIL_SEARCH_TOOLBAR_CONTENT_INSET
      : 0;

  return (
    <View style={{ paddingBottom: insets.bottom + bottomToolbarInset + 12 }}>
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">
        {t("Options")}
      </Text>
      <Animated.View
        className="mx-4 overflow-hidden rounded-2xl bg-card"
        layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
      >
        {session.displayedDescriptors.map((descriptor) => {
          if (descriptor.type === "select") {
            return (
              <Animated.View
                key={descriptor.id}
                entering={
                  props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined
                }
                exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
                layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
              >
                <DisclosureRow
                  label={descriptor.label}
                  value={getProviderOptionCurrentLabel(descriptor)}
                  onPress={() => props.onOpenSubmenu({ kind: "descriptor", id: descriptor.id })}
                />
              </Animated.View>
            );
          }

          return (
            <Animated.View
              key={descriptor.id}
              entering={props.animationsReady ? THREAD_SETTINGS_OPTION_ENTER_TRANSITION : undefined}
              exiting={props.animationsReady ? THREAD_SETTINGS_OPTION_EXIT_TRANSITION : undefined}
              layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}
            >
              <SwitchRow
                label={descriptor.label}
                value={descriptor.currentValue ?? false}
                onValueChange={(value) => session.applyOptionChange(descriptor.id, value)}
              />
            </Animated.View>
          );
        })}
        <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
          <DisclosureRow
            isLast={!session.memoryThreadRef && !session.routinesRef}
            label={t("Runtime")}
            value={
              RUNTIME_MODE_CHOICES.find((choice) => choice.mode === session.runtimeMode)?.label
            }
            onPress={() => props.onOpenSubmenu({ kind: "runtime" })}
          />
        </Animated.View>
        {session.memoryThreadRef ? (
          <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
            <DisclosureRow
              isLast={!session.routinesRef}
              label={t("Memory")}
              value={t("Markdown and observations")}
              onPress={() => props.onOpenSubmenu({ kind: "memory" })}
            />
          </Animated.View>
        ) : null}
        {session.routinesRef ? (
          <Animated.View layout={THREAD_SETTINGS_OPTIONS_LAYOUT_TRANSITION}>
            <DisclosureRow
              isLast
              label={t("Routines")}
              value={session.routinesRef.botName}
              onPress={() => props.onOpenSubmenu({ kind: "routines" })}
            />
          </Animated.View>
        ) : null}
      </Animated.View>
      {session.canDelegate ? null : (
        <Text
          accessibilityRole="text"
          className="px-5 pt-2 text-xs leading-4 text-foreground-muted"
        >
          {t("This bot's provider cannot hand off work.")}{" "}
          {t("It cannot send work to other bots or receive work from them.")}
        </Text>
      )}

      <DeleteBotSection />

      {Platform.OS !== "ios" && session.hasLegacyModels ? (
        <>
          <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
            {t("Catalog")}
          </Text>
          <View className="mx-4 overflow-hidden rounded-2xl bg-card">
            <SwitchRow
              isLast
              label={t("Legacy models")}
              onValueChange={session.setShowLegacy}
              value={session.showLegacy}
            />
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Destructive bot removal, shown only for chats that belong to a bot. */
function DeleteBotSection() {
  const { t } = useMobileI18n();
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const [deleting, setDeleting] = useState(false);
  const onDeleteBot = session.onDeleteBot;
  const botName = session.routinesRef?.botName;

  if (!onDeleteBot || !botName) return null;

  const deleteBot = async () => {
    setDeleting(true);
    const failure = await onDeleteBot();
    setDeleting(false);

    if (failure !== null) {
      Alert.alert(t("Could not delete {name}", { name: botName }), failure);

      return;
    }

    presentation.onClose();
  };

  const confirmDelete = () =>
    Alert.alert(
      t("Delete {name}? Its chats stay in your history. This cannot be undone.", {
        name: botName,
      }),
      undefined,
      [
        { text: t("Cancel"), style: "cancel" },
        { text: t("Delete"), style: "destructive", onPress: () => void deleteBot() },
      ],
    );

  return (
    <>
      <Text className="px-5 pb-2 pt-7 text-sm font-t3-medium text-foreground-muted">
        {t("Danger")}
      </Text>
      <View className="mx-4 overflow-hidden rounded-2xl bg-card">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: deleting }}
          disabled={deleting}
          onPress={confirmDelete}
          className="min-h-11 flex-row items-center bg-card px-4 py-2 active:bg-subtle"
        >
          <Text className="text-sm font-t3-medium text-danger">
            {deleting ? t("Deleting…") : t("Delete bot")}
          </Text>
        </Pressable>
      </View>
      <Text className="px-5 pt-2 text-xs leading-4 text-foreground-muted">
        {t("Remove {name} from the roster. Its chats stay in your history.", { name: botName })}
      </Text>
    </>
  );
}

/** Compact choice page pushed by the picker navigator. */
export function ThreadSettingsChoiceContent(props: {
  readonly submenu: ThreadSettingsSubmenuPage;
  readonly onSelected: () => void;
}) {
  const insets = useSafeAreaInsets();
  const session = useThreadSettingsSession();
  const descriptorId = props.submenu.kind === "descriptor" ? props.submenu.id : null;

  const activeDescriptor =
    descriptorId !== null
      ? session.displayedDescriptors.find(
          (descriptor) => descriptor.type === "select" && descriptor.id === descriptorId,
        )
      : undefined;

  const submenuContent =
    props.submenu.kind === "runtime"
      ? {
          rows: RUNTIME_MODE_CHOICES.map((choice) => ({
            id: choice.mode,
            label: choice.label,
            description: choice.description,
            selected: choice.mode === session.runtimeMode,
            onPress: () => {
              void Haptics.selectionAsync();
              session.onUpdateRuntimeMode(choice.mode);
              props.onSelected();
            },
          })),
        }
      : activeDescriptor?.type === "select"
        ? {
            rows: selectableChoices(activeDescriptor).map((choice) => ({
              id: choice.id,
              label: choice.label,
              description: undefined,
              selected: choice.id === getProviderOptionCurrentValue(activeDescriptor),
              onPress: () => {
                void Haptics.selectionAsync();
                session.applyOptionChange(activeDescriptor.id, choice.id);
                props.onSelected();
              },
            })),
          }
        : null;

  if (!submenuContent) {
    return <View className="flex-1 bg-sheet" />;
  }

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{
        paddingBottom: insets.bottom + 12,
        paddingHorizontal: 16,
        paddingTop: 16,
      }}
      contentInsetAdjustmentBehavior="automatic"
      showsVerticalScrollIndicator={false}
    >
      <View className="overflow-hidden rounded-2xl bg-card">
        {submenuContent.rows.map((row, index) => (
          <ChoiceRow
            key={row.id}
            description={row.description}
            isLast={index === submenuContent.rows.length - 1}
            label={row.label}
            selected={row.selected}
            onPress={row.onPress}
          />
        ))}
      </View>
    </ScrollView>
  );
}
