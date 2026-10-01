import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import type { ReactNode } from "react";
import { useMobileI18n } from "./lib/i18n";
import { NativeStackScreenOptions } from "./native/StackHeader";
import { ArchivedThreadsRouteScreen } from "./features/archive/ArchivedThreadsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { SettingsAppearanceRouteScreen } from "./features/settings/SettingsAppearanceRouteScreen";
import { SettingsClientStorageRouteScreen } from "./features/settings/SettingsClientStorageRouteScreen";
import { SettingsEnvironmentsRouteScreen } from "./features/settings/SettingsEnvironmentsRouteScreen";
import { SettingsProjectGroupingRouteScreen } from "./features/settings/SettingsProjectGroupingRouteScreen";
import { BotUsageRouteScreen } from "./features/usage/BotUsageRouteScreen";
import { UsageRouteScreen } from "./features/usage/UsageRouteScreen";
import { SettingsRouteScreen } from "./features/settings/SettingsRouteScreen";
import { SettingsProviderHealthRouteScreen } from "./features/settings/SettingsProviderHealthRouteScreen";
import { GLASS_HEADER_OPTIONS } from "./stack-header-options";

function SettingsNavigationLayout({
  children,
  routeName,
}: {
  readonly children: ReactNode;
  readonly routeName: string;
}) {
  const { t } = useMobileI18n();

  const titles: Readonly<Record<string, string | undefined>> = {
    Settings: t("Settings"),
    SettingsEnvironments: t("Environments"),
    SettingsEnvironmentNew: t("Add Environment"),
    SettingsArchive: t("Archived chats"),
    SettingsAppearance: t("Appearance"),
    SettingsProjectGrouping: t("Project Grouping"),
    SettingsClientStorage: t("Client Storage"),
    SettingsUsage: t("Usage"),
    SettingsBotUsage: t("Bot usage"),
    SettingsProviderHealth: undefined,
  };

  const title = titles[routeName];

  return (
    <>
      {title === undefined ? null : <NativeStackScreenOptions options={{ title }} />}
      {children}
    </>
  );
}

const SettingsContentStack = createNativeStackNavigator({
  initialRouteName: "Settings",
  screenLayout: ({ children, route }) => (
    <SettingsNavigationLayout routeName={route.name}>{children}</SettingsNavigationLayout>
  ),
  screenOptions: {
    ...GLASS_HEADER_OPTIONS,
    // Sheets read better with the iOS-default centered title (no editor style).
    unstable_navigationItemStyle: undefined,
  },
  screens: {
    Settings: createNativeStackScreen({
      screen: SettingsRouteScreen,
      linking: "",
      options: {
        title: "Settings",
      },
    }),
    SettingsEnvironments: createNativeStackScreen({
      screen: SettingsEnvironmentsRouteScreen,
      linking: "environments",
      options: {
        title: "Environments",
      },
    }),
    SettingsEnvironmentNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "environment-new",
      options: {
        title: "Add Environment",
      },
    }),
    SettingsArchive: createNativeStackScreen({
      screen: ArchivedThreadsRouteScreen,
      linking: "archive",
      options: {
        title: "Archived chats",
      },
    }),
    SettingsAppearance: createNativeStackScreen({
      screen: SettingsAppearanceRouteScreen,
      linking: "appearance",
      options: {
        title: "Appearance",
      },
    }),
    SettingsProjectGrouping: createNativeStackScreen({
      screen: SettingsProjectGroupingRouteScreen,
      linking: "project-grouping",
      options: {
        title: "Project Grouping",
      },
    }),
    SettingsClientStorage: createNativeStackScreen({
      screen: SettingsClientStorageRouteScreen,
      linking: "client-storage",
      options: {
        title: "Client Storage",
      },
    }),
    SettingsUsage: createNativeStackScreen({
      screen: UsageRouteScreen,
      linking: "usage",
      options: {
        title: "Usage",
      },
    }),
    SettingsBotUsage: createNativeStackScreen({
      screen: BotUsageRouteScreen,
      linking: "usage/bot",
      options: {
        title: "Bot usage",
      },
    }),
    SettingsProviderHealth: createNativeStackScreen({
      screen: SettingsProviderHealthRouteScreen,
      linking: "provider-health",
      options: {
        title: "Settings",
      },
    }),
  },
});

// The outer stack never owns visible chrome. Settings routes render inside a
// nested stack whose native header remains mounted.
export const SettingsSheetStack = createNativeStackNavigator({
  initialRouteName: "SettingsContent",
  screenOptions: {
    headerShown: false,
  },
  screens: {
    SettingsContent: createNativeStackScreen({
      screen: SettingsContentStack,
      linking: "",
    }),
  },
});
