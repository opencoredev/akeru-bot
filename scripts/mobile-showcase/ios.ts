// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodeFSP from "node:fs/promises";

import * as NodePath from "node:path";

import {
  type ShowcaseAppearance,
  type ShowcaseConfig,
  type ShowcaseIosDevice,
  type ShowcaseScene,
} from "../mobile-showcase.config.ts";

import {
  MOBILE_ROOT,
  ANDROID_PACKAGE,
  IOS_READY_FILENAME,
  IOS_SIMULATOR_ARCH,
  IOS_APP_PATH,
  MOBILE_BUILD_ENV,
  type ShowcaseCapture,
  type IosCaptureCleanup,
} from "./paths.ts";

import { readPngDimensions, showcaseCaptureDirectory, finalizeCapture } from "./assets.ts";

import { runCommand, commandOutput, delay } from "./process.ts";

export async function buildIos(): Promise<string> {
  const derivedData = NodePath.join(MOBILE_ROOT, ".showcase/ios-derived-data");
  await runCommand("pnpm", ["exec", "expo", "prebuild", "--clean", "--platform", "ios"], {
    cwd: MOBILE_ROOT,
    env: MOBILE_BUILD_ENV,
  });
  await runCommand(
    "xcodebuild",
    [
      "-workspace",
      NodePath.join(MOBILE_ROOT, "ios/AkeruBot.xcworkspace"),
      "-scheme",
      "AkeruBot",
      "-configuration",
      "Debug",
      "-sdk",
      "iphonesimulator",
      "-derivedDataPath",
      derivedData,
      "-quiet",
      `ARCHS=${IOS_SIMULATOR_ARCH}`,
      "ONLY_ACTIVE_ARCH=YES",
      "build",
    ],
    { cwd: MOBILE_ROOT, env: MOBILE_BUILD_ENV },
  );

  return IOS_APP_PATH;
}

interface SimctlDevice {
  readonly name: string;
  readonly udid: string;
  readonly state: "Booted" | "Shutdown" | string;
  readonly isAvailable: boolean;
}

async function findIosSimulator(name: string): Promise<SimctlDevice | null> {
  const parsed = JSON.parse(
    await commandOutput("xcrun", ["simctl", "list", "devices", "available", "-j"]),
  ) as {
    readonly devices: Readonly<Record<string, ReadonlyArray<SimctlDevice>>>;
  };

  const candidates = Object.entries(parsed.devices)
    .filter(([runtime]) => runtime.includes("iOS"))
    .flatMap(([, devices]) => devices)
    .filter((device) => device.isAvailable && device.name === name);

  return candidates.at(-1) ?? null;
}

async function ensureIosSimulator(device: ShowcaseIosDevice): Promise<{
  readonly simulator: SimctlDevice;
  readonly createdByRunner: boolean;
}> {
  const existing = await findIosSimulator(device.simulator);

  if (existing) return { simulator: existing, createdByRunner: false };

  if (!device.simulatorDeviceType) {
    throw new Error(
      `iOS simulator '${device.simulator}' is not installed and has no simulatorDeviceType configured.`,
    );
  }

  const udid = (
    await commandOutput("xcrun", ["simctl", "create", device.simulator, device.simulatorDeviceType])
  ).trim();

  if (!udid) throw new Error(`Could not create iOS simulator '${device.simulator}'.`);

  return {
    simulator: {
      name: device.simulator,
      udid,
      state: "Shutdown",
      isAvailable: true,
    },
    createdByRunner: true,
  };
}

async function normalizeIosSimulator(appearance: ShowcaseAppearance, udid: string): Promise<void> {
  await runCommand("xcrun", ["simctl", "ui", udid, "appearance", appearance]);
  await runCommand("xcrun", [
    "simctl",
    "status_bar",
    udid,
    "override",
    "--time",
    "9:41",
    "--batteryState",
    "charged",
    "--batteryLevel",
    "100",
    "--wifiBars",
    "3",
    "--cellularBars",
    "4",
  ]);
}

// iPadOS 26 windowing ("Chamois") runs UIRequiresFullScreen apps in a fixed
// portrait compatibility window, which defeats the in-app landscape rotation
// the capture build relies on. Switch the device to Full Screen Apps mode
// (Settings > Multitasking & Gestures) and restart SpringBoard to apply it.
async function ensureIosFullScreenAppsMode(udid: string): Promise<void> {
  const current = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "read",
    "com.apple.springboard",
    "SBChamoisWindowingEnabled",
  ]).catch(() => "");

  if (current.trim() === "0") return;

  // The Settings toggle writes all three keys; SBChamoisWindowingEnabled
  // alone is not honored on a freshly created device.
  for (const key of [
    "SBChamoisWindowingEnabled",
    "SBMedusaMultitaskingEnabled",
    "SBFlexibleWindowingPreviouslyEnabledAutomaticStageCreation",
  ]) {
    await runCommand("xcrun", [
      "simctl",
      "spawn",
      udid,
      "defaults",
      "write",
      "com.apple.springboard",
      key,
      "-bool",
      "false",
    ]);
  }

  // A SpringBoard restart is not enough on a freshly created simulator (the
  // first CI run captured with windowing still active), so reboot the device
  // and verify the mode actually stuck.
  await runCommand("xcrun", ["simctl", "shutdown", udid]);
  await runCommand("xcrun", ["simctl", "boot", udid]);
  await runCommand("xcrun", ["simctl", "bootstatus", udid, "-b"]);

  const applied = await commandOutput("xcrun", [
    "simctl",
    "spawn",
    udid,
    "defaults",
    "read",
    "com.apple.springboard",
    "SBChamoisWindowingEnabled",
  ]).catch(() => "");

  if (applied.trim() !== "0") {
    throw new Error(`Simulator ${udid} did not switch to Full Screen Apps mode.`);
  }
}

async function iosAppContainer(udid: string): Promise<string> {
  return (
    await commandOutput("xcrun", ["simctl", "get_app_container", udid, ANDROID_PACKAGE, "data"])
  ).trim();
}

async function waitForIosShowcaseScene(
  udid: string,
  scene: ShowcaseScene,
  timeoutMs = 90_000,
): Promise<void> {
  const readyPath = NodePath.join(
    await iosAppContainer(udid),
    "Library/Caches",
    IOS_READY_FILENAME,
  );

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const readyScene = await NodeFSP.readFile(readyPath, "utf8").catch(() => "");

    if (readyScene.trim() === scene) return;
    await delay(500);
  }

  throw new Error(`iOS showcase scene '${scene}' did not render within ${timeoutMs}ms.`);
}

export async function captureIos(
  capture: ShowcaseCapture & { readonly device: ShowcaseIosDevice },
  appPath: string | null,
  outputDirectory: string,
  config: ShowcaseConfig,
  metroHost: string,
  pairingUrls: ReadonlyArray<string>,
  registerCleanup: (cleanup: IosCaptureCleanup) => void,
): Promise<void> {
  const { simulator, createdByRunner } = await ensureIosSimulator(capture.device);
  const startedByRunner = simulator.state !== "Booted";
  registerCleanup({ udid: simulator.udid, startedByRunner, createdByRunner });

  if (!startedByRunner) {
    // Clear transient SpringBoard state (permission prompts, stale URL-open
    // confirmations, keyboards) without erasing the developer's simulator.
    await runCommand("xcrun", ["simctl", "shutdown", simulator.udid]);
  }

  await runCommand("xcrun", ["simctl", "boot", simulator.udid]);
  await runCommand("xcrun", ["simctl", "bootstatus", simulator.udid, "-b"]);

  if (capture.device.orientation === "landscape") {
    await ensureIosFullScreenAppsMode(simulator.udid);
  }

  await normalizeIosSimulator(capture.appearance, simulator.udid);

  if (appPath) {
    await runCommand("xcrun", ["simctl", "uninstall", simulator.udid, ANDROID_PACKAGE]).catch(
      () => undefined,
    );
    await runCommand("xcrun", ["simctl", "install", simulator.udid, appPath]);
  }

  for (const [key, value] of [
    ["EXDevMenuIsOnboardingFinished", "true"],
    ["EXDevMenuShowFloatingActionButton", "false"],
    ["EXDevMenuShowsAtLaunch", "false"],
  ] as const) {
    await runCommand("xcrun", [
      "simctl",
      "spawn",
      simulator.udid,
      "defaults",
      "write",
      ANDROID_PACKAGE,
      key,
      "-bool",
      value,
    ]);
  }

  const metroUrl = `http://${metroHost}:${config.metroPort}?disableOnboarding=1`;

  const scenePath = NodePath.join(
    await iosAppContainer(simulator.udid),
    "Library/Caches/T3ShowcaseScene",
  );

  const readyPath = NodePath.join(
    await iosAppContainer(simulator.udid),
    "Library/Caches",
    IOS_READY_FILENAME,
  );

  const firstScene = capture.scenes[0] ?? "threads";

  const launchShowcaseApp = async (terminateRunningProcess: boolean) => {
    await runCommand("xcrun", [
      "simctl",
      "launch",
      ...(terminateRunningProcess ? ["--terminate-running-process"] : []),
      simulator.udid,
      ANDROID_PACKAGE,
      "--initialUrl",
      metroUrl,
      "--showcasePairingUrl",
      JSON.stringify(pairingUrls),
      "--showcaseScene",
      firstScene,
      "--showcaseTheme",
      capture.theme,
      // The app rotates itself; Simulator menu UI scripting needs macOS
      // Accessibility permission that CI runners do not grant to osascript.
      "--showcaseOrientation",
      capture.device.orientation ?? "portrait",
    ]);
  };

  await NodeFSP.rm(readyPath, { force: true });
  await NodeFSP.writeFile(scenePath, firstScene);
  await launchShowcaseApp(false);

  for (const [sceneIndex, scene] of capture.scenes.entries()) {
    if (sceneIndex > 0) await NodeFSP.rm(readyPath, { force: true });
    await NodeFSP.writeFile(scenePath, scene);

    if (sceneIndex === 0) {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const isLastAttempt = attempt === 1;

        try {
          // A freshly installed Expo development build can spend well over 30s
          // applying an already-bundled update after it reaches 100%. Killing it
          // at that point sends the next capture back to the dev launcher.
          await waitForIosShowcaseScene(simulator.udid, scene, 120_000);
          break;
        } catch (error) {
          if (isLastAttempt) throw error;
          await launchShowcaseApp(true);
        }
      }
    } else {
      await waitForIosShowcaseScene(simulator.udid, scene);
    }

    await delay(config.settleDelayMs);

    const destination = NodePath.join(
      showcaseCaptureDirectory(outputDirectory, capture),
      `${scene}.png`,
    );

    await runCommand("xcrun", ["simctl", "io", simulator.udid, "screenshot", destination]);

    if (capture.device.orientation === "landscape") {
      // A headless simulator keeps its display portrait while the rotated app
      // renders sideways inside it; with Simulator.app attached the display
      // itself rotates. Only post-rotate the former.
      const { width, height } = readPngDimensions(await NodeFSP.readFile(destination));

      if (height > width) {
        await runCommand("sips", ["--rotate", "270", destination]);
      }
    }

    await finalizeCapture(destination, capture.device);
  }
}
