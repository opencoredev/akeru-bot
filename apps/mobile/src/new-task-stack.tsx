import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import { Platform } from "react-native";
import { NewTaskDraftRouteScreen } from "./features/threads/NewTaskDraftRouteScreen";
import { NewTaskEnvironmentPickerRouteScreen } from "./features/threads/NewTaskContextPickerScreens";
import { NewTaskThreadSettingsRouteScreen } from "./features/threads/ThreadSettingsSheet";
import { NewTaskRouteScreen } from "./features/threads/NewTaskRouteScreen";
import { FORM_SHEET_PRESENTATION_OPTIONS } from "./native/sheet-surface";
import { SHEET_GLASS_HEADER_OPTIONS } from "./stack-header-options";

// New-task flow: nested navigator inside the formSheet (Settings-sheet
// pattern — a plain formSheet screen cannot render a stack header; the header and
// in-sheet pushes come from this nested stack).
export const NewTaskSheetStack = createNativeStackNavigator({
  initialRouteName: "NewTask",
  screenOptions: {
    ...SHEET_GLASS_HEADER_OPTIONS,
    // The form-sheet host owns the one opaque adaptive surface. Child screens
    // and the navigation bar stay transparent over it, avoiding visible color
    // slabs as view controllers move horizontally.
    contentStyle: Platform.OS === "ios" ? { backgroundColor: "transparent" } : undefined,
    // UIKit's default push adds a dimming shadow and independently transitions
    // the navigation bar. Both read as mismatched sheet backgrounds here.
    // simple_push retains native push/pop gestures without either artifact.
    animation: Platform.OS === "ios" ? "simple_push" : undefined,
    animationDuration: Platform.OS === "ios" ? 350 : undefined,
  },
  screens: {
    NewTask: createNativeStackScreen({
      screen: NewTaskRouteScreen,
      linking: "",
      options: {
        title: "Choose project",
      },
    }),
    NewTaskDraft: createNativeStackScreen({
      screen: NewTaskDraftRouteScreen,
      linking: "draft",
      options: {
        headerBackVisible: false,
        title: "",
      },
    }),
    NewTaskEnvironment: createNativeStackScreen({
      screen: NewTaskEnvironmentPickerRouteScreen,
      linking: "draft/environment",
      options: {
        title: "Environment",
      },
    }),
    ThreadSettings: createNativeStackScreen({
      screen: NewTaskThreadSettingsRouteScreen,
      linking: "draft/settings",
      options: {
        gestureEnabled: true,
        headerShown: false,
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [1],
              sheetGrabberVisible: true,
            }),
      },
    }),
  },
});
