import { useMobileI18n } from "../../lib/i18n";
import type { LegendListRenderItemProps } from "@legendapp/list/react-native";
import { AnimatedLegendList } from "@legendapp/list/reanimated";
import { HeaderHeightContext } from "@react-navigation/elements";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { use, useCallback, useMemo, useState, type ReactNode } from "react";
import { Platform, Pressable, TextInput, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ProviderIcon } from "../../components/ProviderIcon";
import { cn } from "../../lib/cn";
import type { ModelOption } from "../../lib/modelOptions";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "../../native/native-glass";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import {
  modelMatchesCatalogQuery,
  providerSectionIsCollapsed,
} from "./thread-settings-sheet-state";
import {
  type ThreadSettingsSessionValue,
  type ThreadSettingsSubmenuPage,
  useThreadSettingsSession,
} from "./thread-settings-session";
import { ThreadSettingsOptionsItem } from "./thread-settings-content";
import {
  type ThreadSettingsPickerStackParams,
  useThreadSettingsPickerPresentation,
} from "./thread-settings-picker-context";

/**
 * Everyday harnesses start expanded; every other provider (OpenRouter catalogs
 * and friends) starts folded so a 300-model catalog cannot bury the list. All
 * provider headers remain user-collapsible.
 */
const PRIMARY_PROVIDER_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * Keep measured row changes stable, but let catalog mutations use the list's
 * native bounds so a filtered catalog that underflows returns to the top.
 */
const THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION = {
  data: false,
  size: true,
} as const;

const THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION = LinearTransition.duration(180);

const THREAD_SETTINGS_CATALOG_ENTER_TRANSITION = FadeIn.duration(140);

const THREAD_SETTINGS_CATALOG_EXIT_TRANSITION = FadeOut.duration(120);

function ModelRow(props: {
  readonly option: ModelOption;
  readonly selected: boolean;
  readonly onPress: () => void;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const { t } = useMobileI18n();
  const checkmarkColor = useThemeColor("--color-icon");
  const disabledReason = props.option.disabledReason;

  return (
    <Pressable
      accessibilityLabel={props.option.label}
      accessibilityHint={disabledReason ?? undefined}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: disabledReason !== null }}
      disabled={disabledReason !== null}
      onPress={props.onPress}
      className={cn(
        "mx-4 min-h-11 flex-row items-center gap-2 bg-card px-4 py-2 active:bg-subtle",
        props.isFirst && "rounded-t-2xl",
        props.isLast ? "rounded-b-2xl" : "border-b border-border-subtle",
      )}
    >
      <View className={cn("min-w-0 shrink", disabledReason && "opacity-60")}>
        <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
          {props.option.label}
        </Text>
        {disabledReason ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={2}>
            {disabledReason}
          </Text>
        ) : null}
      </View>
      {props.option.isDefault ? (
        <View className="rounded-md bg-subtle-strong px-1.5 py-0.5">
          <Text className="text-3xs font-t3-bold text-foreground-muted">{t("Default")}</Text>
        </View>
      ) : null}
      {props.option.isLegacy ? (
        <View className="rounded-md bg-subtle px-1.5 py-0.5">
          <Text className="text-3xs font-t3-bold text-foreground-muted">{t("Legacy")}</Text>
        </View>
      ) : null}
      <View className="flex-1" />
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

/** Provider catalog header with its harness logo and disclosure state. */
function ProviderHeader(props: {
  readonly driver: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly onToggle: () => void;
}) {
  const iconSubtle = useThemeColor("--color-icon-subtle");

  const content = (
    <>
      <ProviderIcon provider={props.driver} size={15} />
      <Text className="text-sm font-t3-medium text-foreground-muted">{props.label}</Text>
      {props.collapsible ? (
        <>
          <View className="flex-1" />
          {props.collapsed ? (
            <Text className="text-2xs font-t3-medium text-foreground-muted">
              {props.modelCount}
            </Text>
          ) : null}
          <SymbolView
            name={props.collapsed ? "chevron.down" : "chevron.up"}
            size={12}
            tintColor={iconSubtle}
            type="monochrome"
          />
        </>
      ) : null}
    </>
  );

  if (props.collapsible) {
    return (
      <Pressable
        accessibilityLabel={`${props.label}, ${props.modelCount} models`}
        accessibilityRole="button"
        accessibilityState={{ expanded: !props.collapsed }}
        className="mx-4 mt-1 min-h-11 flex-row items-center gap-2 rounded-xl px-1 pt-2 active:opacity-60"
        onPress={props.onToggle}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <View accessibilityRole="header" className="mx-4 min-h-9 flex-row items-center gap-2 px-1 pt-1">
      {content}
    </View>
  );
}

type ThreadSettingsProviderCatalog = {
  readonly key: string;
  readonly driver: string | undefined;
  readonly label: string;
  readonly collapsible: boolean;
  readonly collapsed: boolean;
  readonly modelCount: number;
  readonly models: ReadonlyArray<ModelOption>;
};

type ThreadSettingsCatalogItem =
  | {
      readonly kind: "provider";
      readonly key: string;
      readonly provider: ThreadSettingsProviderCatalog;
    }
  | {
      readonly kind: "model";
      readonly key: string;
      readonly option: ModelOption;
      readonly isFirst: boolean;
      readonly isLast: boolean;
    }
  | {
      readonly kind: "empty";
      readonly key: "empty";
    }
  | {
      readonly kind: "options";
      readonly key: "options";
    };

function ThreadSettingsModelListRow(props: {
  readonly option: ModelOption;
  readonly isFirst: boolean;
  readonly isLast: boolean;
}) {
  const session = useThreadSettingsSession();

  const onPress = useCallback(
    () => session.pressModel(props.option),
    [props.option, session.pressModel],
  );

  return (
    <ModelRow
      isFirst={props.isFirst}
      isLast={props.isLast}
      onPress={onPress}
      option={props.option}
      selected={session.isDisplayed(props.option)}
    />
  );
}

function ThreadSettingsProviderListHeader(props: {
  readonly provider: ThreadSettingsProviderCatalog;
}) {
  const session = useThreadSettingsSession();

  const onToggle = useCallback(
    () => session.toggleProvider(props.provider.key),
    [props.provider.key, session.toggleProvider],
  );

  return (
    <ProviderHeader
      collapsible={props.provider.collapsible}
      collapsed={props.provider.collapsed}
      driver={props.provider.driver}
      label={props.provider.label}
      modelCount={props.provider.modelCount}
      onToggle={onToggle}
    />
  );
}

function useThreadSettingsCatalogItems(
  session: ThreadSettingsSessionValue,
): ReadonlyArray<ThreadSettingsCatalogItem> {
  return useMemo(
    () =>
      session.providerGroups.flatMap((group) => {
        if (session.providerFilter !== null && group.providerKey !== session.providerFilter) {
          return [];
        }

        const driver = group.models[0]?.providerDriver;

        const catalogModels = session.showLegacy
          ? group.models
          : group.models.filter((model) => !model.isLegacy || session.isDisplayed(model));

        const visibleModels = catalogModels.filter((model) =>
          modelMatchesCatalogQuery({
            model,
            providerLabel: group.providerLabel,
            query: session.searchQuery,
          }),
        );

        if (visibleModels.length === 0) {
          return [];
        }

        const isPrimary = driver !== undefined && PRIMARY_PROVIDER_DRIVERS.has(driver);
        // Staging a model must not change disclosure state. The applied model
        // stays stable for the lifetime of this picker (Save closes it), so it
        // is safe to use as the initial selected-provider default.
        const containsAppliedSelection = group.models.some(session.isApplied);
        const isNarrowed = session.providerFilter !== null || session.searchQuery.trim().length > 0;
        const collapsible = !isNarrowed;

        const collapsed = providerSectionIsCollapsed({
          defaultExpanded: isPrimary || containsAppliedSelection,
          hasExpansionOverride: session.providerExpansionOverrides.has(group.providerKey),
          isNarrowed,
        });

        const provider: ThreadSettingsProviderCatalog = {
          key: group.providerKey,
          driver,
          label: group.providerLabel,
          collapsible,
          collapsed,
          modelCount: visibleModels.length,
          models: collapsed ? [] : visibleModels,
        };

        return [
          {
            kind: "provider" as const,
            key: `provider:${group.providerKey}`,
            provider,
          },
          ...provider.models.map((option, index) => ({
            kind: "model" as const,
            key: `model:${option.key}`,
            option,
            isFirst: index === 0,
            isLast: index === provider.models.length - 1,
          })),
        ];
      }),
    [
      session.isApplied,
      session.isDisplayed,
      session.providerExpansionOverrides,
      session.providerFilter,
      session.providerGroups,
      session.searchQuery,
      session.showLegacy,
    ],
  );
}

/** One native scroll owner for the model catalog and its related settings. */
function ThreadSettingsMainContent(props: {
  readonly onOpenSubmenu: (submenu: ThreadSettingsSubmenuPage) => void;
}) {
  const { t } = useMobileI18n();
  const session = useThreadSettingsSession();
  const catalogItems = useThreadSettingsCatalogItems(session);
  const [animationsReady, setAnimationsReady] = useState(false);
  const nativeHeaderHeight = use(HeaderHeightContext) ?? 0;

  const hasActiveCatalogFilter =
    session.providerFilter !== null || session.searchQuery.trim().length > 0;

  const usesTransparentNativeHeader = Platform.OS === "ios" && NATIVE_LIQUID_GLASS_SUPPORTED;

  const listItems = useMemo<ReadonlyArray<ThreadSettingsCatalogItem>>(
    () => [
      ...(catalogItems.length === 0 && hasActiveCatalogFilter
        ? ([{ kind: "empty", key: "empty" }] as const)
        : catalogItems),
      { kind: "options", key: "options" },
    ],
    [catalogItems, hasActiveCatalogFilter],
  );

  const renderCatalogItem = useCallback(
    (itemProps: LegendListRenderItemProps<ThreadSettingsCatalogItem>) => {
      const item = itemProps.item;
      let content: ReactNode;

      if (item.kind === "provider") {
        content = <ThreadSettingsProviderListHeader provider={item.provider} />;
      } else if (item.kind === "model") {
        content = (
          <ThreadSettingsModelListRow
            isFirst={item.isFirst}
            isLast={item.isLast}
            option={item.option}
          />
        );
      } else if (item.kind === "empty") {
        content = (
          <View className="items-center px-8 py-14">
            <Text className="text-center text-sm text-foreground-muted">
              {t("No matching models")}
            </Text>
          </View>
        );
      } else {
        content = (
          <ThreadSettingsOptionsItem
            animationsReady={animationsReady}
            onOpenSubmenu={props.onOpenSubmenu}
          />
        );
      }

      return (
        <Animated.View
          key={item.key}
          entering={animationsReady ? THREAD_SETTINGS_CATALOG_ENTER_TRANSITION : undefined}
          exiting={animationsReady ? THREAD_SETTINGS_CATALOG_EXIT_TRANSITION : undefined}
        >
          {content}
        </Animated.View>
      );
    },
    [animationsReady, props.onOpenSubmenu, t],
  );

  return (
    <AnimatedLegendList
      automaticallyAdjustsScrollIndicatorInsets
      className="flex-1 bg-sheet"
      contentContainerStyle={{ paddingTop: 4 }}
      contentInsetAdjustmentBehavior={usesTransparentNativeHeader ? "never" : "automatic"}
      data={listItems}
      estimatedItemSize={48}
      extraData={animationsReady}
      getItemType={(item) => item.kind}
      itemLayoutAnimation={THREAD_SETTINGS_CATALOG_LAYOUT_TRANSITION}
      keyExtractor={(item) => item.key}
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      maintainVisibleContentPosition={THREAD_SETTINGS_MAINTAIN_VISIBLE_CONTENT_POSITION}
      ListHeaderComponent={
        <>
          {usesTransparentNativeHeader ? <View style={{ height: nativeHeaderHeight }} /> : null}
          {Platform.OS === "android" ? (
            <View className="px-4 pb-2 pt-3">
              <TextInput
                accessibilityLabel={t("Find a model")}
                autoCapitalize="none"
                autoCorrect={false}
                className="h-11 rounded-xl bg-card px-4 text-base text-foreground"
                onChangeText={session.setSearchQuery}
                placeholder={t("Find a model")}
                placeholderTextColorClassName="accent-placeholder"
                value={session.searchQuery}
              />
            </View>
          ) : null}
        </>
      }
      recycleItems
      onLoad={() => setAnimationsReady(true)}
      renderItem={renderCatalogItem}
      showsVerticalScrollIndicator={false}
    />
  );
}

export function ThreadSettingsModelsScreen() {
  const { t } = useMobileI18n();
  const session = useThreadSettingsSession();
  const presentation = useThreadSettingsPickerPresentation();
  const navigation = useNavigation<NativeStackNavigationProp<ThreadSettingsPickerStackParams>>();
  const usesNativeMailSearchToolbar = Platform.OS === "ios" && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const hasCustomCatalogFilter = session.providerFilter !== null || session.showLegacy;
  const hasPendingChanges = session.pendingModel !== null;

  const commitAndClose = useCallback(() => {
    session.commitPendingModel();
    presentation.onClose();
  }, [presentation, session]);

  const filterMenu = useMemo(
    () => ({
      title: t("Model filters"),
      items: [
        {
          type: "submenu" as const,
          title: t("Provider"),
          items: [
            {
              type: "action" as const,
              title: t("All providers"),
              state: session.providerFilter === null ? ("on" as const) : ("off" as const),
              onPress: () => session.setProviderFilter(null),
            },
            ...session.providerGroups.map((group) => ({
              type: "action" as const,
              title: group.providerLabel,
              state:
                session.providerFilter === group.providerKey ? ("on" as const) : ("off" as const),
              onPress: () => session.setProviderFilter(group.providerKey),
            })),
          ],
        },
        ...(session.hasLegacyModels
          ? [
              {
                type: "action" as const,
                title: t("Show legacy models"),
                state: session.showLegacy ? ("on" as const) : ("off" as const),
                onPress: () => session.setShowLegacy(!session.showLegacy),
              },
            ]
          : []),
      ],
    }),
    [session, t],
  );

  return (
    <>
      {Platform.OS === "android" ? (
        <AndroidScreenHeader
          actions={[
            {
              accessibilityLabel: hasPendingChanges ? t("Save chat settings") : t("Done"),
              icon: "checkmark",
              onPress: commitAndClose,
            },
          ]}
          onBack={presentation.onClose}
          title={t("Chat settings")}
        />
      ) : null}
      <NativeStackScreenOptions
        optionsVersion={[
          session.providerFilter,
          session.providerGroups.map((group) => group.providerKey),
          session.showLegacy,
        ]}
        options={{
          unstable_headerToolbarItems: usesNativeMailSearchToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  filterButtonId: "thread-settings-model-filter",
                  filterMenu,
                  filterSystemImageName: hasCustomCatalogFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onSearchTextChange: session.setSearchQuery,
                  placeholder: "Find a model",
                  searchTextChangeId: "thread-settings-model-search-text",
                  showsSearchDismissButton: true,
                }),
              ]
            : undefined,
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions:
            Platform.OS === "ios" && !usesNativeMailSearchToolbar
              ? {
                  autoCapitalize: "none",
                  hideNavigationBar: false,
                  obscureBackground: false,
                  onCancelButtonPress: () => session.setSearchQuery(""),
                  onChangeText: (event) => session.setSearchQuery(event.nativeEvent.text),
                  placeholder: "Find a model",
                }
              : undefined,
        }}
      />
      <ThreadSettingsMainContent
        onOpenSubmenu={(submenu) => {
          if (submenu.kind === "memory") {
            if (session.memoryThreadRef) {
              navigation.navigate("ThreadSettingsMemory", session.memoryThreadRef);
            }

            return;
          }

          if (submenu.kind === "routines") {
            if (session.routinesRef) {
              navigation.navigate("ThreadSettingsRoutines", session.routinesRef);
            }

            return;
          }

          const title =
            submenu.kind === "runtime"
              ? "Runtime"
              : (session.displayedDescriptors.find(
                  (descriptor) => descriptor.type === "select" && descriptor.id === submenu.id,
                )?.label ?? "Option");

          navigation.navigate("ThreadSettingsChoice", { ...submenu, title });
        }}
      />
      <NativeHeaderToolbar placement="left">
        <NativeHeaderToolbar.Button
          accessibilityLabel={t("Cancel chat settings")}
          label={t("Cancel")}
          onPress={presentation.onClose}
        />
      </NativeHeaderToolbar>
      <NativeHeaderToolbar placement="right">
        <NativeHeaderToolbar.Button
          accessibilityLabel={hasPendingChanges ? t("Save chat settings") : t("Done")}
          label={hasPendingChanges ? t("Save") : t("Done")}
          onPress={commitAndClose}
        />
      </NativeHeaderToolbar>
      {Platform.OS === "ios" && !usesNativeMailSearchToolbar ? (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel={t("Filter models")}
            icon={
              hasCustomCatalogFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title={t("Model filters")}
          >
            <NativeHeaderToolbar.Menu title={t("Provider")}>
              <NativeHeaderToolbar.Label>{t("Provider")}</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={session.providerFilter === null}
                onPress={() => session.setProviderFilter(null)}
              >
                {t("All providers")}
              </NativeHeaderToolbar.MenuAction>
              {session.providerGroups.map((group) => (
                <NativeHeaderToolbar.MenuAction
                  key={group.providerKey}
                  isOn={session.providerFilter === group.providerKey}
                  onPress={() => session.setProviderFilter(group.providerKey)}
                >
                  {group.providerLabel}
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>
            {session.hasLegacyModels ? (
              <NativeHeaderToolbar.MenuAction
                isOn={session.showLegacy}
                onPress={() => session.setShowLegacy(!session.showLegacy)}
              >
                {t("Show legacy models")}
              </NativeHeaderToolbar.MenuAction>
            ) : null}
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      ) : null}
    </>
  );
}
