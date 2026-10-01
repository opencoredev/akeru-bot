import { assert, it } from "@effect/vitest";

import * as ConfigProvider from "effect/ConfigProvider";

import * as FileSystem from "effect/FileSystem";

import * as Effect from "effect/Effect";

import * as Path from "effect/Path";

import {
  BuildCommandFailedError,
  DesktopDmgBackgroundSourceMissingError,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  DESKTOP_PLUGIN_CATALOG_RESOURCE_SOURCE_DIR,
  MAC_FILE_EXCLUSIONS,
  LinuxIconResizeError,
  DESKTOP_BUILD_ICON_ASSETS,
  DESKTOP_WEB_ASSET_BRAND,
  stageLinuxIconSize,
  stageDesktopDmgBackground,
  stageResourceMonitor,
  WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_ASAR_UNPACK_GLOB,
} from "./build-desktop-artifact.ts";

import { BRAND_ASSET_PATHS } from "./lib/brand-assets.ts";

import { iconResizeSpawnerLayer } from "./test-support/desktop-build.ts";

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it("uses production desktop artwork", () => {
    assert.deepStrictEqual(DESKTOP_BUILD_ICON_ASSETS, {
      macIconPng: BRAND_ASSET_PATHS.productionMacIconPng,
      macIconComposer: BRAND_ASSET_PATHS.productionMacIconComposer,
      linuxIconPng: BRAND_ASSET_PATHS.productionLinuxIconPng,
      windowsIconIco: BRAND_ASSET_PATHS.productionWindowsIconIco,
    });
  });

  it("uses production web artwork", () => {
    assert.equal(DESKTOP_WEB_ASSET_BRAND, "production");
  });

  it.effect("omits update feeds for pull request preview builds", () =>
    Effect.gen(function* () {
      const preview = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33-pr.8182.1",
        false,
        false,
        undefined,
        undefined,
      );

      const release = yield* createBuildConfig(
        "mac",
        "dmg",
        "0.0.33",
        false,
        false,
        undefined,
        undefined,
      );

      assert.notProperty(preview, "publish");
      assert.deepStrictEqual(release.publish, [
        {
          provider: "github",
          owner: "pingdotgg",
          repo: "t3code",
          releaseType: "release",
        },
      ]);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromEnv({ env: { GITHUB_REPOSITORY: "pingdotgg/t3code" } }),
        ),
      ),
    ),
  );

  it.effect("applies platform-specific packaging to the build config", () =>
    Effect.gen(function* () {
      const mac = yield* createBuildConfig("mac", "dmg", "1.2.3", false, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
      });

      const linux = yield* createBuildConfig(
        "linux",
        "AppImage",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      const win = yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      // All platforms keep app.asar fully packed; Windows ships the server
      // tree as the hand-packed server.asar sidecar in extraResources instead
      // of unpacking thousands of loose files at install time.
      assert.notProperty(mac, "asarUnpack");
      assert.notProperty(linux, "asarUnpack");
      assert.notProperty(win, "asarUnpack");
      assert.equal(linux.artifactName, "Akeru-Bot-${version}-x64.${ext}");
      assert.deepStrictEqual(win.extraResources, [
        {
          from: "apps/desktop/prod-resources/resource-monitor",
          to: "resource-monitor",
        },
        {
          from: DESKTOP_PLUGIN_CATALOG_RESOURCE_SOURCE_DIR,
          to: "plugins",
        },
        ...WINDOWS_SERVER_EXTRA_RESOURCES,
      ]);
      assert.deepStrictEqual(win.nsis, { differentialPackage: true });
      // Windows registers akeru:// through the installer so the OS routes
      // activations here instead of an older T3 Code install. Production
      // packages never claim the development scheme.
      assert.deepStrictEqual(win.protocols, [
        {
          name: "Akeru Bot",
          schemes: ["akeru"],
        },
      ]);
      // Native binaries and helper executables cannot load from inside an
      // asar; everything else stays packed. The Claude SDK platform packages
      // and .bin shims never ship.
      assert.equal(
        WINDOWS_SERVER_ASAR_UNPACK_GLOB,
        "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}",
      );
      assert.deepStrictEqual(WINDOWS_SERVER_ASAR_IGNORE_GLOBS, [
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
        "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
        "**/node_modules/.bin",
        "**/node_modules/.bin/**",
      ]);
      assert.deepStrictEqual(mac.dmg, {
        title: "Akeru Bot (Alpha) 1.2.3 Installer",
        background: "dmg/dmg-background-latest.png",
        window: { width: 540, height: 412 },
        contents: [
          { x: 130, y: 220, type: "file" },
          { x: 410, y: 220, type: "link", path: "/Applications" },
        ],
        iconSize: 80,
        iconTextSize: 12,
      });
      // Linux must register the renderer schemes so the generated .desktop
      // entry advertises MimeType=x-scheme-handler/akeru; for OAuth deep links.
      assert.deepStrictEqual((linux.linux as Record<string, unknown>).protocols, [
        {
          name: "Akeru Bot",
          schemes: ["akeru", "akeru-dev"],
        },
      ]);
      assert.deepStrictEqual(mac.files, [...DESKTOP_FILE_EXCLUSIONS, ...MAC_FILE_EXCLUSIONS]);
      assert.equal((mac.mac as Record<string, unknown>).identity, "-");
      assert.equal((mac.mac as Record<string, unknown>).notarize, false);
      assert.equal(
        (mac.mac as Record<string, unknown>).entitlements,
        "/tmp/entitlements.mac.plist",
      );
      assert.match(String((mac.mac as Record<string, unknown>).sign), /\/scripts\/sign-macos\.ts$/);

      for (const config of [linux, win]) {
        assert.deepStrictEqual(config.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
        assert.deepStrictEqual(config.files, DESKTOP_FILE_EXCLUSIONS);
      }

      assert.deepStrictEqual(mac.electronLanguages, DESKTOP_ELECTRON_LANGUAGES);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("stages a cached resource monitor without invoking Cargo", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const repoRoot = yield* fs.makeTempDirectoryScoped({
          prefix: "t3-resource-monitor-cache-test-",
        });

        const binaryPath = path.join(
          repoRoot,
          "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
        );

        const stageResourcesDir = path.join(repoRoot, "stage");
        yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "cached monitor");

        yield* stageResourceMonitor({
          repoRoot,
          stageResourcesDir,
          platform: "linux",
          arch: "x64",
          verbose: false,
        }).pipe(
          Effect.provide(
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: { T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR: "true" },
              }),
            ),
          ),
        );

        assert.equal(
          yield* fs.readFileString(
            path.join(stageResourcesDir, "resource-monitor/t3-resource-monitor"),
          ),
          "cached monitor",
        );
      }),
    ),
  );

  it.effect("preserves both Linux icon resize failures with structural context", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const error = yield* stageLinuxIconSize("source.png", "target.png", 512, false).pipe(
        Effect.provide(iconResizeSpawnerLayer(commands, [1, 2])),
        Effect.flip,
      );

      assert.instanceOf(error, LinuxIconResizeError);
      assert.equal(error.operation, "resize");
      assert.equal(error.iconSize, 512);
      assert.equal(error.primaryTool, "magick");
      assert.equal(error.fallbackTool, "convert");
      assert.include(error.message, "512x512");
      assert.include(error.message, "`magick`");
      assert.include(error.message, "`convert`");
      assert.notInclude(error.message, "non-zero exit code");

      assert.instanceOf(error.cause, AggregateError);
      const aggregateCause = error.cause as AggregateError;
      assert.lengthOf(aggregateCause.errors, 2);
      assert.strictEqual(aggregateCause.cause, aggregateCause.errors[0]);
      assert.instanceOf(aggregateCause.errors[0], BuildCommandFailedError);
      assert.instanceOf(aggregateCause.errors[1], BuildCommandFailedError);
      const primaryError = aggregateCause.errors[0] as BuildCommandFailedError;
      const fallbackError = aggregateCause.errors[1] as BuildCommandFailedError;
      assert.equal(primaryError.command, "magick linux icon 512x512");
      assert.equal(primaryError.exitCode, 1);
      assert.include(primaryError.message, "magick linux icon");
      assert.equal(fallbackError.command, "convert linux icon 512x512");
      assert.equal(fallbackError.exitCode, 2);
      assert.include(fallbackError.message, "convert linux icon");
      assert.deepStrictEqual(
        commands.map(({ command }) => command),
        ["magick", "convert"],
      );
    });
  });

  it.effect("fails clearly when the selected DMG background source is missing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;

        const stageResourcesDir = yield* fs.makeTempDirectoryScoped({
          prefix: "t3code-dmg-background-missing-",
        });

        const error = yield* stageDesktopDmgBackground(stageResourcesDir, false).pipe(Effect.flip);

        assert.instanceOf(error, DesktopDmgBackgroundSourceMissingError);
        assert.equal(error.channel, "latest");
        assert.include(error.sourcePath, "dmg-background-latest.svg");
      }),
    ),
  );

  it.effect("adds entitlements and both renderer protocols to signed macOS builds", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "dev.leodoes.akeru");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.equal(mac.notarize, true);
      assert.notProperty(mac, "identity");
      assert.match(String(mac.sign), /\/scripts\/sign-macos\.ts$/);
      assert.deepStrictEqual(mac.protocols, [
        {
          name: "Akeru Bot",
          schemes: ["akeru", "akeru-dev"],
        },
      ]);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );

  it.effect("keeps signed macOS entitlements explicit", () =>
    Effect.gen(function* () {
      const config = yield* createBuildConfig("mac", "dmg", "1.2.3", true, false, undefined, {
        entitlementsPath: "/tmp/entitlements.mac.plist",
      });

      const mac = config.mac as Record<string, unknown>;
      assert.equal(config.appId, "dev.leodoes.akeru");
      assert.equal(mac.entitlements, "/tmp/entitlements.mac.plist");
      assert.notProperty(mac, "provisioningProfile");
      assert.notProperty(mac, "identity");
      assert.equal(mac.notarize, true);
      assert.match(String(mac.sign), /\/scripts\/sign-macos\.ts$/);
    }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })))),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
