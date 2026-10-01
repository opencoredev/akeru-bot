// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Host-side simulator and emulator automation uses Node subprocess and timing APIs directly.
import * as NodeProcess from "node:process";

import {
  type ShowcaseAppearance,
  type ShowcaseConfig,
  type ShowcaseDevice,
  SHOWCASE_SCENES,
  type ShowcaseScene,
  SHOWCASE_THEMES,
  type ShowcaseTheme,
} from "../mobile-showcase.config.ts";

import { type CliOptions, type ShowcaseCapture } from "./paths.ts";

function argumentValue(args: ReadonlyArray<string>, index: number, flag: string): string {
  const value = args[index + 1];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}

export function parseShowcaseCliArgs(args: ReadonlyArray<string>): CliOptions {
  const platforms = new Set<ShowcaseDevice["platform"]>();
  const deviceIds = new Set<string>();
  const scenes = new Set<ShowcaseScene>();
  const appearances = new Set<ShowcaseAppearance>();
  const themes = new Set<ShowcaseTheme>();
  let skipBuild = false;
  let skipMetro = false;
  let keepRunning = false;
  let validateOnly = false;
  let list = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];

    if (argument === "--platform") {
      const value = argumentValue(args, index, argument);

      if (value !== "ios" && value !== "android" && value !== "all") {
        throw new Error(`Unsupported platform '${value}'. Use ios, android, or all.`);
      }

      if (value === "all") {
        platforms.add("ios");
        platforms.add("android");
      } else {
        platforms.add(value);
      }

      index += 1;
    } else if (argument === "--device") {
      deviceIds.add(argumentValue(args, index, argument));
      index += 1;
    } else if (argument === "--scene") {
      const value = argumentValue(args, index, argument);

      const scene = SHOWCASE_SCENES.find((scene) => scene === value);

      if (scene === undefined) {
        throw new Error(`Unsupported scene '${value}'. Use ${SHOWCASE_SCENES.join(", ")}.`);
      }

      scenes.add(scene);
      index += 1;
    } else if (argument === "--appearance") {
      const value = argumentValue(args, index, argument);

      if (value !== "light" && value !== "dark" && value !== "both") {
        throw new Error(`Unsupported appearance '${value}'. Use light, dark, or both.`);
      }

      if (value === "both") {
        appearances.add("light");
        appearances.add("dark");
      } else {
        appearances.add(value);
      }

      index += 1;
    } else if (argument === "--theme") {
      const value = argumentValue(args, index, argument);

      if (value === "all") {
        for (const theme of SHOWCASE_THEMES) themes.add(theme);
      } else {
        const theme = SHOWCASE_THEMES.find((theme) => theme === value);

        if (theme !== undefined) {
          themes.add(theme);
        } else {
          // The app silently falls back to its default palette for an unknown id,
          // so reject it here rather than shipping a mislabeled screenshot.
          throw new Error(
            `Unsupported theme '${value}'. Use ${SHOWCASE_THEMES.join(", ")}, or all.`,
          );
        }
      }

      index += 1;
    } else if (argument === "--skip-build") {
      skipBuild = true;
    } else if (argument === "--skip-metro") {
      skipMetro = true;
    } else if (argument === "--keep-running") {
      keepRunning = true;
    } else if (argument === "--validate-only") {
      validateOnly = true;
    } else if (argument === "--list") {
      list = true;
    } else if (argument === "--help" || argument === "-h") {
      list = true;
    } else {
      throw new Error(`Unknown option '${argument}'.`);
    }
  }

  return {
    platforms,
    deviceIds,
    scenes,
    appearances,
    themes,
    skipBuild,
    skipMetro,
    keepRunning,
    validateOnly,
    list,
  };
}

export function planShowcaseCaptures(
  config: ShowcaseConfig,
  options: Pick<CliOptions, "platforms" | "deviceIds" | "scenes" | "appearances" | "themes">,
): ReadonlyArray<ShowcaseCapture> {
  const captures = config.devices
    .filter((device) => options.platforms.size === 0 || options.platforms.has(device.platform))
    .filter((device) => options.deviceIds.size === 0 || options.deviceIds.has(device.id))
    .flatMap((device) => {
      const appearances =
        options.appearances.size === 0 ? [device.appearance] : options.appearances;

      const themes = options.themes.size === 0 ? [device.theme] : options.themes;

      return [...appearances].flatMap((appearance) =>
        [...themes].map((theme) => ({
          device,
          appearance,
          theme,
          scenes:
            options.scenes.size === 0
              ? device.scenes
              : device.scenes.filter((scene) => options.scenes.has(scene)),
        })),
      );
    })
    .filter((capture) => capture.scenes.length > 0);

  const knownDeviceIds = new Set(config.devices.map((device) => device.id));

  for (const id of options.deviceIds) {
    if (!knownDeviceIds.has(id)) {
      throw new Error(`Unknown device '${id}'. Run with --list to see configured devices.`);
    }
  }

  if (captures.length === 0) {
    throw new Error("No captures match the selected platform, device, and scene filters.");
  }

  return captures;
}

export function printUsage(config: ShowcaseConfig): void {
  NodeProcess.stdout.write(`App screenshot showcase

Usage:
  pnpm --filter @akeru/mobile screenshots [options]

Options:
  --platform ios|android|all  Capture one platform (repeatable)
  --device <id>              Capture one configured device (repeatable)
  --scene <name>             Capture one scene (repeatable)
  --appearance light|dark|both
                             Override the configured appearance
  --theme <id>|all           Override the configured palette (repeatable)
  --skip-build               Reuse the existing simulator app / debug APK
  --skip-metro               Reuse an already running showcase Metro server
  --keep-running             Leave devices and Metro running after capture
  --validate-only            Validate existing upload assets without capturing
  --list                     Print this help and the configured matrix

Scenes: ${SHOWCASE_SCENES.join(", ")}
Themes: ${SHOWCASE_THEMES.join(", ")}

Configured devices:
${config.devices
  .map((device) => {
    const target = device.platform === "ios" ? device.simulator : device.avd;

    return `  ${device.id.padEnd(18)} ${device.platform.padEnd(8)} ${target} -> ${device.storeAsset.directory}/{light|dark}/<theme> (${device.storeAsset.width}×${device.storeAsset.height}, default ${device.appearance} ${device.theme}) [${device.scenes.join(", ")}]`;
  })
  .join("\n")}
`);
}
