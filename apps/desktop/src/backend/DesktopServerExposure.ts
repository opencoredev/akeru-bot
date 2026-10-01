import {
  type AdvertisedEndpoint,
  type DesktopServerExposureMode,
  type DesktopServerExposureState,
} from "@akeru/contracts";
import { readTailscaleStatus } from "@akeru/tailscale";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopNetworkInterfaces from "./DesktopNetworkInterfaces.ts";
import { resolveTailscaleAdvertisedEndpoints } from "./tailscaleEndpointProvider.ts";
import {
  type DesktopServerExposureBackendConfig,
  type DesktopServerExposureChange,
  initialRuntimeState,
  toContractState,
  toBackendConfig,
  resolveRuntimeState,
  requiresBackendRelaunch,
  resolveDesktopCoreAdvertisedEndpoints,
  toResolvedExposure,
} from "./ServerExposurePolicy.ts";
import {
  type DesktopServerExposureSetModeError,
  DesktopTailscaleServePersistenceError,
  DesktopServerExposureNoNetworkAddressError,
  DesktopServerExposureModePersistenceError,
} from "./ServerExposureErrors.ts";

export { DESKTOP_LOOPBACK_HOST } from "./ServerExposurePolicy.ts";

export type { DesktopServerExposureBackendConfig } from "./ServerExposurePolicy.ts";

export type { DesktopServerExposureChange } from "./ServerExposurePolicy.ts";

export { DesktopServerExposureNoNetworkAddressError } from "./ServerExposureErrors.ts";

export { DesktopServerExposureModePersistenceError } from "./ServerExposureErrors.ts";

export { DesktopTailscaleServePersistenceError } from "./ServerExposureErrors.ts";

export { DesktopServerExposureSetModeError } from "./ServerExposureErrors.ts";

export { isDesktopServerExposureSetModeError } from "./ServerExposureErrors.ts";

export { DesktopServerExposureError } from "./ServerExposureErrors.ts";

export { isDesktopServerExposureError } from "./ServerExposureErrors.ts";

const TAILSCALE_STATUS_CACHE_TTL = Duration.seconds(60);

export class DesktopServerExposure extends Context.Service<
  DesktopServerExposure,
  {
    readonly getState: Effect.Effect<DesktopServerExposureState>;
    readonly backendConfig: Effect.Effect<DesktopServerExposureBackendConfig>;
    readonly configureFromSettings: (input: {
      readonly port: number;
    }) => Effect.Effect<DesktopServerExposureState>;
    readonly setMode: (
      mode: DesktopServerExposureMode,
    ) => Effect.Effect<DesktopServerExposureChange, DesktopServerExposureSetModeError>;
    readonly setTailscaleServeEnabled: (input: {
      readonly enabled: boolean;
      readonly port?: number;
    }) => Effect.Effect<DesktopServerExposureChange, DesktopTailscaleServePersistenceError>;
    readonly getAdvertisedEndpoints: Effect.Effect<readonly AdvertisedEndpoint[]>;
  }
>()("@akeru/desktop/backend/DesktopServerExposure") {}

export const make = Effect.gen(function* () {
  const config = yield* DesktopConfig.DesktopConfig;
  const networkInterfaces = yield* DesktopNetworkInterfaces.DesktopNetworkInterfaces;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const httpClient = yield* HttpClient.HttpClient;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  const stateRef = yield* Ref.make(initialRuntimeState());

  // Cache the `tailscale status` spawn for the TTL. On macOS, the Mac App
  // Store Tailscale CLI lives inside Tailscale's sandbox container, so each
  // spawn re-triggers the "Other apps" TCC prompt.
  const cachedReadMagicDnsName = yield* Effect.cachedWithTTL(
    readTailscaleStatus.pipe(
      Effect.map((status) => status.magicDnsName),
      Effect.orElseSucceed(() => null),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
    ),
    TAILSCALE_STATUS_CACHE_TTL,
  );

  const readNetworkInterfaces = networkInterfaces.read;

  const getState = Ref.get(stateRef).pipe(Effect.map(toContractState));
  const backendConfig = Ref.get(stateRef).pipe(Effect.map(toBackendConfig));

  const configureFromSettings = Effect.fn("desktop.serverExposure.configureFromSettings")(
    function* ({ port }: { readonly port: number }) {
      yield* Effect.annotateCurrentSpan({ port });
      const settings = yield* desktopSettings.get;
      const currentNetworkInterfaces = yield* readNetworkInterfaces;

      const resolved = resolveRuntimeState({
        requestedMode: settings.serverExposureMode,
        settings,
        port,
        networkInterfaces: currentNetworkInterfaces,
        advertisedHostOverride: config.desktopLanHostOverride,
      });

      yield* Ref.set(stateRef, resolved.state);

      return toContractState(resolved.state);
    },
  );

  const setMode = Effect.fn("desktop.serverExposure.setMode")(function* (
    mode: DesktopServerExposureMode,
  ) {
    yield* Effect.annotateCurrentSpan({ mode });
    const previous = yield* Ref.get(stateRef);
    const currentSettings = yield* desktopSettings.get;

    const nextSettings = {
      ...currentSettings,
      serverExposureMode: mode,
    };

    const currentNetworkInterfaces = yield* readNetworkInterfaces;

    const resolved = resolveRuntimeState({
      requestedMode: mode,
      settings: nextSettings,
      port: previous.port,
      networkInterfaces: currentNetworkInterfaces,
      advertisedHostOverride: config.desktopLanHostOverride,
    });

    if (resolved.unavailable) {
      return yield* new DesktopServerExposureNoNetworkAddressError({ port: previous.port });
    }

    const change = yield* desktopSettings.setServerExposureMode(mode).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopServerExposureModePersistenceError({
            mode,
            cause,
          }),
      ),
    );

    yield* Ref.set(stateRef, resolved.state);

    return {
      state: toContractState(resolved.state),
      requiresRelaunch: change.changed || requiresBackendRelaunch(previous, resolved.state),
    };
  });

  const setTailscaleServeEnabled = Effect.fn("desktop.serverExposure.setTailscaleServeEnabled")(
    function* (input: { readonly enabled: boolean; readonly port?: number }) {
      yield* Effect.annotateCurrentSpan({
        enabled: input.enabled,
        ...(input.port === undefined ? {} : { port: input.port }),
      });

      const result = yield* desktopSettings
        .setTailscaleServe({
          enabled: input.enabled,
          port: Option.fromNullishOr(input.port),
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new DesktopTailscaleServePersistenceError({
                enabled: input.enabled,
                port: input.port ?? null,
                cause,
              }),
          ),
        );

      const nextState = yield* Ref.updateAndGet(stateRef, (current) => ({
        ...current,
        tailscaleServeEnabled: result.settings.tailscaleServeEnabled,
        tailscaleServePort: result.settings.tailscaleServePort,
      }));

      return {
        state: toContractState(nextState),
        requiresRelaunch: result.changed,
      };
    },
  );

  const getAdvertisedEndpoints = Effect.gen(function* () {
    const state = yield* Ref.get(stateRef);
    const currentNetworkInterfaces = yield* readNetworkInterfaces;

    const coreEndpoints = resolveDesktopCoreAdvertisedEndpoints({
      port: state.port,
      exposure: toResolvedExposure(state),
      customHttpsEndpointUrls: config.desktopHttpsEndpointUrls,
    });

    // Don't spawn the Tailscale CLI when the user hasn't opted into any
    // network exposure. The spawn itself triggers a macOS "Other apps"
    // TCC prompt on Mac App Store Tailscale builds.
    if (state.mode !== "network-accessible" && !state.tailscaleServeEnabled) {
      return coreEndpoints;
    }

    const tailscaleEndpoints = yield* resolveTailscaleAdvertisedEndpoints({
      port: state.port,
      serveEnabled: state.tailscaleServeEnabled,
      servePort: state.tailscaleServePort,
      networkInterfaces: currentNetworkInterfaces,
      readMagicDnsName: cachedReadMagicDnsName,
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
    );

    return [...coreEndpoints, ...tailscaleEndpoints];
  }).pipe(Effect.withSpan("desktop.serverExposure.getAdvertisedEndpoints"));

  return DesktopServerExposure.of({
    getState,
    backendConfig,
    configureFromSettings,
    setMode,
    setTailscaleServeEnabled,
    getAdvertisedEndpoints,
  });
});

export const layer = Layer.effect(DesktopServerExposure, make);
