// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodePath from "node:path";

import * as NodeProcess from "node:process";

import * as NodeURL from "node:url";

import {
  type ShowcaseAppearance,
  type ShowcaseAndroidDevice,
  type ShowcaseDevice,
  type ShowcaseScene,
  type ShowcaseTheme,
} from "../../mobile-showcase.config.ts";

export const REPO_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../../..",
);

export const MOBILE_ROOT = NodePath.join(REPO_ROOT, "apps/mobile");

export const ANDROID_PACKAGE = "dev.leodoes.akeru";

export const APP_SCHEME = "akeru";

export const IOS_READY_FILENAME = "T3ShowcaseReadyScene";

export const SERVER_HOST = "0.0.0.0";

export const IOS_SIMULATOR_ARCH = NodeProcess.arch === "arm64" ? "arm64" : "x86_64";

export const IOS_APP_PATH = NodePath.join(
  MOBILE_ROOT,
  ".showcase/ios-derived-data/Build/Products/Debug-iphonesimulator/AkeruBot.app",
);

export const ANDROID_APK_PATH = NodePath.join(
  MOBILE_ROOT,
  "android/app/build/outputs/apk/debug/app-debug.apk",
);

export function resolveAndroidSdkRoot(
  environment: Readonly<Record<string, string | undefined>>,
  platform: NodeJS.Platform = NodeProcess.platform,
): string {
  const configured = environment.ANDROID_HOME ?? environment.ANDROID_SDK_ROOT;
  if (configured) return configured;
  const home = environment.HOME ?? environment.USERPROFILE ?? "";
  return NodePath.join(home, platform === "darwin" ? "Library/Android/sdk" : "Android/Sdk");
}

export const ANDROID_SDK_ROOT = resolveAndroidSdkRoot(NodeProcess.env);

export const MOBILE_BUILD_ENV = {
  ...NodeProcess.env,
  ANDROID_HOME: ANDROID_SDK_ROOT,
  APP_VARIANT: "production",
  EXPO_NO_GIT_STATUS: "1",
  // Lets the capture build require full screen on iPad so the app can rotate
  // itself to landscape (see app.config.ts).
  T3_SHOWCASE_CAPTURE_BUILD: "1",
  JAVA_HOME:
    NodeProcess.env.JAVA_HOME ??
    (NodeProcess.platform === "darwin"
      ? "/Applications/Android Studio.app/Contents/jbr/Contents/Home"
      : undefined),
  NODE_ENV: "development",
};

export interface CliOptions {
  readonly platforms: ReadonlySet<ShowcaseDevice["platform"]>;
  readonly deviceIds: ReadonlySet<string>;
  readonly scenes: ReadonlySet<ShowcaseScene>;
  readonly appearances: ReadonlySet<ShowcaseAppearance>;
  readonly themes: ReadonlySet<ShowcaseTheme>;
  readonly skipBuild: boolean;
  readonly skipMetro: boolean;
  readonly keepRunning: boolean;
  readonly validateOnly: boolean;
  readonly list: boolean;
}

export interface ShowcaseCapture {
  readonly device: ShowcaseDevice;
  readonly scenes: ReadonlyArray<ShowcaseScene>;
  readonly appearance: ShowcaseAppearance;
  readonly theme: ShowcaseTheme;
}

export interface IosCaptureCleanup {
  readonly udid: string;
  readonly startedByRunner: boolean;
  readonly createdByRunner: boolean;
}

export interface AndroidCaptureCleanup {
  readonly device: ShowcaseAndroidDevice;
  readonly serial: string;
  readonly startedByRunner: boolean;
}
