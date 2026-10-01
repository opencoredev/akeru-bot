import type { NativeStackNavigationOptions } from "@react-navigation/native-stack";
import { Platform } from "react-native";
import {
  SettingsLegalDocumentCloseHeaderButton,
  SettingsLegalDocumentExternalHeaderButton,
} from "./features/settings/components/SettingsLegalDocumentRouteScreen";
import { NATIVE_LIQUID_GLASS_SUPPORTED } from "./native/native-glass";
import { nativeHeaderScrollEdgeEffects } from "./native/StackHeader";

const HEADER_SCROLL_EDGE_EFFECTS = nativeHeaderScrollEdgeEffects(Platform.OS, Platform.Version);

type AppScreenOptions = NativeStackNavigationOptions & {
  readonly unstable_navigationItemStyle?: "editor";
};

// Shared header presets. Screens only override genuinely dynamic values (titles,
// subtitles, toolbar items, search callbacks) via NativeStackScreenOptions.
//
// GLASS: transparent header over the screen's primary scroll view on supported
// iOS versions. Pre-glass iOS gets the same solid material as internal-scroll
// surfaces so content is laid out below the bar instead of underlapping it.
export const GLASS_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? { backgroundColor: "transparent" } : undefined,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: NATIVE_LIQUID_GLASS_SUPPORTED,
  scrollEdgeEffects: NATIVE_LIQUID_GLASS_SUPPORTED ? HEADER_SCROLL_EDGE_EFFECTS : undefined,
  unstable_navigationItemStyle: NATIVE_LIQUID_GLASS_SUPPORTED ? "editor" : undefined,
};

// SOLID: opaque sheet-colored header for surfaces whose content scrolls internally
// — there is nothing for glass to sample there.
const SOLID_HEADER_OPTIONS: AppScreenOptions = {
  headerBackButtonDisplayMode: "minimal",
  headerBackTitle: "",
  headerLargeTitle: false,
  headerShadowVisible: false,
  headerShown: true,
  headerTitleStyle: { fontSize: 18, fontWeight: "800" },
  headerTransparent: false,
  unstable_navigationItemStyle: Platform.OS === "ios" ? "editor" : undefined,
};

// Solid header variant for screens inside sheets (centered title, no editor style).
const SHEET_SOLID_HEADER_OPTIONS: AppScreenOptions = {
  ...SOLID_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

// A native glass header for a sheet screen whose primary child is a scroll
// view. The centered sheet title stays stable while UIKit supplies scroll-edge
// fading from that child.
export const SHEET_GLASS_HEADER_OPTIONS: AppScreenOptions = {
  ...GLASS_HEADER_OPTIONS,
  unstable_navigationItemStyle: undefined,
};

export const LEGAL_DOCUMENT_HEADER_OPTIONS: AppScreenOptions = {
  ...SHEET_SOLID_HEADER_OPTIONS,
  headerBackVisible: false,
  headerLeft: SettingsLegalDocumentCloseHeaderButton,
  headerRight: () => <SettingsLegalDocumentExternalHeaderButton />,
  presentation: "fullScreenModal",
};
