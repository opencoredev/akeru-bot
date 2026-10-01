import type { EnvironmentId } from "@akeru/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { SymbolView } from "../../components/AppSymbol";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useMemo } from "react";
import { TextInput, Platform, Pressable, useWindowDimensions, View } from "react-native";
import { ControlPillMenu } from "../../components/ControlPill";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useMobileI18n } from "../../lib/i18n";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import type { ArchivedThreadSortOrder } from "./archivedThreadList";

export interface ArchivedThreadsHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function ArchivedThreadsHeader(props: {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sortOrder: ArchivedThreadSortOrder;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortOrderChange: (sortOrder: ArchivedThreadSortOrder) => void;
}) {
  const { t } = useMobileI18n();
  const { width } = useWindowDimensions();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const hasCustomFilter = props.selectedEnvironmentId !== null || props.sortOrder !== "newest";
  const searchIconColor = useThemeColor("--color-icon");
  const searchTextColor = useThemeColor("--color-foreground");
  const usesNativeChrome = Platform.OS === "ios";
  const usesCompactMailToolbar =
    Platform.OS === "ios" && width < 700 && NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED;
  const androidFilterActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: t("Environment"),
        subactions: [
          {
            id: "environment:all",
            title: t("All environments"),
            state: props.selectedEnvironmentId === null ? ("on" as const) : undefined,
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              props.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : undefined,
          })),
        ],
      },
      {
        id: "sort",
        title: t("Sort by archived date"),
        subactions: [
          {
            id: "sort:newest",
            title: t("Newest first"),
            state: props.sortOrder === "newest" ? ("on" as const) : undefined,
          },
          {
            id: "sort:oldest",
            title: t("Oldest first"),
            state: props.sortOrder === "oldest" ? ("on" as const) : undefined,
          },
        ],
      },
    ],
    [props.environments, props.selectedEnvironmentId, props.sortOrder, t],
  );
  const handleAndroidFilterAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const action = event.nativeEvent.event;
      if (action === "environment:all") {
        props.onEnvironmentChange(null);
      } else if (action.startsWith("environment:")) {
        props.onEnvironmentChange(action.slice("environment:".length) as EnvironmentId);
      } else if (action === "sort:newest") {
        props.onSortOrderChange("newest");
      } else if (action === "sort:oldest") {
        props.onSortOrderChange("oldest");
      }
    },
    [props.onEnvironmentChange, props.onSortOrderChange],
  );

  if (Platform.OS === "android") {
    // Single header row matching the app's Android chrome (AndroidScreenHeader
    // palette): back chevron, inline search, filter menu.
    return (
      <>
        <NativeStackScreenOptions options={{ headerShown: false }} />
        <View
          className="border-b border-header-border bg-header px-3 pb-2.5"
          style={{
            paddingTop: Math.max(insets.top, 12),
          }}
        >
          <View className="min-h-12 flex-row items-center gap-2">
            <Pressable
              accessibilityLabel={t("Navigate up")}
              accessibilityRole="button"
              hitSlop={8}
              onPress={() => navigation.goBack()}
              className="size-11 items-center justify-center"
            >
              <SymbolView
                name="chevron.left"
                size={24}
                tintColor={searchTextColor}
                type="monochrome"
              />
            </Pressable>
            <View className="min-h-11 flex-1 flex-row items-center gap-2.5 rounded-2xl bg-input px-3.5">
              <SymbolView
                name="magnifyingglass"
                size={17}
                tintColor={searchIconColor}
                type="monochrome"
              />
              <TextInput
                accessibilityLabel={t("Search archived chats")}
                autoCapitalize="none"
                onChangeText={props.onSearchQueryChange}
                value={props.searchQuery}
                placeholder={t("Search archived chats")}
                placeholderTextColorClassName="accent-placeholder"
                className="flex-1 py-2 text-base font-sans text-foreground"
              />
            </View>
            <ControlPillMenu
              actions={androidFilterActions}
              isAnchoredToRight
              onPressAction={handleAndroidFilterAction}
            >
              <Pressable
                accessibilityLabel={t("Filter and sort archived chats")}
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full bg-subtle"
              >
                <SymbolView
                  name={
                    hasCustomFilter
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease.circle"
                  }
                  size={16}
                  tintColor={searchIconColor}
                  type="monochrome"
                />
              </Pressable>
            </ControlPillMenu>
          </View>
        </View>
      </>
    );
  }
  const archiveFilterMenu = {
    title: t("Archived chat options"),
    items: [
      {
        type: "submenu" as const,
        title: t("Environment"),
        items: [
          {
            type: "action" as const,
            title: t("All environments"),
            state: props.selectedEnvironmentId === null ? ("on" as const) : ("off" as const),
            onPress: () => props.onEnvironmentChange(null),
          },
          ...props.environments.map((environment) => ({
            type: "action" as const,
            title: environment.label,
            state:
              props.selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
            onPress: () => props.onEnvironmentChange(environment.environmentId),
          })),
        ],
      },
      {
        type: "submenu" as const,
        title: t("Sort by archived date"),
        items: [
          {
            type: "action" as const,
            title: t("Newest first"),
            state: props.sortOrder === "newest" ? ("on" as const) : ("off" as const),
            onPress: () => props.onSortOrderChange("newest"),
          },
          {
            type: "action" as const,
            title: t("Oldest first"),
            state: props.sortOrder === "oldest" ? ("on" as const) : ("off" as const),
            onPress: () => props.onSortOrderChange("oldest"),
          },
        ],
      },
    ],
  };

  return (
    <>
      {/* Static header config (glass preset + title) lives in Stack.tsx; only
          dynamic toolbar/search wiring is set here. */}
      <NativeStackScreenOptions
        options={{
          unstable_headerToolbarItems: usesCompactMailToolbar
            ? () => [
                createNativeMailSearchToolbarItem({
                  composeButtonId: "archived-refresh",
                  composeSystemImageName: "arrow.clockwise",
                  filterMenu: archiveFilterMenu,
                  filterButtonId: "archived-filter",
                  filterSystemImageName: hasCustomFilter
                    ? "line.3.horizontal.decrease.circle.fill"
                    : "line.3.horizontal.decrease",
                  onComposePress: props.onRefresh,
                  onSearchTextChange: props.onSearchQueryChange,
                  placeholder: t("Search"),
                  searchTextChangeId: "archived-search-text",
                }),
              ]
            : undefined,
          headerSearchBarOptions: usesCompactMailToolbar
            ? undefined
            : {
                ...(usesNativeChrome
                  ? {
                      allowToolbarIntegration: true,
                      // "integratedButton" is an iOS 26 search-bar placement;
                      // pre-glass iOS keeps the default pull-down placement.
                      ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
                        ? { placement: "integratedButton" as const }
                        : null),
                    }
                  : {
                      placement: "stacked" as const,
                    }),
                autoCapitalize: "none",
                hideNavigationBar: false,
                obscureBackground: false,
                placeholder: t("Search archived chats"),
                onChangeText: (event) => {
                  props.onSearchQueryChange(event.nativeEvent.text);
                },
                onCancelButtonPress: () => {
                  props.onSearchQueryChange("");
                },
              },
        }}
      />

      {usesCompactMailToolbar ? null : (
        <NativeHeaderToolbar placement="right">
          {usesNativeChrome ? (
            <NativeHeaderToolbar.Button
              accessibilityLabel={t("Refresh archived chats")}
              icon="arrow.clockwise"
              onPress={props.onRefresh}
              separateBackground
            />
          ) : null}
          <NativeHeaderToolbar.Menu
            accessibilityLabel={t("Filter and sort archived chats")}
            icon={
              hasCustomFilter
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            separateBackground
            title={t("Archived chat options")}
          >
            <NativeHeaderToolbar.Menu title={t("Environment")}>
              <NativeHeaderToolbar.Label>{t("Environment")}</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
              >
                <NativeHeaderToolbar.Label>{t("All environments")}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            <NativeHeaderToolbar.Menu title={t("Sort by archived date")}>
              <NativeHeaderToolbar.Label>{t("Sort by archived date")}</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sortOrder === "newest"}
                onPress={() => props.onSortOrderChange("newest")}
              >
                <NativeHeaderToolbar.Label>{t("Newest first")}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              <NativeHeaderToolbar.MenuAction
                isOn={props.sortOrder === "oldest"}
                onPress={() => props.onSortOrderChange("oldest")}
              >
                <NativeHeaderToolbar.Label>{t("Oldest first")}</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
            </NativeHeaderToolbar.Menu>
          </NativeHeaderToolbar.Menu>
        </NativeHeaderToolbar>
      )}
    </>
  );
}
