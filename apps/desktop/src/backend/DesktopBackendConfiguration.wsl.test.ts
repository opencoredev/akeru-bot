import * as Predicate from "effect/Predicate";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as ManagedRuntime from "effect/ManagedRuntime";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendConfiguration from "./DesktopBackendConfiguration.ts";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";

import {
  serverExposureLayer,
  makeEnvironmentLayer,
  restoreEnv,
} from "./test-support/BackendConfigurationHarness.ts";

describe("DesktopBackendConfiguration", () => {
  it.effect("resolvePrimary starts from server.asar without materializing the WSL tree", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const resourcesPath = `${baseDir}/resources`;

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        return yield* configuration.resolvePrimary;
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest()),
            Layer.provideMerge(
              Layer.succeed(
                DesktopWslServerTree.DesktopWslServerTree,
                DesktopWslServerTree.DesktopWslServerTree.of({
                  ensure: Effect.die("Windows primary must not extract the WSL server tree"),
                }),
              ),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: `${resourcesPath}/app.asar`,
                platform: "win32",
                resourcesPath,
              }),
            ),
          ),
        ),
      );

      assert.equal(config.entryPath, `${resourcesPath}/server.asar/apps/server/dist/bin.mjs`);
      assert.equal(config.env.ELECTRON_RUN_AS_NODE, "1");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl pins a default-tracking run to the concrete default distro", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const entryPath = path.join(baseDir, "apps/server/dist/bin.mjs");
      yield* fileSystem.makeDirectory(path.dirname(entryPath), { recursive: true });
      yield* fileSystem.writeFileString(entryPath, "");

      const observedDistros: Array<string | null> = [];

      const config = yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;

        return yield* configuration.resolveWsl({ port: 5000, distro: null });
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distros: [
                  { name: "Debian", isDefault: false, version: 2 },
                  { name: "Ubuntu", isDefault: true, version: 2 },
                ],
                windowsToWslPath: (distro) => {
                  observedDistros.push(distro);

                  return Option.some("/repo/apps/server/dist/bin.mjs");
                },
                ensureNodePty: (distro) => {
                  observedDistros.push(distro);

                  return { ok: true, nodePath: "/usr/bin/node", resolvedPath: "/usr/bin:/bin" };
                },
                getDistroIp: (distro) => {
                  observedDistros.push(distro);

                  return Option.some("172.27.0.99");
                },
              }),
            ),
            Layer.provideMerge(
              makeEnvironmentLayer(baseDir, {
                appPath: baseDir,
                platform: "win32",
                resourcesPath: baseDir,
              }),
            ),
          ),
        ),
      );

      assert.equal(config.runningDistro, "Ubuntu");
      assert.deepEqual(config.args.slice(0, 2), ["-d", "Ubuntu"]);
      assert.deepEqual(observedDistros, ["Ubuntu", "Ubuntu", "Ubuntu"]);
      assert.isTrue(Option.isNone(config.preflightFailure));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl preserves existing WSLENV entries when forwarding backend secrets", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      const previousWslEnv = process.env.WSLENV;
      const previousOpenAiKey = process.env.OPENAI_API_KEY;
      const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;

      try {
        process.env.WSLENV = "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u";
        process.env.OPENAI_API_KEY = "openai-key";
        process.env.ANTHROPIC_API_KEY = "anthropic-key";

        yield* Effect.gen(function* () {
          const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
          const config = yield* configuration.resolveWsl({ port: 5050, distro: null });

          assert.equal(config.executablePath, "wsl.exe");
          assert.equal(config.bootstrap.port, 5050);
          // Binds to 0.0.0.0 inside WSL so the backend is reachable via
          // both wslhost-forwarded localhost and the distro's eth0 IP.
          assert.equal(config.bootstrap.host, "0.0.0.0");
          assert.equal(config.bootstrap.tailscaleServeEnabled, false);
          assert.notProperty(config.bootstrap, "desktopTelemetryFd");
          assert.notProperty(config.bootstrap, "resourceMonitorPath");
          // httpBaseUrl uses the resolved distro IP from the test stub,
          // not localhost — the renderer reaches the backend directly to
          // avoid relying on wslhost forwarding.
          assert.equal(config.httpBaseUrl.href, "http://172.27.0.99:5050/");
          assert.equal(config.env.OPENAI_API_KEY, "openai-key");
          assert.equal(config.env.ANTHROPIC_API_KEY, "anthropic-key");
          // The existing WSLENV is preserved byte-for-byte (note the empty
          // "::" segment survives — WSL ignores it, so we don't normalize
          // it away) and ANTHROPIC_API_KEY is appended. OPENAI_API_KEY is
          // already declared, so it isn't forwarded twice.
          assert.equal(
            config.env.WSLENV,
            "GOPATH/p:OPENAI_API_KEY/u:EMPTY::AZURE_DEVOPS_EXT_PAT/u:ANTHROPIC_API_KEY",
          );
        }).pipe(
          Effect.provide(
            DesktopBackendConfiguration.layer.pipe(
              Layer.provideMerge(serverExposureLayer),
              Layer.provideMerge(DesktopAppSettings.layerTest()),
              Layer.provideMerge(DesktopWslServerTree.layerTest()),
              Layer.provideMerge(
                DesktopWslEnvironment.layerTest({
                  isAvailable: true,
                  windowsToWslPath: () => Option.some("/mnt/c/repo/apps/server/src/index.ts"),
                  getDistroIp: () => Option.some("172.27.0.99"),
                }),
              ),
              Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
            ),
          ),
        );
      } finally {
        restoreEnv("WSLENV", previousWslEnv);
        restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
        restoreEnv("ANTHROPIC_API_KEY", previousAnthropicKey);
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl keeps a transient distro-list failure retryable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "timed out");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(
              DesktopWslEnvironment.layerTest({
                isAvailable: true,
                distroListError: new DesktopWslEnvironment.DesktopWslDistroListError({
                  reason: "wsl.exe --list --verbose timed out",
                }),
              }),
            ),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolveWsl surfaces sidecar extraction failures through typed preflight", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Ubuntu" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isFalse(failure.fatal);
        assert.equal(failure.retryLimit, 12);
        assert.include(failure.reason, "could not be extracted");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(DesktopAppSettings.layerTest()),
            Layer.provideMerge(
              DesktopWslServerTree.layerTest({
                result: {
                  ok: false,
                  reason: "WSL server files could not be extracted",
                  fatal: false,
                },
              }),
            ),
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

  it.effect("resolveWsl marks a missing selected distro as a fatal preflight failure", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const config = yield* configuration.resolveWsl({ port: 5050, distro: "Removed-Distro" });
        const failure = Option.getOrThrow(config.preflightFailure);

        assert.isTrue(failure.fatal);
        assert.include(failure.reason, "Removed-Distro");
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

  it.effect("resolvePrimaryLabel reports the WSL distro when wsl-only and WSL is available", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "WSL (Ubuntu)");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
              }),
            ),
            Layer.provideMerge(DesktopWslServerTree.layerTest()),
            Layer.provideMerge(DesktopWslEnvironment.layerTest({ isAvailable: true })),
            Layer.provideMerge(makeEnvironmentLayer(baseDir, { platform: "win32" })),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("resolvePrimaryLabel reports Windows when wsl-only but WSL is unavailable", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      const baseDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-backend-config-test-",
      });

      yield* Effect.gen(function* () {
        const configuration = yield* DesktopBackendConfiguration.DesktopBackendConfiguration;
        // Mirrors the resolvePrimary fall-back: the label must follow the
        // backend that actually resolves, not the persisted preference, so the
        // env switcher can't show "WSL" for a Windows backend.
        const label = yield* configuration.resolvePrimaryLabel;
        assert.equal(label, "Windows");
      }).pipe(
        Effect.provide(
          DesktopBackendConfiguration.layer.pipe(
            Layer.provideMerge(serverExposureLayer),
            Layer.provideMerge(
              DesktopAppSettings.layerTest({
                ...DesktopAppSettings.DEFAULT_DESKTOP_SETTINGS,
                wslBackendEnabled: true,
                wslOnly: true,
                wslDistro: "Ubuntu",
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

  it("resolvePrimaryLabel is runSync-safe against the real WSL availability probe", async () => {
    // getLocalEnvironmentBootstraps is a sync IPC method: it resolves the
    // primary instance's lazy label through Effect.runSync. The label chains
    // to wslEnvironment.isAvailable, whose real layer probes the filesystem.
    // That probe must run once at layer build and expose a resolved value, not
    // a live async effect — otherwise runSync throws in the handler. Build the
    // real WSL layer (not the sync test stub) and resolve the label with a
    // top-level runSync, exactly as the handler does.
    // oxlint-disable-next-line akeru/no-manual-effect-runtime-in-tests -- This test intentionally replicates the sync IPC handler's runSync path to catch a regression to async-only resolution; it.effect would mask it.
    const runtime = ManagedRuntime.make(
      DesktopBackendConfiguration.layer.pipe(
        Layer.provideMerge(serverExposureLayer),
        Layer.provideMerge(DesktopAppSettings.layerTest()),
        Layer.provideMerge(DesktopWslServerTree.layerTest()),
        Layer.provideMerge(DesktopWslEnvironment.layer),
        // isAvailable on win32 only touches the filesystem, never the spawner,
        // so a die-stub is enough to satisfy the layer's deps.
        Layer.provideMerge(
          Layer.succeed(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.die("spawner should not be used while probing WSL availability"),
            ),
          ),
        ),
        Layer.provideMerge(makeEnvironmentLayer("/tmp/t3-wsl-isavailable", { platform: "win32" })),
        Layer.provide(NodeServices.layer),
      ),
    );

    try {
      const configuration = await runtime.runPromise(
        DesktopBackendConfiguration.DesktopBackendConfiguration,
      );

      // oxlint-disable-next-line akeru/no-manual-effect-runtime-in-tests -- Same reason: this is the synchronous resolution the IPC handler performs.
      const label = Effect.runSync(configuration.resolvePrimaryLabel);
      assert.equal(Predicate.isString(label), true);
    } finally {
      await runtime.dispose();
    }
  });
});
