// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodeChildProcess from "node:child_process";

import * as NodeFSP from "node:fs/promises";

import * as NodePath from "node:path";

import {
  type ShowcaseAppearance,
  type ShowcaseAndroidDevice,
  type ShowcaseConfig,
  type ShowcaseScene,
} from "../mobile-showcase.config.ts";

import {
  REPO_ROOT,
  MOBILE_ROOT,
  ANDROID_PACKAGE,
  APP_SCHEME,
  ANDROID_APK_PATH,
  ANDROID_SDK_ROOT,
  MOBILE_BUILD_ENV,
  type ShowcaseCapture,
  type AndroidCaptureCleanup,
} from "./paths.ts";

import { showcaseCaptureDirectory, finalizeCapture } from "./assets.ts";

import { spawnProcess, runCommand, commandOutput, delay, stopProcess } from "./process.ts";

import { encodeAndroidPairingUrls } from "./environment.ts";

export async function buildAndroid(abis: ReadonlyArray<string>): Promise<string> {
  await runCommand("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "android"], {
    cwd: MOBILE_ROOT,
    env: MOBILE_BUILD_ENV,
  });
  await runCommand(
    "./gradlew",
    [
      "app:assembleDebug",
      ...(abis.length > 0 ? [`-PreactNativeArchitectures=${abis.join(",")}`] : []),
    ],
    {
      cwd: NodePath.join(MOBILE_ROOT, "android"),
      env: MOBILE_BUILD_ENV,
    },
  );

  return ANDROID_APK_PATH;
}

function androidSdkTool(relativePath: string): string {
  return NodePath.join(ANDROID_SDK_ROOT, relativePath);
}

async function adbOutput(serial: string, args: ReadonlyArray<string>): Promise<string> {
  return await commandOutput(androidSdkTool("platform-tools/adb"), ["-s", serial, ...args]);
}

export async function runAdb(serial: string, args: ReadonlyArray<string>): Promise<void> {
  await runCommand(androidSdkTool("platform-tools/adb"), ["-s", serial, ...args]);
}

async function runningAndroidAvds(): Promise<ReadonlyMap<string, string>> {
  const adb = androidSdkTool("platform-tools/adb");

  const devices = (await commandOutput(adb, ["devices"]))
    .split("\n")
    .map((line) => line.trim().split(/\s+/u))
    .flatMap(([serial, state]) =>
      serial?.startsWith("emulator-") && state === "device" ? [serial] : [],
    );

  const result = new Map<string, string>();

  for (const serial of devices) {
    const avdName = (await adbOutput(serial, ["emu", "avd", "name"])).split("\n")[0]?.trim();

    if (avdName) result.set(avdName, serial);
  }

  return result;
}

async function waitForAndroidSerial(avd: string, timeoutMs = 120_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const serial = (await runningAndroidAvds()).get(avd);

    if (serial) {
      await runAdb(serial, ["wait-for-device"]);

      const bootCompleted = (
        await adbOutput(serial, ["shell", "getprop", "sys.boot_completed"])
      ).trim();

      if (bootCompleted === "1") return serial;
    }

    await delay(1_000);
  }

  throw new Error(`Android AVD '${avd}' did not finish booting within ${timeoutMs}ms.`);
}

async function normalizeAndroidEmulator(
  device: ShowcaseAndroidDevice,
  appearance: ShowcaseAppearance,
  serial: string,
): Promise<void> {
  await runAdb(serial, ["shell", "settings", "put", "global", "window_animation_scale", "0"]);
  await runAdb(serial, ["shell", "settings", "put", "global", "transition_animation_scale", "0"]);
  await runAdb(serial, ["shell", "settings", "put", "global", "animator_duration_scale", "0"]);
  await runAdb(serial, ["shell", "cmd", "uimode", "night", appearance === "dark" ? "yes" : "no"]);
  await runAdb(serial, ["shell", "settings", "put", "system", "time_12_24", "12"]);
  await runAdb(serial, ["emu", "power", "capacity", "100"]);
  await runAdb(serial, ["shell", "settings", "put", "global", "sysui_demo_allowed", "1"]);
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "enter",
  ]);
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "clock",
    "-e",
    "hhmm",
    "0941",
  ]);
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "battery",
    "-e",
    "level",
    "100",
    "-e",
    "plugged",
    "false",
  ]);

  if (device.viewport) {
    await runAdb(serial, [
      "shell",
      "wm",
      "size",
      `${device.viewport.width}x${device.viewport.height}`,
    ]);

    if (device.viewport.density) {
      await runAdb(serial, ["shell", "wm", "density", String(device.viewport.density)]);
    }
  }
}

async function waitForAndroidShowcaseScene(
  serial: string,
  scene: ShowcaseScene,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const readyScene = await adbOutput(serial, [
      "shell",
      "run-as",
      ANDROID_PACKAGE,
      "cat",
      "files/t3-showcase-ready",
    ]).catch(() => "");

    if (readyScene.trim() === scene) return;
    await delay(500);
  }

  throw new Error(`Android showcase scene '${scene}' did not render within ${timeoutMs}ms.`);
}

async function writeAndroidShowcaseScene(serial: string, scene: ShowcaseScene): Promise<void> {
  await runAdb(serial, [
    "shell",
    `run-as ${ANDROID_PACKAGE} sh -c 'mkdir -p files && rm -f files/t3-showcase-ready && printf %s ${scene} > files/t3-showcase-scene'`,
  ]);
}

async function prepareAndroidShowcaseApp(serial: string): Promise<void> {
  const preferences = `<?xml version="1.0" encoding="utf-8" standalone="yes" ?>
<map>
  <boolean name="isOnboardingFinished" value="true" />
  <boolean name="showsAtLaunch" value="false" />
  <boolean name="showFab" value="false" />
  <boolean name="motionGestureEnabled" value="false" />
  <boolean name="touchGestureEnabled" value="false" />
  <boolean name="keyCommandsEnabled" value="false" />
</map>`;

  const encodedPreferences = Buffer.from(preferences).toString("base64");
  await runAdb(serial, [
    "shell",
    `run-as ${ANDROID_PACKAGE} sh -c 'mkdir -p shared_prefs && printf %s ${encodedPreferences} | base64 -d > shared_prefs/expo.modules.devmenu.sharedpreferences.xml'`,
  ]);
}

export async function captureAndroid(
  capture: ShowcaseCapture & { readonly device: ShowcaseAndroidDevice },
  apkPath: string | null,
  outputDirectory: string,
  config: ShowcaseConfig,
  pairingUrls: ReadonlyArray<string>,
  registerCleanup: (cleanup: AndroidCaptureCleanup) => void,
): Promise<void> {
  const running = await runningAndroidAvds();
  const existingSerial = running.get(capture.device.avd);
  const startedByRunner = !existingSerial;
  let launchedEmulator: NodeChildProcess.ChildProcess | null = null;

  if (startedByRunner) {
    const installedAvds = (await commandOutput(androidSdkTool("emulator/emulator"), ["-list-avds"]))
      .split("\n")
      .map((value) => value.trim());

    if (!installedAvds.includes(capture.device.avd)) {
      throw new Error(
        `Android AVD '${capture.device.avd}' is not installed. Run emulator -list-avds.`,
      );
    }

    launchedEmulator = spawnProcess(
      androidSdkTool("emulator/emulator"),
      ["-avd", capture.device.avd, "-no-snapshot-load", "-no-boot-anim"],
      { stdio: "ignore", detached: true },
    );
    launchedEmulator.unref();
  }

  const serial =
    existingSerial ??
    (await waitForAndroidSerial(capture.device.avd).catch(async (cause: unknown) => {
      if (launchedEmulator) await stopProcess(launchedEmulator);
      throw cause;
    }));

  registerCleanup({ device: capture.device, serial, startedByRunner });
  await normalizeAndroidEmulator(capture.device, capture.appearance, serial);

  if (apkPath) {
    await runAdb(serial, ["install", "-r", apkPath]);
  }

  await runAdb(serial, ["shell", "pm", "clear", ANDROID_PACKAGE]);
  await prepareAndroidShowcaseApp(serial);
  await runAdb(serial, ["reverse", `tcp:${config.metroPort}`, `tcp:${config.metroPort}`]);
  const metroUrl = encodeURIComponent(`http://127.0.0.1:${config.metroPort}?disableOnboarding=1`);
  const firstScene = capture.scenes[0] ?? "threads";
  await runAdb(serial, [
    "shell",
    "am",
    "start",
    "-W",
    "-a",
    "android.intent.action.VIEW",
    "-d",
    `${APP_SCHEME}://expo-development-client/?url=${metroUrl}`,
    "--es",
    "showcasePairingUrl",
    encodeAndroidPairingUrls(pairingUrls),
    "--es",
    "showcaseScene",
    firstScene,
    "--es",
    "showcaseTheme",
    capture.theme,
    ANDROID_PACKAGE,
  ]);

  for (const [sceneIndex, scene] of capture.scenes.entries()) {
    if (sceneIndex > 0) await writeAndroidShowcaseScene(serial, scene);
    await waitForAndroidShowcaseScene(serial, scene);
    await delay(Math.max(config.settleDelayMs, 5_000));

    const destination = NodePath.join(
      showcaseCaptureDirectory(outputDirectory, capture),
      `${scene}.png`,
    );

    const png = await new Promise<Buffer>((resolve, reject) => {
      NodeChildProcess.execFile(
        androidSdkTool("platform-tools/adb"),
        ["-s", serial, "exec-out", "screencap", "-p"],
        { cwd: REPO_ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        (error, stdout) => {
          if (error) reject(error);
          else resolve(stdout);
        },
      );
    });

    await NodeFSP.writeFile(destination, png);
    await finalizeCapture(destination, capture.device);
  }
}

export async function cleanupAndroidViewport(
  device: ShowcaseAndroidDevice,
  serial: string,
): Promise<void> {
  await runAdb(serial, [
    "shell",
    "am",
    "broadcast",
    "-a",
    "com.android.systemui.demo",
    "-e",
    "command",
    "exit",
  ]);

  if (!device.viewport) return;
  await runAdb(serial, ["shell", "wm", "size", "reset"]);

  if (device.viewport.density) {
    await runAdb(serial, ["shell", "wm", "density", "reset"]);
  }
}
