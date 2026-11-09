import { assert, it } from "@effect/vitest";

import * as ConfigProvider from "effect/ConfigProvider";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  DESKTOP_PACKAGE_NAME,
  createBuildConfig,
  DESKTOP_ELECTRON_LANGUAGES,
  DESKTOP_FILE_EXCLUSIONS,
  InvalidMockUpdateServerPortError,
  renderMacEntitlements,
  resolveBuildOptions,
  resolveDesktopProductName,
  DESKTOP_UPDATE_CHANNEL,
  resolveGitHubPublishConfig,
  resolveMockUpdateServerPort,
  resolveMockUpdateServerUrl,
  resolvePackageManagerUserAgent,
  selectElectronZipChecksums,
  WINDOWS_SERVER_EXTRA_RESOURCES,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
} from "./build-desktop-artifact.ts";

import { HostProcessArchitecture, HostProcessPlatform } from "@akeru/shared/hostProcess";
import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

const decodeMacSignConfig = Schema.decodeUnknownEffect(
  Schema.Struct({
    mac: Schema.Struct({ sign: Schema.String }),
  }),
);

it.layer(NodeServices.layer)("build-desktop-artifact", (it) => {
  it.effect("resolves packaged signing resources from the checkout root", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));

      const config = yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
      );

      const parsed = yield* decodeMacSignConfig(config);

      assert.equal(parsed.mac.sign, path.join(repoRoot, "scripts/sign-macos.ts"));
    }),
  );
  it.effect("checks the Electron download against the installed package's checksums", () =>
    Effect.gen(function* () {
      const electronVersion = desktopPackageJson.dependencies.electron;

      const expected = {
        mac: ["darwin-arm64", "darwin-x64"],
        linux: ["linux-arm64", "linux-armv7l", "linux-x64"],
        win: ["win32-arm64", "win32-ia32", "win32-x64"],
      } as const;

      for (const platform of ["mac", "linux", "win"] as const) {
        const config = yield* createBuildConfig(
          platform,
          "dir",
          "1.2.3",
          false,
          false,
          undefined,
          undefined,
        );

        assert.equal(config.electronDownload.unsafelyDisableChecksums, false);
        assert.deepEqual(
          Object.keys(config.electronDownload.checksums).toSorted(),
          expected[platform].map((suffix) => `electron-v${electronVersion}-${suffix}.zip`),
        );

        for (const checksum of Object.values(config.electronDownload.checksums)) {
          assert.match(checksum, /^[0-9a-f]{64}$/);
        }
      }
    }),
  );

  it("keeps only the Electron zips for the requested version and platform", () => {
    const checksums = {
      "electron-v1.2.3-darwin-arm64.zip": "a",
      "electron-v1.2.3-darwin-x64.zip": "b",
      "electron-v1.2.3-darwin-arm64-symbols.zip": "c",
      "electron-v1.2.3-darwin-arm64-dsym.tar.xz": "d",
      "electron-v1.2.3-linux-x64.zip": "e",
      "electron-v1.2.30-darwin-arm64.zip": "f",
      "ffmpeg-v1.2.3-darwin-arm64.zip": "g",
    };

    assert.deepEqual(
      selectElectronZipChecksums({ checksums, electronVersion: "1.2.3", platform: "mac" }),
      {
        "electron-v1.2.3-darwin-arm64.zip": "a",
        "electron-v1.2.3-darwin-x64.zip": "b",
      },
    );
    assert.deepEqual(
      selectElectronZipChecksums({ checksums, electronVersion: "9.9.9", platform: "mac" }),
      {},
    );
  });

  it("uses the latest updater channel", () => {
    assert.equal(DESKTOP_UPDATE_CHANNEL, "latest");
  });

  it("uses the Akeru Bot product name", () => {
    assert.equal(resolveDesktopProductName(), "Akeru Bot (Alpha)");
  });

  it("uses the Akeru package identity for Electron safe storage", () => {
    assert.equal(DESKTOP_PACKAGE_NAME, "akeru-bot");
  });

  it.effect("resolves GitHub desktop publish config from Effect config", () =>
    Effect.gen(function* () {
      const latestConfig = yield* resolveGitHubPublishConfig().pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_UPDATE_REPOSITORY: "pingdotgg/t3code",
              },
            }),
          ),
        ),
      );

      assert.deepStrictEqual(latestConfig, {
        provider: "github",
        owner: "pingdotgg",
        repo: "t3code",
        releaseType: "release",
      });
    }),
  );

  it("limits Electron locales and excludes the unused Claude SDK executable", () => {
    assert.deepStrictEqual(DESKTOP_ELECTRON_LANGUAGES, ["en-US"]);
    assert.deepStrictEqual(DESKTOP_FILE_EXCLUSIONS, [
      "!**/node_modules/@anthropic-ai/claude-agent-sdk-*/**/*",
      "!apps/desktop/prod-resources/windows-server",
      "!apps/desktop/prod-resources/windows-server/**/*",
    ]);
    assert.equal(WINDOWS_SERVER_RESOURCE_SOURCE_DIR, "apps/desktop/prod-resources/windows-server");
    assert.deepStrictEqual(WINDOWS_SERVER_EXTRA_RESOURCES, [
      {
        from: "apps/desktop/prod-resources/windows-server",
        to: ".",
        filter: ["server.asar", "server.asar.unpacked/**/*"],
      },
    ]);
  });

  it("renders signed macOS entitlements", () => {
    const entitlements = renderMacEntitlements();

    assert.include(entitlements, "<key>com.apple.security.cs.allow-jit</key>");
    assert.include(
      entitlements,
      "<key>com.apple.security.cs.allow-unsigned-executable-memory</key>",
    );
    assert.include(entitlements, "<key>com.apple.security.cs.disable-library-validation</key>");
    assert.include(entitlements, "<key>com.apple.security.device.audio-input</key>");
    assert.notInclude(entitlements, "com.apple.developer.associated-domains");
    assert.notInclude(entitlements, "com.apple.application-identifier");
  });

  it("falls back to the default mock update port when the configured port is blank", () => {
    assert.equal(resolveMockUpdateServerUrl(undefined), "http://localhost:3000");
    assert.equal(resolveMockUpdateServerUrl(4123), "http://localhost:4123");
  });

  it("derives the electron-builder package manager user agent from packageManager", () => {
    assert.equal(resolvePackageManagerUserAgent("pnpm@11.10.0"), "pnpm/11.10.0");
    assert.equal(resolvePackageManagerUserAgent(" yarn@4.9.2 "), "yarn/4.9.2");
    assert.equal(resolvePackageManagerUserAgent("pnpm"), "pnpm");
  });

  it.effect("normalizes mock update server ports from env-style strings", () =>
    Effect.gen(function* () {
      assert.equal(yield* resolveMockUpdateServerPort(undefined), undefined);
      assert.equal(yield* resolveMockUpdateServerPort(""), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("   "), undefined);
      assert.equal(yield* resolveMockUpdateServerPort("4123"), 4123);
    }),
  );

  it.effect("rejects non-numeric or out-of-range mock update ports", () =>
    Effect.gen(function* () {
      const invalidPorts = ["abc", "12.5", "0", "65536"];

      for (const port of invalidPorts) {
        const exit = yield* Effect.exit(resolveMockUpdateServerPort(port));
        assert.equal(exit._tag, "Failure");
      }
    }),
  );

  it("classifies invalid configured ports with the decoder's number grammar", () => {
    const cause = new Error("invalid configured port");

    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).reason,
      "not-numeric",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("12.5", cause).reason,
      "not-integer",
    );
    assert.equal(
      InvalidMockUpdateServerPortError.fromConfigValue("65536", cause).reason,
      "out-of-range",
    );
    assert.strictEqual(
      InvalidMockUpdateServerPortError.fromConfigValue("0x10", cause).cause,
      cause,
    );
  });

  it.effect("resolves default platform and architecture from host references", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.none(),
        target: Option.none(),
        arch: Option.none(),
        buildVersion: Option.none(),
        outputDir: Option.none(),
        skipBuild: Option.none(),
        keepStage: Option.none(),
        signed: Option.none(),
        verbose: Option.none(),
        mockUpdates: Option.none(),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(HostProcessPlatform, "win32"),
            Layer.succeed(HostProcessArchitecture, "x64"),
            ConfigProvider.layer(
              ConfigProvider.fromEnv({
                env: {
                  PROCESSOR_ARCHITECTURE: "AMD64",
                  PROCESSOR_ARCHITEW6432: "ARM64",
                },
              }),
            ),
          ),
        ),
      );

      assert.equal(resolved.platform, "win");
      assert.equal(resolved.target, "nsis");
      assert.equal(resolved.arch, "arm64");
    }),
  );

  it.effect("preserves explicit false boolean flags over true env defaults", () =>
    Effect.gen(function* () {
      const resolved = yield* resolveBuildOptions({
        platform: Option.some("mac"),
        target: Option.none(),
        arch: Option.some("arm64"),
        buildVersion: Option.none(),
        outputDir: Option.some("release-test"),
        skipBuild: Option.some(false),
        keepStage: Option.some(false),
        signed: Option.some(false),
        verbose: Option.some(false),
        mockUpdates: Option.some(false),
        mockUpdateServerPort: Option.none(),
        wslPrebuild: Option.none(),
      }).pipe(
        Effect.provide(
          ConfigProvider.layer(
            ConfigProvider.fromEnv({
              env: {
                T3CODE_DESKTOP_SKIP_BUILD: "true",
                T3CODE_DESKTOP_KEEP_STAGE: "true",
                T3CODE_DESKTOP_SIGNED: "true",
                T3CODE_DESKTOP_VERBOSE: "true",
                T3CODE_DESKTOP_MOCK_UPDATES: "true",
              },
            }),
          ),
        ),
      );

      assert.equal(resolved.skipBuild, false);
      assert.equal(resolved.keepStage, false);
      assert.equal(resolved.signed, false);
      assert.equal(resolved.verbose, false);
      assert.equal(resolved.mockUpdates, false);
    }),
  );
});

import * as NodeServices from "@effect/platform-node/NodeServices";
