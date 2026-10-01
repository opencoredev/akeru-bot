import type { EnvironmentId } from "@akeru/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useMemo, type RefObject } from "react";
import { type LayoutChangeEvent, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { CompactBrandTitle } from "../../components/CompactBrandTitle";
import { ControlPillMenu } from "../../components/ControlPill";
import { useMobileI18n } from "../../lib/i18n";
import { useThemeColor } from "../../lib/useThemeColor";
import { WorkspaceConnectionTitle } from "../home/WorkspaceConnectionTitle";
import { SidebarFilterButton, type SidebarFilterButtonIcon } from "./sidebar-filter-button";
import { SidebarHeaderActions } from "./sidebar-header-actions";

/** Fallback sticky header height (below the safe area) until the header measures itself. */
export const SIDEBAR_STICKY_HEADER_HEIGHT = 106;

/**
 * The custom sidebar header used where the pane has no native navigation bar:
 * brand or connection status, the environment and project filter menu,
 * settings, and the search field.
 */
export function ThreadNavigationSidebarHeader(props: {
  readonly topInset: number;
  readonly onLayout: (event: LayoutChangeEvent) => void;
  readonly filterIcon: SidebarFilterButtonIcon;
  readonly environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly projectFilterOptions: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironmentSettings: () => void;
  readonly searchInputRef: RefObject<TextInput | null>;
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
}) {
  const { t } = useMobileI18n();
  const backgroundColor = useThemeColor("--color-drawer");
  const mutedColor = useThemeColor("--color-foreground-muted");
  const placeholderColor = useThemeColor("--color-placeholder");
  const { environments, projectFilterOptions, selectedEnvironmentId, selectedProjectKey } = props;
  const { onEnvironmentChange, onProjectChange } = props;
  const listMenuActions = useMemo<MenuAction[]>(
    () => [
      {
        id: "environment",
        title: "Environment",
        subactions: [
          {
            id: "environment:all",
            title: "All environments",
            subtitle: "Show chats from every environment",
            state: selectedEnvironmentId === null ? "on" : "off",
          },
          ...environments.map((environment) => ({
            id: `environment:${environment.environmentId}`,
            title: environment.label,
            state:
              selectedEnvironmentId === environment.environmentId
                ? ("on" as const)
                : ("off" as const),
          })),
        ],
      },
      ...(projectFilterOptions.length === 0
        ? []
        : ([
            {
              id: "project",
              title: "Project",
              subactions: [
                {
                  id: "project:all",
                  title: "All projects",
                  subtitle: "Show chats from every project",
                  state: selectedProjectKey === null ? "on" : "off",
                },
                ...projectFilterOptions.map((project) => ({
                  id: `project:${project.key}`,
                  title: project.label,
                  state: selectedProjectKey === project.key ? ("on" as const) : ("off" as const),
                })),
              ],
            },
          ] satisfies MenuAction[])),
    ],
    [environments, selectedEnvironmentId, projectFilterOptions, selectedProjectKey],
  );
  const handleListMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      const event = nativeEvent.event;
      if (event === "environment:all") {
        onEnvironmentChange(null);
        return;
      }
      if (event.startsWith("environment:")) {
        const environment = environments.find(
          (candidate) => String(candidate.environmentId) === event.slice("environment:".length),
        );
        if (environment) onEnvironmentChange(environment.environmentId);
        return;
      }
      if (event === "project:all") {
        onProjectChange(null);
        return;
      }
      if (event.startsWith("project:")) {
        const projectKey = event.slice("project:".length);
        if (projectFilterOptions.some((project) => project.key === projectKey)) {
          onProjectChange(projectKey);
        }
        return;
      }
    },
    [environments, projectFilterOptions, onEnvironmentChange, onProjectChange],
  );

  return (
    <View
      className="absolute inset-x-0 top-0 z-[4]"
      collapsable={false}
      onLayout={props.onLayout}
      pointerEvents="auto"
      style={{
        paddingTop: props.topInset,
        backgroundColor,
      }}
    >
      <View className="h-[50px] flex-row items-end gap-0.5 pr-2 pl-5">
        {/* Title slot doubles as the connection status surface: while an
            environment reconnects, the brand fades to a status label in
            place (no layout shift in the list below). */}
        <WorkspaceConnectionTitle
          grow
          onPress={props.onOpenEnvironmentSettings}
          size="pageTitle"
          brand={
            <View className="h-11 flex-1 justify-center">
              <CompactBrandTitle allowFontScaling={false} />
            </View>
          }
        />
        <View className="flex-row items-center gap-2.5">
          <ControlPillMenu actions={listMenuActions} onPressAction={handleListMenuAction}>
            <SidebarFilterButton accessibilityLabel={t("Filter chats")} icon={props.filterIcon} />
          </ControlPillMenu>
          <SidebarHeaderActions onOpenSettings={props.onOpenSettings} />
        </View>
      </View>

      <View className="mx-4 mt-[9px] h-[38px] flex-row items-center gap-1.5 rounded-xl bg-sidebar-search pr-2.5 pl-[11px]">
        <SymbolView name="magnifyingglass" size={15} tintColor={mutedColor} type="monochrome" />
        <TextInput
          ref={props.searchInputRef}
          accessibilityLabel={t("Search chats")}
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          onChangeText={props.onSearchQueryChange}
          placeholder={t("Search")}
          placeholderTextColor={placeholderColor}
          returnKeyType="search"
          className="h-[34px] flex-1 px-0 py-0 font-sans text-base text-foreground"
          value={props.searchQuery}
        />
      </View>
    </View>
  );
}
