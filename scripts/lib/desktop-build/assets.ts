import { BRAND_ASSET_PATHS, type WebAssetBrand } from "../brand-assets.ts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import { ChildProcess } from "effect/unstable/process";

import { runCommand } from "./process.ts";

import {
  DesktopIconSourceMissingError,
  DesktopDmgBackgroundSourceMissingError,
  LinuxIconResizeError,
  BundledClientAssetsMissingError,
} from "./errors.ts";

const LINUX_ICON_SIZES = [16, 22, 24, 32, 48, 64, 128, 256, 512] as const;

export interface DesktopBuildIconAssets {
  readonly macIconPng: string;
  readonly macIconComposer: string;
  readonly linuxIconPng: string;
  readonly windowsIconIco: string;
}

function generateMacIconSet(
  sourcePng: string,
  targetIcns: string,
  tmpRoot: string,
  path: Path.Path,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const iconsetDir = path.join(tmpRoot, "icon.iconset");
    yield* fs.makeDirectory(iconsetDir, { recursive: true });

    const iconSizes = [16, 32, 128, 256, 512] as const;

    for (const size of iconSizes) {
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${size} ${size} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}.png`)}`,
        { label: `sips icon ${size}x${size}`, verbose },
      );

      const retinaSize = size * 2;
      yield* runCommand(
        ChildProcess.make(
          {},
        )`sips -z ${retinaSize} ${retinaSize} ${sourcePng} --out ${path.join(iconsetDir, `icon_${size}x${size}@2x.png`)}`,
        { label: `sips icon ${size}x${size}@2x`, verbose },
      );
    }

    yield* runCommand(ChildProcess.make({})`iconutil -c icns ${iconsetDir} -o ${targetIcns}`, {
      label: "iconutil icns",
      verbose,
    });
  });
}

export function stageMacIcons(
  stageResourcesDir: string,
  sourcePng: string,
  composerSource: string,
  verbose: boolean,
) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "mac",
        sourcePath: sourcePng,
      });
    }

    const tmpRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-icon-build-",
    });

    const iconPngPath = path.join(stageResourcesDir, "icon.png");
    const iconIcnsPath = path.join(stageResourcesDir, "icon.icns");

    // Stage the Icon Composer bundle so electron-builder compiles an asset
    // catalog with light, dark, and tinted variants. macOS 26 themes legacy
    // .icns icons itself, which turned the cream tile black in dark mode.
    yield* fs.copy(composerSource, path.join(stageResourcesDir, "akeru.icon"));

    yield* runCommand(ChildProcess.make({})`sips -z 512 512 ${sourcePng} --out ${iconPngPath}`, {
      label: "sips mac icon",
      verbose,
    });

    yield* generateMacIconSet(sourcePng, iconIcnsPath, tmpRoot, path, verbose);
  });
}

export const stageDesktopDmgBackground = Effect.fn("stageDesktopDmgBackground")(function* (
  stageResourcesDir: string,
  verbose: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sourcePath = path.join(stageResourcesDir, "dmg", "dmg-background-latest.svg");

  if (!(yield* fs.exists(sourcePath))) {
    return yield* new DesktopDmgBackgroundSourceMissingError({ channel: "latest", sourcePath });
  }

  for (const output of [
    { suffix: "", width: 540, height: 380 },
    { suffix: "@2x", width: 1080, height: 760 },
  ] as const) {
    const targetPath = path.join(
      stageResourcesDir,
      "dmg",
      `dmg-background-latest${output.suffix}.png`,
    );

    yield* runCommand(
      ChildProcess.make(
        {},
      )`sips -s format png -z ${output.height} ${output.width} ${sourcePath} --out ${targetPath}`,
      {
        label: `sips latest DMG background${output.suffix || "@1x"}`,
        verbose,
      },
    );
  }
});

export function stageLinuxIcons(stageResourcesDir: string, sourcePng: string, verbose: boolean) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (!(yield* fs.exists(sourcePng))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "linux",
        sourcePath: sourcePng,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.png");
    yield* fs.copyFile(sourcePng, iconPath);

    const iconsDir = path.join(stageResourcesDir, "icons");
    yield* fs.makeDirectory(iconsDir, { recursive: true });

    for (const iconSize of LINUX_ICON_SIZES) {
      yield* stageLinuxIconSize(
        sourcePng,
        path.join(iconsDir, `${iconSize}x${iconSize}.png`),
        iconSize,
        verbose,
      );
    }
  });
}

export function stageLinuxIconSize(
  sourcePng: string,
  targetPng: string,
  iconSize: number,
  verbose: boolean,
) {
  const resize = (command: string) =>
    runCommand(
      ChildProcess.make(command, [sourcePng, "-resize", `${iconSize}x${iconSize}`, targetPng]),
      { label: `${command} linux icon ${iconSize}x${iconSize}`, verbose },
    );

  return resize("magick").pipe(
    Effect.catch((primaryCause) =>
      resize("convert").pipe(
        Effect.mapError(
          (fallbackCause) =>
            new LinuxIconResizeError({
              operation: "resize",
              iconSize,
              primaryTool: "magick",
              fallbackTool: "convert",
              cause: new AggregateError(
                [primaryCause, fallbackCause],
                "Both Linux icon resize tool attempts failed.",
                { cause: primaryCause },
              ),
            }),
        ),
      ),
    ),
  );
}

export function stageWindowsIcons(stageResourcesDir: string, sourceIco: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    if (!(yield* fs.exists(sourceIco))) {
      return yield* new DesktopIconSourceMissingError({
        platform: "win",
        sourcePath: sourceIco,
      });
    }

    const iconPath = path.join(stageResourcesDir, "icon.ico");
    yield* fs.copyFile(sourceIco, iconPath);
  });
}

export function validateBundledClientAssets(clientDir: string) {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const indexPath = path.join(clientDir, "index.html");
    const indexHtml = yield* fs.readFileString(indexPath);

    const refs = [...indexHtml.matchAll(/\b(?:src|href)=["']([^"']+)["']/g)].flatMap((match) =>
      match[1] === undefined ? [] : [match[1]],
    );

    const missing: string[] = [];

    for (const ref of refs) {
      const normalizedRef = ref.split("#")[0]?.split("?")[0] ?? "";

      if (!normalizedRef) continue;

      if (normalizedRef.startsWith("http://") || normalizedRef.startsWith("https://")) continue;

      if (normalizedRef.startsWith("data:") || normalizedRef.startsWith("mailto:")) continue;

      const ext = path.extname(normalizedRef);

      if (!ext) continue;

      const relativePath = normalizedRef.replace(/^\/+/, "");
      const assetPath = path.join(clientDir, relativePath);

      if (!(yield* fs.exists(assetPath))) {
        missing.push(normalizedRef);
      }
    }

    if (missing.length > 0) {
      return yield* new BundledClientAssetsMissingError({
        indexPath,
        missingFiles: missing,
      });
    }
  });
}

export const DESKTOP_WEB_ASSET_BRAND: WebAssetBrand = "production";

export const DESKTOP_BUILD_ICON_ASSETS: DesktopBuildIconAssets = {
  macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
  macIconComposer: BRAND_ASSET_PATHS.productionMacIconComposer,
  linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
  windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
};
