import { useMobileI18n } from "../../lib/i18n";
import type { EnvironmentId } from "@akeru/contracts";
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
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";
import type {
  HomeListFilterMenuEnvironment,
  HomeListFilterMenuProject,
} from "./home-list-filter-menu";

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
  readonly onSearchQueryChange: (query: string) => void;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
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
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
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
      { id: "archive", title: t("Archived chats"), image: "archivebox" },
      { id: "environments", title: t("Environments"), image: "desktopcomputer" },
      { id: "settings", title: t("Settings"), image: "gearshape" },
    ],
    [props.environments, props.projects, props.selectedEnvironmentId, props.selectedProjectKey, t],
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
