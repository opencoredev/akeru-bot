import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as SynchronizedRef from "effect/SynchronizedRef";

import * as DesktopBackendManager from "./DesktopBackendManager.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopWslServerTree from "../wsl/DesktopWslServerTree.ts";
import {
  type SharedBootstrapInput,
  buildObservabilityFragment,
  backendChildEnvPatch,
  readPersistedBackendObservabilitySettings,
  resolveResourceMonitorPath,
} from "./BackendBootstrapConfig.ts";
import { resolveWslStartConfig } from "./WslStartConfiguration.ts";

export { DesktopBackendObservabilitySettingsReadError } from "./BackendBootstrapConfig.ts";

export class DesktopBackendConfiguration extends Context.Service<
  DesktopBackendConfiguration,
  {
    // Build the Windows-native primary backend's start config. Reads the
    // primary's port/host/exposure from DesktopServerExposure. Can fail
    // with PlatformError because bootstrap token generation now uses
    // crypto.randomBytes under the hood (post Effect 4 migration).
    readonly resolvePrimary: Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    // Build a WSL backend start config for the given distro on the given
    // port. The WSL backend is always loopback-only (the primary owns LAN
    // exposure when the user opts in), so this takes the port directly and
    // hardcodes 127.0.0.1. Distro=null means "WSL default distro" and is
    // forwarded to wsl.exe with no -d flag.
    readonly resolveWsl: (input: {
      readonly port: number;
      readonly distro: string | null;
    }) => Effect.Effect<
      DesktopBackendManager.DesktopBackendStartConfig,
      PlatformError.PlatformError
    >;
    // The renderer-facing label for the primary instance, derived from the
    // same decision resolvePrimary makes (including the WSL-availability
    // fall-back to Windows), so the env switcher can't show "WSL" for a
    // backend that actually resolved to Windows.
    readonly resolvePrimaryLabel: Effect.Effect<string>;
  }
>()("@akeru/desktop/backend/DesktopBackendConfiguration") {}

const resolvePrimaryStartConfig = Effect.fn("desktop.backendConfiguration.resolvePrimary")(
  function* (
    input: SharedBootstrapInput & {
      readonly resourceMonitorPath: Option.Option<string>;
    },
  ): Effect.fn.Return<
    DesktopBackendManager.DesktopBackendStartConfig,
    never,
    DesktopEnvironment.DesktopEnvironment | DesktopServerExposure.DesktopServerExposure
  > {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
    const backendExposure = yield* serverExposure.backendConfig;

    const bootstrap = {
      mode: "desktop" as const,
      noBrowser: true,
      port: backendExposure.port,
      t3Home: environment.baseDir,
      host: backendExposure.bindHost,
      desktopBootstrapToken: input.bootstrapToken,
      tailscaleServeEnabled: backendExposure.tailscaleServeEnabled,
      tailscaleServePort: backendExposure.tailscaleServePort,
      desktopTelemetryFd: 4,
      desktopTelemetryControlFd: 5,
      ...Option.match(input.resourceMonitorPath, {
        onNone: () => ({}),
        onSome: (resourceMonitorPath) => ({ resourceMonitorPath }),
      }),
      ...buildObservabilityFragment(input.observabilitySettings),
    };

    return {
      executablePath: process.execPath,
      args: [environment.backendEntryPath, "--bootstrap-fd", "3"],
      entryPath: environment.backendEntryPath,
      cwd: environment.backendCwd,
      env: {
        ...backendChildEnvPatch(),
        ELECTRON_RUN_AS_NODE: "1",
      },
      // Primary wants process.env (PATH, dev-runner's T3CODE_HOME, etc.).
      extendEnv: true,
      bootstrap,
      bootstrapDelivery: "fd3",
      httpBaseUrl: backendExposure.httpBaseUrl,
      captureOutput: true,
      preflightFailure: Option.none(),
    } satisfies DesktopBackendManager.DesktopBackendStartConfig;
  },
);

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const wslEnvironment = yield* DesktopWslEnvironment.DesktopWslEnvironment;
  const wslServerTree = yield* DesktopWslServerTree.DesktopWslServerTree;
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const crypto = yield* Crypto.Crypto;
  // SynchronizedRef (not a plain Ref) so the read-generate-write is atomic.
  // crypto.randomBytes is a yield point, and resolvePrimary + resolveWsl can
  // resolve concurrently; with a plain Ref both could observe None, generate
  // distinct tokens, and one would overwrite the other — leaving the two
  // backends holding mismatched tokens and breaking the shared-token
  // invariant the renderer relies on. modifyEffect serializes the whole
  // get-or-create so the first caller wins and the rest reuse its token.
  const tokenRef = yield* SynchronizedRef.make(Option.none<string>());

  const getOrCreateBootstrapToken = SynchronizedRef.modifyEffect(tokenRef, (current) =>
    Option.match(current, {
      onSome: (token) => Effect.succeed([token, current] as const),
      onNone: () =>
        crypto.randomBytes(24).pipe(
          Effect.map((bytes) => {
            const token = Encoding.encodeHex(bytes);

            return [token, Option.some(token)] as const;
          }),
        ),
    }),
  );

  // Both resolvers share the same bootstrap token: the renderer holds a
  // single token and uses it against whichever backend it's currently
  // talking to. Observability settings get re-read each resolve so a
  // hot-swap of the server-settings file is picked up on the next
  // restart cycle without having to bounce the desktop process.
  const sharedInputs = Effect.gen(function* () {
    const bootstrapToken = yield* getOrCreateBootstrapToken;

    const observabilitySettings = yield* readPersistedBackendObservabilitySettings.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );

    return { bootstrapToken, observabilitySettings } satisfies SharedBootstrapInput;
  });

  const buildWslPrimaryConfig = Effect.gen(function* () {
    // wsl-only mode pipes the WSL backend through the same port the
    // Windows primary would normally take. That way the renderer
    // still loads from the local-only endpoint advertised by
    // DesktopServerExposure, and primary-aware code paths (cookie
    // auth, the env switcher's "primary" id) keep working without
    // a parallel "secondary" registration.
    const backendExposure = yield* serverExposure.backendConfig;
    const persistedSettings = yield* settings.get;
    const shared = yield* sharedInputs;
    yield* wslEnvironment.preWarm(persistedSettings.wslDistro);

    return yield* resolveWslStartConfig({
      ...shared,
      port: backendExposure.port,
      distro: persistedSettings.wslDistro,
    }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
      Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });

  const buildWindowsPrimaryConfig = Effect.gen(function* () {
    const shared = yield* sharedInputs;

    const resourceMonitorPath = yield* resolveResourceMonitorPath().pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
    );

    return yield* resolvePrimaryStartConfig({ ...shared, resourceMonitorPath }).pipe(
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
      Effect.provideService(DesktopServerExposure.DesktopServerExposure, serverExposure),
    );
  });

  // Single source of truth for what the primary actually runs as. Both
  // the start-config dispatch and the renderer-facing label derive from
  // this, so they can't disagree — e.g. the label reading "WSL" while the
  // config silently fell back to Windows because WSL is unavailable.
  // Dispatch happens at resolve time so toggling wsl-only between restarts
  // is picked up on the next start cycle (the pool's primary instance is
  // created once at layer init, but configResolve fires on each restart).
  const describePrimary = Effect.gen(function* () {
    const persistedSettings = yield* settings.get;
    const wslRequested = persistedSettings.wslOnly && persistedSettings.wslBackendEnabled;
    // Only honor wsl-only when WSL is actually usable. If the user
    // persisted wsl-only but WSL has since become unavailable (wsl.exe
    // removed, no distro), fall back to the Windows primary instead of
    // looping forever on preflight failures: the Connections backend
    // control is hidden while WSL is unavailable, so a stuck WSL primary
    // would otherwise leave no in-app way back to Windows.
    const useWsl = wslRequested && (yield* wslEnvironment.isAvailable);

    return { useWsl, wslRequested, distro: persistedSettings.wslDistro };
  });

  return DesktopBackendConfiguration.of({
    resolvePrimary: Effect.gen(function* () {
      const { useWsl, wslRequested } = yield* describePrimary;

      if (useWsl) {
        return yield* buildWslPrimaryConfig;
      }

      if (wslRequested) {
        yield* Effect.logWarning(
          "WSL-only backend requested but WSL is unavailable; starting the Windows primary instead.",
        );
      }

      return yield* buildWindowsPrimaryConfig;
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimary")),
    resolvePrimaryLabel: Effect.gen(function* () {
      const { useWsl, distro } = yield* describePrimary;

      if (!useWsl) {
        return environment.platform === "win32" ? "Windows" : "Local environment";
      }

      return distro ? `WSL (${distro})` : "WSL";
    }).pipe(Effect.withSpan("desktop.backendConfiguration.resolvePrimaryLabel")),
    resolveWsl: (input) =>
      Effect.gen(function* () {
        const shared = yield* sharedInputs;

        return yield* resolveWslStartConfig({ ...shared, ...input }).pipe(
          Effect.provideService(DesktopEnvironment.DesktopEnvironment, environment),
          Effect.provideService(DesktopWslEnvironment.DesktopWslEnvironment, wslEnvironment),
          Effect.provideService(DesktopWslServerTree.DesktopWslServerTree, wslServerTree),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        );
      }).pipe(
        Effect.withSpan("desktop.backendConfiguration.resolveWsl", {
          attributes: { port: input.port, distro: input.distro ?? null },
        }),
      ),
  });
});

export const layer = Layer.effect(DesktopBackendConfiguration, make);
