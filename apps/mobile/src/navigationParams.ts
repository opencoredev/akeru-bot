import type { NavigatorScreenParams } from "@react-navigation/native";
import type { ReactNode } from "react";
import type { SettingsAkeruCloudRouteScreen } from "./features/settings/SettingsAkeruCloudRouteScreen";
import type { ArchivedThreadsRouteScreen } from "./features/archive/ArchivedThreadsRouteScreen";
import type { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import type { SettingsAppearanceRouteScreen } from "./features/settings/SettingsAppearanceRouteScreen";
import type { SettingsClientStorageRouteScreen } from "./features/settings/SettingsClientStorageRouteScreen";
import type { SettingsEnvironmentsRouteScreen } from "./features/settings/SettingsEnvironmentsRouteScreen";
import type { SettingsProjectGroupingRouteScreen } from "./features/settings/SettingsProjectGroupingRouteScreen";
import type { BotUsageRouteScreen } from "./features/usage/BotUsageRouteScreen";
import type { UsageRouteScreen } from "./features/usage/UsageRouteScreen";
import type { SettingsRouteScreen } from "./features/settings/SettingsRouteScreen";
import type { SettingsProviderHealthRouteScreen } from "./features/settings/SettingsProviderHealthRouteScreen";
import type { NewTaskDraftRouteScreen } from "./features/threads/NewTaskDraftRouteScreen";
import type { NewTaskEnvironmentPickerRouteScreen } from "./features/threads/NewTaskContextPickerScreens";
import type { NewTaskThreadSettingsRouteScreen } from "./features/threads/ThreadSettingsSheet";
import type { NewTaskRouteScreen } from "./features/threads/NewTaskRouteScreen";
import type { ThreadRouteScreen } from "./features/threads/ThreadRouteScreen";
import type { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import type { HomeRouteScreen } from "./features/home/HomeRouteScreen";
import type { ExistingThreadSettingsRouteScreen } from "./features/threads/ThreadSettingsSheet";
import type { SettingsLegalRouteScreen } from "./features/settings/SettingsLegalRouteScreen";

type ScreenParams<T> = T extends (props: { route: { params: infer Params } }) => ReactNode
  ? Params
  : undefined;

export type SettingsContentParams = {
  SettingsAkeruCloud: ScreenParams<typeof SettingsAkeruCloudRouteScreen>;
  Settings: ScreenParams<typeof SettingsRouteScreen>;
  SettingsEnvironments: ScreenParams<typeof SettingsEnvironmentsRouteScreen>;
  SettingsEnvironmentNew: ScreenParams<typeof ConnectionsNewRouteScreen>;
  SettingsArchive: ScreenParams<typeof ArchivedThreadsRouteScreen>;
  SettingsAppearance: ScreenParams<typeof SettingsAppearanceRouteScreen>;
  SettingsProjectGrouping: ScreenParams<typeof SettingsProjectGroupingRouteScreen>;
  SettingsClientStorage: ScreenParams<typeof SettingsClientStorageRouteScreen>;
  SettingsUsage: ScreenParams<typeof UsageRouteScreen>;
  SettingsBotUsage: ScreenParams<typeof BotUsageRouteScreen>;
  SettingsProviderHealth: ScreenParams<typeof SettingsProviderHealthRouteScreen>;
};

export type NewTaskContentParams = {
  NewTask: ScreenParams<typeof NewTaskRouteScreen>;
  NewTaskDraft: ScreenParams<typeof NewTaskDraftRouteScreen>;
  NewTaskEnvironment: ScreenParams<typeof NewTaskEnvironmentPickerRouteScreen>;
  ThreadSettings: ScreenParams<typeof NewTaskThreadSettingsRouteScreen>;
};

export type MobileRootParams = {
  Home: ScreenParams<typeof HomeRouteScreen>;
  Thread: ScreenParams<typeof ThreadRouteScreen>;
  ThreadSettingsSheet: ScreenParams<typeof ExistingThreadSettingsRouteScreen>;
  SettingsSheet: NavigatorScreenParams<{
    SettingsContent: NavigatorScreenParams<SettingsContentParams>;
  }>;
  SettingsLegal: ScreenParams<typeof SettingsLegalRouteScreen>;
  Connections: ScreenParams<typeof ConnectionsRouteScreen>;
  ConnectionsNew: ScreenParams<typeof ConnectionsNewRouteScreen>;
  NewTaskSheet: NavigatorScreenParams<NewTaskContentParams>;
  NotFound: undefined;
};
