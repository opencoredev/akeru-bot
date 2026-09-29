import { useMobileI18n } from "../../lib/i18n";
import type { EnvironmentId, SidebarThreadSortOrder } from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo, useRef, useState } from "react";
import { Pressable, Text as RNText, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { ControlPillMenu } from "../../components/ControlPill";
import { HOME_HORIZONTAL_INSET } from "../../lib/layoutMetrics";
import { useThemeColor } from "../../lib/useThemeColor";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { useThreadListV2Enabled } from "../threads/use-thread-list-v2-enabled";
import type { HomeProjectSortOrder } from "./homeThreadList";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";
import {
  hasCustomHomeListOptions,
  PROJECT_SORT_OPTIONS,
  THREAD_SORT_OPTIONS,
} from "./home-list-options";

export type HomeHeaderEnvironment = HomeListFilterMenuEnvironment;

function checkedMenuState(checked: boolean) {
  return checked ? ("on" as const) : undefined;
}

/** Initials for the profile circle, derived from the environment scope. */
function profileInitials(label: string | null): string {
  const source = (label ?? "Akeru").trim();
  const parts = source.split(/[\s-_.]+/).filter((part) => /[a-z0-9]/i.test(part));
  if (parts.length >= 2) {
    return `${parts[0]![0]!}${parts[1]![0]!}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase() || "AK";
}

/**
 * Roster home header, matching the web bot roster's messenger idiom: a
 * profile circle on the left (filters, archive, and settings live in its
 * menu) and search + new-chat circles on the right. No brand lockup, no
 * quick links — the bot list is the screen.
 */
export function HomeHeader(props: {
  readonly environments: ReadonlyArray<HomeHeaderEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onProjectSortOrderChange: (sortOrder: HomeProjectSortOrder) => void;
  readonly onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenArchive: () => void;
  readonly onOpenSettings: () => void;
  readonly onStartNewTask: () => void;
}) {
  const { t } = useMobileI18n();
  const insets = useSafeAreaInsets();
  const iconColor = useThemeColor("--color-icon");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const [searchOpen, setSearchOpen] = useState(false);
  const searchInputRef = useRef<TextInput>(null);
  // Thread List v2 lays the list out in fixed creation order, so the
  // sort/group filter controls would be silently ignored — hide them and
  // key the "customized" state off the environment filter alone.
  const threadListV2Enabled = useThreadListV2Enabled();
  const hasCustomListOptions = threadListV2Enabled
    ? props.selectedEnvironmentId !== null || props.selectedProjectKey !== null
    : hasCustomHomeListOptions(props);
  const selectedEnvironmentLabel =
    props.selectedEnvironmentId === null
      ? null
      : (props.environments.find(
          (environment) => environment.environmentId === props.selectedEnvironmentId,
        )?.label ?? null);
  const initials = profileInitials(
    selectedEnvironmentLabel ?? props.environments[0]?.label ?? null,
  );

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    // Focus after the input mounts.
    setTimeout(() => searchInputRef.current?.focus(), 50);
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    props.onSearchQueryChange("");
  }, [props.onSearchQueryChange]);
  useHardwareKeyboardCommand("focusSearch", () => {
    openSearch();
    return true;
  });

  const menuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: t("Environment"),
        subactions: [
          {
            id: "environment:all",
            title: t("All environments"),
            state: checkedMenuState(props.selectedEnvironmentId === null),
          },
          ...props.environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state: checkedMenuState(props.selectedEnvironmentId === environment.environmentId),
          })),
        ],
      },
      ...(props.projects.length === 0
        ? []
        : ([
            {
              id: "project",
              title: t("Project"),
              subactions: [
                {
                  id: "project:all",
                  title: t("All projects"),
                  state: checkedMenuState(props.selectedProjectKey === null),
                },
                ...props.projects.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: checkedMenuState(props.selectedProjectKey === project.key),
                })),
              ],
            },
          ] satisfies MenuAction[])),
      ...(threadListV2Enabled
        ? []
        : ([
            {
              id: "project-sort",
              title: t("Sort projects"),
              subactions: PROJECT_SORT_OPTIONS.map((option) => ({
                id: `project-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(props.projectSortOrder === option.value),
              })),
            },
            {
              id: "thread-sort",
              title: t("Sort chats"),
              subactions: THREAD_SORT_OPTIONS.map((option) => ({
                id: `thread-sort:${option.value}`,
                title: option.label,
                state: checkedMenuState(props.threadSortOrder === option.value),
              })),
            },
          ] satisfies MenuAction[])),
      { id: "archive", title: t("Archived chats"), image: "archivebox" },
      { id: "environments", title: t("Environments"), image: "desktopcomputer" },
      { id: "settings", title: t("Settings"), image: "gearshape" },
    ],
    [
      props.environments,
      props.projectSortOrder,
      props.projects,
      props.selectedEnvironmentId,
      props.selectedProjectKey,
      props.threadSortOrder,
      t,
      threadListV2Enabled,
    ],
  );

  const handleMenuAction = useCallback(
    (event: { nativeEvent: { event: string } }) => {
      const id = event.nativeEvent.event;
      if (id === "archive") {
        props.onOpenArchive();
        return;
      }
      if (id === "environments") {
        props.onOpenEnvironments();
        return;
      }
      if (id === "settings") {
        props.onOpenSettings();
        return;
      }
      if (id === "environment:all") {
        props.onEnvironmentChange(null);
        return;
      }
      if (id.startsWith("environment:")) {
        const environmentId = id.slice("environment:".length);
        const environment = props.environments.find(
          (candidate) => candidate.environmentId === environmentId,
        );
        if (environment) {
          props.onEnvironmentChange(environment.environmentId);
        }
        return;
      }
      if (id === "project:all") {
        props.onProjectChange(null);
        return;
      }
      if (id.startsWith("project:")) {
        const projectKey = id.slice("project:".length);
        if (props.projects.some((project) => project.key === projectKey)) {
          props.onProjectChange(projectKey);
        }
        return;
      }
      const projectSort = PROJECT_SORT_OPTIONS.find(
        (option) => id === `project-sort:${option.value}`,
      );
      if (projectSort) {
        props.onProjectSortOrderChange(projectSort.value);
        return;
      }
      const threadSort = THREAD_SORT_OPTIONS.find((option) => id === `thread-sort:${option.value}`);
      if (threadSort) {
        props.onThreadSortOrderChange(threadSort.value);
        return;
      }
    },
    [props],
  );

  return (
    <>
      <NativeStackScreenOptions options={{ headerShown: false }} />
      <View
        className="bg-screen pb-2"
        style={{
          paddingHorizontal: HOME_HORIZONTAL_INSET,
          paddingTop: Math.max(insets.top, 12) + 4,
        }}
      >
        <View className="w-full max-w-[720px] self-center">
          <View className="flex-row items-center gap-3">
            <ControlPillMenu
              actions={menuActions}
              onPressAction={handleMenuAction}
              title={selectedEnvironmentLabel ?? t("All environments")}
            >
              <Pressable
                accessibilityHint={t("Opens filters, archived chats, and settings")}
                accessibilityLabel={
                  hasCustomListOptions ? t("Menu, filters active") : t("Menu, no filters")
                }
                accessibilityRole="button"
                className="size-11 items-center justify-center rounded-full border border-border-subtle bg-subtle"
              >
                <RNText className="text-[15px] font-t3-bold tracking-[0.5px] text-foreground-secondary">
                  {initials}
                </RNText>
                {hasCustomListOptions ? (
                  <View className="absolute -right-0.5 -top-0.5 size-3 rounded-full border-2 border-screen bg-blue-500" />
                ) : null}
              </Pressable>
            </ControlPillMenu>
            <WorkspaceConnectionTitle grow onPress={props.onOpenEnvironments} brand={null} />

            <Pressable
              accessibilityLabel={searchOpen ? t("Close search") : t("Search chats")}
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-full bg-card"
              onPress={searchOpen ? closeSearch : openSearch}
              style={({ pressed }) => ({
                elevation: 3,
                opacity: pressed ? 0.7 : 1,
                shadowColor: "#000000",
                shadowOffset: { height: 3, width: 0 },
                shadowOpacity: 0.08,
                shadowRadius: 8,
              })}
            >
              <SymbolView
                name={searchOpen ? "xmark.circle.fill" : "magnifyingglass"}
                size={18}
                tintColor={iconColor}
                type="monochrome"
              />
            </Pressable>
            <Pressable
              accessibilityLabel={t("New chat")}
              accessibilityRole="button"
              className="size-11 items-center justify-center rounded-full bg-card"
              onPress={props.onStartNewTask}
              style={({ pressed }) => ({
                elevation: 3,
                opacity: pressed ? 0.7 : 1,
                shadowColor: "#000000",
                shadowOffset: { height: 3, width: 0 },
                shadowOpacity: 0.08,
                shadowRadius: 8,
              })}
            >
              <SymbolView name="plus" size={19} tintColor={iconColor} type="monochrome" />
            </Pressable>
          </View>

          {searchOpen ? (
            <View className="mt-3 h-11 flex-row items-center gap-2.5 rounded-full bg-subtle px-4">
              <SymbolView
                name="magnifyingglass"
                size={16}
                tintColor={mutedColor}
                type="monochrome"
              />
              <TextInput
                accessibilityLabel={t("Search chats")}
                autoCapitalize="none"
                autoCorrect={false}
                className="h-full flex-1 font-sans text-[16px] text-foreground"
                onChangeText={props.onSearchQueryChange}
                placeholder={t("Search")}
                placeholderTextColorClassName="accent-placeholder"
                ref={searchInputRef}
                returnKeyType="search"
                value={props.searchQuery}
              />
              {props.searchQuery.length > 0 ? (
                <Pressable
                  accessibilityLabel={t("Clear search")}
                  accessibilityRole="button"
                  hitSlop={10}
                  onPress={() => props.onSearchQueryChange("")}
                >
                  <SymbolView
                    name="xmark.circle.fill"
                    size={16}
                    tintColor={mutedColor}
                    type="monochrome"
                  />
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </View>
      </View>
    </>
  );
}
