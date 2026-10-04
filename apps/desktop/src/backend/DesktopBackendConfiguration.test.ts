import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Logger from "effect/Logger";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

import {
  encodePersistedServerObservabilitySettingsDocument,
  isDesktopBackendObservabilitySettingsReadError,
  serverExposureLayer,
  makeEnvironmentLayer,
  withHarness,
} from "./test-support/BackendConfigurationHarness.ts";

describe("DesktopBackendConfiguration", () => {
  it.effect("resolvePrimary produces a stable scoped bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const first = yield* configuration.resolvePrimary;
        const second = yield* configuration.resolvePrimary;

        assert.equal(first.executablePath, process.execPath);
        assert.equal(first.entryPath, environment.backendEntryPath);
        assert.equal(first.cwd, environment.backendCwd);
        assert.equal(first.captureOutput, true);
        assert.equal(first.env.ELECTRON_RUN_AS_NODE, "1");
        assert.isUndefined(first.env.T3CODE_PORT);
        assert.isUndefined(first.env.T3CODE_MODE);
        assert.isUndefined(first.env.T3CODE_DESKTOP_LAN_HOST);

        assert.equal(first.bootstrap.mode, "desktop");
        assert.equal(first.bootstrap.noBrowser, true);
        assert.equal(first.bootstrap.port, 4888);
        assert.equal(first.bootstrap.host, "0.0.0.0");
        assert.equal(first.bootstrap.t3Home, environment.baseDir);
        assert.equal(first.bootstrap.tailscaleServeEnabled, true);
        assert.equal(first.bootstrap.tailscaleServePort, 8443);
        assert.match(first.bootstrap.desktopBootstrapToken, /^[0-9a-f]{48}$/i);
        assert.equal(second.bootstrap.desktopBootstrapToken, first.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolveWsl reuses the primary's bootstrap token", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        const primary = yield* configuration.resolvePrimary;
        const wsl = yield* configuration.resolveWsl({ port: 5000, distro: null });

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect(
    "resolveWsl preserves inherited PATH with quote-sensitive values as separate args",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        const entryPath = path.join(baseDir, "apps/server/dist/bin.mjs");
        yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
        yield* fileSystem.writeFileString(entryPath, "");

        const nodePath = "/home/test user's/.nvm/versions/node/v22.0.0/bin/node";
        const linuxEntryPath = "/tmp/t3 code's launch/entry file.mjs";
        const resolvedPath = "/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin";
        const devServerUrl = "http://127.0.0.1:5733/dev%20assets/?label=hello%20world";

        const config = yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

          return yield* configuration.resolveWsl({ port: 5000, distro: "Ubuntu" });
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                  windowsToWslPath: () => Option.some(linuxEntryPath),
                  ensureNodePty: () => ({ ok: true, nodePath, resolvedPath }),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(
                makeEnvironmentLayer(baseDir, {
                  appPath: baseDir,
                  devServerUrl,
                  isPackaged: true,
                  platform: "win32",
                  resourcesPath: baseDir,
                }),
              ),
            ),
          ),
        );

        assert.equal(config.bootstrapDelivery, "stdin");
        assert.deepEqual(config.args, [
          "-d",
          "Ubuntu",
          "--exec",
          "env",
          "PATH=/home/test user's/.nvm/versions/node/v22.0.0/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/home/test user/bin:/opt/test's tools/bin:/usr/bin:/bin",
          nodePath,
          linuxEntryPath,
          "--bootstrap-fd",
          "0",
          "--dev-url",
          devServerUrl,
        ]);
        assert.notInclude(config.args, "bash");
        assert.notInclude(config.args, "/bin/sh");
        assert.notInclude(config.args, "-c");
        assert.isTrue(Option.isNone(config.preflightFailure));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary and resolveWsl share one token under concurrent resolution", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        // Resolve both before any token is cached, concurrently, so the
        // generate step (a yield point) can interleave. The atomic
        // get-or-create must still hand both the same token; a non-atomic
        // Ref would let each generate its own and break the shared-token
        // invariant.
        const [primary, wsl] = yield* Effect.all(
          [configuration.resolvePrimary, configuration.resolveWsl({ port: 5000, distro: null })],
          { concurrency: "unbounded" },
        );

        assert.equal(wsl.bootstrap.desktopBootstrapToken, primary.bootstrap.desktopBootstrapToken);
      }),
    ),
  );

  it.effect("resolvePrimary surfaces persisted backend observability endpoints", () =>
    withHarness(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        yield* fileSystem.makeDirectory(environment.path.dirname(environment.serverSettingsPath), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          environment.serverSettingsPath,
          yield* encodePersistedServerObservabilitySettingsDocument({
            observability: {
              otlpTracesUrl: " http://127.0.0.1:4318/v1/traces ",
              otlpMetricsUrl: " http://127.0.0.1:4318/v1/metrics ",
            },
          }),
        );

        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.otlpTracesUrl, "http://127.0.0.1:4318/v1/traces");
        assert.equal(config.bootstrap.otlpMetricsUrl, "http://127.0.0.1:4318/v1/metrics");
      }),
    ),
  );

  it.effect("resolvePrimary omits backend observability endpoints when settings are missing", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;

        assert.isUndefined(config.bootstrap.otlpTracesUrl);
        assert.isUndefined(config.bootstrap.otlpMetricsUrl);
      }),
    ),
  );

  it.effect("logs structured context when persisted observability settings cannot be read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const settingsPath = path.join(baseDir, "userdata", "settings.json");

      const cause = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: settingsPath,
      });

      const messages: Array<unknown> = [];

      const logger = Logger.make(({ message }) => {
        messages.push(message);
      });

      const failingFileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(cause),
        }),
      );

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest()),
              Layer.provideMerge(makeEnvironmentLayer(baseDir)),
              Layer.provideMerge(failingFileSystemLayer),
            ),
            Logger.layer([logger], { mergeWithExisting: false }),
          ),
        ),
      );

      assert.isUndefined(config.bootstrap.otlpTracesUrl);
      assert.isUndefined(config.bootstrap.otlpMetricsUrl);

      const error = messages
        .flatMap((message) => (Array.isArray(message) ? message : [message]))
        .find(isDesktopBackendObservabilitySettingsReadError);

      assert.isDefined(error);
      assert.equal(error.settingsPath, settingsPath);
      assert.equal(error.cause, cause);
      assert.equal(
        error.message,
        `Failed to read persisted backend observability settings at ${settingsPath}.`,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimary captures backend output in dev so child logs can be persisted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.captureOutput, true);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                isPackaged: false,
                devServerUrl: "http://127.0.0.1:5733",
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolvePrimary falls back to the Windows primary when wsl-only but WSL is unavailable",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        yield* Effect.gen(function* () {
          const environment = yield* DesktopEnvironment.DesktopEnvironment;
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolvePrimary;

          // wsl-only is persisted but WSL is unavailable, so the primary must
          // not spawn wsl.exe (which would loop on preflight failures while the
          // Connections backend control is hidden). Resolve the Windows primary.
          assert.equal(config.executablePath, process.execPath);
          assert.equal(config.bootstrap.t3Home, environment.baseDir);
          assert.isTrue(Option.isNone(config.preflightFailure));
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                }),
              ),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: false })),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "resolvePrimary marks a removed persisted WSL distro as a fatal preflight failure",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;

        const baseDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-desktop-backend-config-test-",
        });

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolvePrimary;
          const failure = Option.getOrThrow(config.preflightFailure);

          assert.equal(config.executablePath, "wsl.exe");
          assert.isTrue(failure.fatal);
          assert.include(failure.reason, "Removed-Distro");
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(
                DesktopAppSettings.layerTest({
                  ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                  wslBackendEnabled: true,
                  wslOnly: true,
                  wslDistro: "Removed-Distro",
                }),
              ),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl marks a missing packaged server entry as fatal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "missing server entry");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [{ name: "Ubuntu", isDefault: true, version: 2 }],
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the external packaged resource monitor over the copy inside the asar", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const resourcesPath = `${baseDir}/resources`;
      const dirname = `${resourcesPath}/app.asar/apps/desktop/dist-electron`;
      const embeddedMonitorPath = `${resourcesPath}/app.asar/apps/desktop/prod-resources/resource-monitor/t3-resource-monitor`;
      const monitorPath = `${resourcesPath}/resource-monitor/t3-resource-monitor`;
      yield* fileSystem.makeDirectory(
        `${resourcesPath}/app.asar/apps/desktop/prod-resources/resource-monitor`,
        { recursive: true },
      );
      yield* fileSystem.makeDirectory(`${resourcesPath}/resource-monitor`, {
        recursive: true,
      });
      yield* fileSystem.writeFileString(embeddedMonitorPath, "embedded");
      yield* fileSystem.writeFileString(monitorPath, "binary");
      yield* fileSystem.chmod(monitorPath, 0o755);

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.resourceMonitorPath, monitorPath);
        assert.equal(config.bootstrap.desktopTelemetryFd, 4);
        assert.equal(config.bootstrap.desktopTelemetryControlFd, 5);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                dirname,
                isPackaged: true,
                resourcesPath,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("prefers the release resource monitor when both development builds exist", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const dirname = path.join(baseDir, "apps/desktop/src");

      const releaseMonitorPath = path.join(
        baseDir,
        "native/resource-monitor/target/release/t3-resource-monitor",
      );

      const debugMonitorPath = path.join(
        baseDir,
        "native/resource-monitor/target/debug/t3-resource-monitor",
      );

      yield* fileSystem.makeDirectory(path.dirname(releaseMonitorPath), { recursive: true });
      yield* fileSystem.makeDirectory(path.dirname(debugMonitorPath), { recursive: true });
      yield* fileSystem.writeFileString(releaseMonitorPath, "release");
      yield* fileSystem.writeFileString(debugMonitorPath, "debug");

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolvePrimary;
        assert.equal(config.bootstrap.resourceMonitorPath, releaseMonitorPath);
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                dirname,
                devServerUrl: "http://127.0.0.1:5733",
                isPackaged: false,
              }),
            ),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports the local environment on non-Windows platforms", () =>
    withHarness(
      Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Local environment");
      }),
    ),
  );
});
