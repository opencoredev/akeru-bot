import type { MobileRootParams } from "./navigationParams";
import {
  createPathConfigForStaticNavigation,
  getPathFromState,
  NavigationState,
  StackActions,
  useNavigation,
} from "@react-navigation/native";
import {
  createNativeStackNavigator,
  createNativeStackScreen,
} from "@react-navigation/native-stack";
import { useEffect, useRef } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useResolveClassNames } from "uniwind";
import { AppText as Text } from "./components/AppText";
import { getCompactBrandHeaderOptions } from "./components/CompactBrandTitle";
import { useAgentNotificationNavigation } from "./features/agent-awareness/notificationNavigation";
import { AdaptiveWorkspaceLayout } from "./features/layout/AdaptiveWorkspaceLayout";
import { HardwareKeyboardCommandProvider } from "./features/keyboard/HardwareKeyboardCommandProvider";
import { ThreadRouteScreen } from "./features/threads/ThreadRouteScreen";
import { ConnectionsRouteScreen } from "./features/connection/ConnectionsRouteScreen";
import { ConnectionsNewRouteScreen } from "./features/connection/ConnectionsNewRouteScreen";
import { HomeRouteScreen } from "./features/home/HomeRouteScreen";
import {
  ExistingThreadSettingsRouteProvider,
  ExistingThreadSettingsRouteScreen,
} from "./features/threads/ThreadSettingsSheet";
import { NewTaskFlowProvider } from "./features/threads/new-task-flow-provider";
import { SettingsLegalRouteScreen } from "./features/settings/SettingsLegalRouteScreen";
import { ShowcaseCaptureCoordinator } from "./features/showcase/ShowcaseCaptureCoordinator";
import { useAppShortcuts } from "./features/shortcuts/useAppShortcuts";
import { useIncomingShare } from "./features/sharing/IncomingShareProvider";
import {
  EMPTY_INCOMING_SHARE_PRESENTATION_STATE,
  transitionIncomingSharePresentation,
} from "./features/sharing/incoming-share-presentation";
import { FORM_SHEET_PRESENTATION_OPTIONS } from "./native/sheet-surface";
import { useThreadOutboxDrain } from "./state/use-thread-outbox-drain";
import { GLASS_HEADER_OPTIONS, LEGAL_DOCUMENT_HEADER_OPTIONS } from "./stack-header-options";
import { SettingsSheetStack } from "./settings-stack";
import { NewTaskSheetStack } from "./new-task-stack";

// Thread routes live FLAT in the root stack (not in a nested navigator). A nested
// stack means a second UINavigationController with its own UINavigationBar, which
// breaks iOS 26's shared-header morphing between Home and Thread (each pair inside
// one bar morphs; across two bars the whole screen slides). Flat linking paths keep
// the same deep-link URLs the nested config produced.
const THREAD_LINKING_PREFIX = "threads/:environmentId/:threadId";

// Routes presented as sheets/overlays ON TOP of the workspace. They must not
// influence the adaptive workspace layout: opening Settings over Home should
// not flip the sidebar in or change the active thread.
const WORKSPACE_OVERLAY_ROUTES = new Set([
  "Connections",
  "ConnectionsNew",
  "NewTaskSheet",
  "SettingsLegal",
  "SettingsSheet",
  "ThreadSettingsSheet",
]);

/**
 * Pathname of the topmost NON-overlay route — the screen the workspace is
 * actually "on", regardless of any sheets floating above it.
 */
function workspacePathFromState(state: NavigationState): string {
  const routes = state.routes.filter((route) => !WORKSPACE_OVERLAY_ROUTES.has(route.name));

  const effectiveState =
    routes.length > 0 && routes.length !== state.routes.length
      ? { ...state, routes, index: routes.length - 1 }
      : state;

  const path = getPathFromState(effectiveState, navigationPathConfig);

  return path.startsWith("/") ? path : `/${path}`;
}

// The drain hook subscribes to the outbox, all thread shells, projects, and
// connection statuses. Hosting it in a null-rendering leaf keeps those
// updates from re-rendering RootStackLayout (and with it every screen) on
// each enqueue, shell change, or reconnect.
function ThreadOutboxDrainWorker() {
  useThreadOutboxDrain();

  return null;
}

function RootStackLayout(props: {
  readonly children: React.ReactNode;
  readonly state: NavigationState;
}) {
  const navigation = useNavigation();
  const { pendingShare } = useIncomingShare();
  const sharePresentationRef = useRef(EMPTY_INCOMING_SHARE_PRESENTATION_STATE);
  useAgentNotificationNavigation();
  // Launcher app shortcuts: routes shortcut taps and tracks opened threads.
  useAppShortcuts(props.state);
  useEffect(() => {
    const topRouteName = props.state.routes[props.state.index]?.name;

    const transition = transitionIncomingSharePresentation(sharePresentationRef.current, {
      isShareSheetPresented: topRouteName === "NewTaskSheet",
      pendingShareId: pendingShare?.id ?? null,
    });

    sharePresentationRef.current = transition.state;

    if (!transition.shareIdToPresent) {
      return;
    }

    navigation.navigate("NewTaskSheet", {
      screen: "NewTask",
      params: { incomingShareId: transition.shareIdToPresent },
    });
  }, [navigation, pendingShare, props.state]);
  // Full pathname (sheets included) for keyboard-command scoping; the
  // workspace layout only reacts to the underlying non-overlay route.
  const path = getPathFromState(props.state, navigationPathConfig);
  const pathname = path.startsWith("/") ? path : `/${path}`;
  const workspacePathname = workspacePathFromState(props.state);

  return (
    <HardwareKeyboardCommandProvider pathname={pathname}>
      <ThreadOutboxDrainWorker />
      <ShowcaseCaptureCoordinator pathname={pathname} />
      <ExistingThreadSettingsRouteProvider>
        <AdaptiveWorkspaceLayout pathname={workspacePathname}>
          {props.children}
        </AdaptiveWorkspaceLayout>
      </ExistingThreadSettingsRouteProvider>
    </HardwareKeyboardCommandProvider>
  );
}

function NotFoundScreen() {
  const navigation = useNavigation();
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));

  const returnHomeButtonStyle = StyleSheet.flatten([
    {
      borderRadius: 999,
      paddingHorizontal: 20,
      paddingVertical: 14,
    },
    primaryBgStyle,
  ]);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-3xl font-t3-bold text-foreground" selectable>
        Route not found
      </Text>
      <Pressable
        style={returnHomeButtonStyle}
        onPress={() => navigation.dispatch(StackActions.replace("Home"))}
      >
        <Text className="text-base font-t3-bold text-primary-foreground">Return home</Text>
      </Pressable>
    </ScrollView>
  );
}

export const RootStack = createNativeStackNavigator({
  initialRouteName: "Home",
  layout: RootStackLayout,
  screenOptions: {
    headerShown: false,
  },
  screens: {
    Home: createNativeStackScreen({
      screen: HomeRouteScreen,
      linking: "",
      options: {
        ...GLASS_HEADER_OPTIONS,
        contentStyle: { backgroundColor: "transparent" },
        headerBackVisible: false,
        ...getCompactBrandHeaderOptions(),
      },
    }),
    Thread: createNativeStackScreen({
      screen: ThreadRouteScreen,
      linking: THREAD_LINKING_PREFIX,
      options: GLASS_HEADER_OPTIONS,
    }),
    ThreadSettingsSheet: createNativeStackScreen({
      screen: ExistingThreadSettingsRouteScreen,
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
    SettingsSheet: createNativeStackScreen({
      screen: SettingsSheetStack,
      linking: "settings",
      options: {
        gestureEnabled: true,
        headerShown: false,
        // Android pushes settings as a regular full page with an in-screen
        // back header; iOS keeps the detented form sheet.
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [0.7, 0.92],
              sheetGrabberVisible: true,
            }),
      },
    }),
    SettingsLegal: createNativeStackScreen({
      screen: SettingsLegalRouteScreen,
      linking: "settings/legal",
      options: {
        ...LEGAL_DOCUMENT_HEADER_OPTIONS,
        title: "Legal",
      },
    }),
    Connections: createNativeStackScreen({
      screen: ConnectionsRouteScreen,
      linking: "connections",
      options: {
        title: "Environments",
        // Android: full page; the screen renders its own AndroidScreenHeader,
        // so the native bar stays hidden. iOS keeps the sheet.
        ...(Platform.OS === "android"
          ? { presentation: "card" as const, headerShown: false }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [0.55, 0.7],
              sheetGrabberVisible: true,
            }),
      },
    }),
    ConnectionsNew: createNativeStackScreen({
      screen: ConnectionsNewRouteScreen,
      linking: "connections/new",
      options: {
        ...FORM_SHEET_PRESENTATION_OPTIONS,
        sheetAllowedDetents: [0.55, 0.7],
        sheetGrabberVisible: true,
      },
    }),
    NewTaskSheet: createNativeStackScreen({
      screen: NewTaskSheetStack,
      linking: "new",
      // The whole new-task flow (choose project → draft) shares
      // draft state via NewTaskFlowProvider. The expo-router era mounted it in
      // app/new/_layout.tsx; this layout wrapper is the native-stack equivalent.
      layout: ({ children }) => (
        <NewTaskFlowProvider>
          <View className="flex-1 bg-sheet-solid">{children}</View>
        </NewTaskFlowProvider>
      ),
      options: {
        gestureEnabled: true,
        headerShown: false,
        // Android pushes the flow as a regular full page — the draft should
        // read like a thread that just doesn't exist yet; iOS keeps the sheet.
        ...(Platform.OS === "android"
          ? { presentation: "card" as const }
          : {
              ...FORM_SHEET_PRESENTATION_OPTIONS,
              sheetAllowedDetents: [0.92],
              sheetGrabberVisible: true,
            }),
      },
    }),
    NotFound: createNativeStackScreen({
      screen: NotFoundScreen,
      linking: "*",
    }),
  },
});

const navigationPathConfig = {
  screens: createPathConfigForStaticNavigation(RootStack) ?? {},
};

declare global {
  namespace ReactNavigation {
    interface RootParamList extends MobileRootParams {}
  }
}
