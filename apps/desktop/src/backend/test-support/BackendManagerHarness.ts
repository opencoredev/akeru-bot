import {
  DesktopBackendBootstrap,
  type DesktopBackendBootstrap as DesktopBackendBootstrapValue,
  DesktopTelemetryControlMessage,
} from "@akeru/contracts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as PlatformError from "effect/PlatformError";

import * as Schema from "effect/Schema";

import * as Sink from "effect/Sink";

import * as Stream from "effect/Stream";

import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import { ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopBackendManager from "../DesktopBackendManager.ts";

import * as DesktopObservability from "../../app/DesktopObservability.ts";

import * as DesktopTelemetryPublisher from "../../telemetry/DesktopTelemetryPublisher.ts";

export const decodeDesktopBackendBootstrap = Schema.decodeEffect(
  Schema.fromJsonString(DesktopBackendBootstrap),
);

export const isBackendProcessError = Schema.is(DesktopBackendManager.BackendProcessError);

export const encodeDesktopTelemetryControl = Schema.encodeSync(
  Schema.fromJsonString(DesktopTelemetryControlMessage),
);

export const baseConfig: DesktopBackendManager.DesktopBackendStartConfig = {
  executablePath: "/electron",
  args: ["/server/bin.mjs", "--bootstrap-fd", "3"],
  entryPath: "/server/bin.mjs",
  cwd: "/server",
  env: { ELECTRON_RUN_AS_NODE: "1" },
  bootstrap: {
    mode: "desktop",
    noBrowser: true,
    port: 3773,
    t3Home: "/tmp/t3",
    host: "127.0.0.1",
    desktopBootstrapToken: "token",
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    desktopTelemetryFd: 4,
    desktopTelemetryControlFd: 5,
  },
  bootstrapDelivery: "fd3",
  extendEnv: true,
  httpBaseUrl: new URL("http://127.0.0.1:3773"),
  captureOutput: true,
  preflightFailure: Option.none(),
};

export const configWithObservability: DesktopBackendBootstrapValue = {
  ...baseConfig.bootstrap,
  tailscaleServeEnabled: true,
  desktopTelemetryFd: 4,
  otlpTracesUrl: "http://127.0.0.1:4318/v1/traces",
};

export function makeProcess(options?: {
  readonly stdout?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly stderr?: Stream.Stream<Uint8Array, PlatformError.PlatformError>;
  readonly exitCode?: Effect.Effect<ChildProcessSpawner.ExitCode, PlatformError.PlatformError>;
  readonly kill?: ChildProcessSpawner.ChildProcessHandle["kill"];
  readonly getOutputFd?: ChildProcessSpawner.ChildProcessHandle["getOutputFd"];
}): ChildProcessSpawner.ChildProcessHandle {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(123),
    stdout: options?.stdout ?? Stream.empty,
    stderr: options?.stderr ?? Stream.empty,
    all: Stream.merge(options?.stdout ?? Stream.empty, options?.stderr ?? Stream.empty),
    exitCode: options?.exitCode ?? Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
    kill: options?.kill ?? (() => Effect.void),
    stdin: Sink.drain,
    getInputFd: () => Sink.drain,
    getOutputFd: options?.getOutputFd ?? (() => Stream.empty),
    unref: Effect.succeed(Effect.void),
  });
}

export function responseForRequest(
  request: HttpClientRequest.HttpClientRequest,
  status: number,
): HttpClientResponse.HttpClientResponse {
  return HttpClientResponse.fromWeb(request, new Response(null, { status }));
}

export function httpClientLayer(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
) {
  return Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => handler(request)),
  );
}

export const healthyHttpClientLayer = httpClientLayer((request) =>
  Effect.succeed(responseForRequest(request, 200)),
);

export function decodeBootstrap(raw: string) {
  return decodeDesktopBackendBootstrap(raw);
}

export interface MakeInstanceInput {
  readonly spawnerLayer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner>;
  readonly httpClientLayer?: Layer.Layer<HttpClient.HttpClient>;
  readonly backendOutputLog?: Partial<DesktopObservability.DesktopBackendOutputLogShape>;
  readonly onReady?: Effect.Effect<void>;
  readonly onShutdown?: Effect.Effect<void>;
  readonly onPreflightFailed?: (
    failure: DesktopBackendManager.PreflightFailure,
  ) => Effect.Effect<boolean>;
  readonly config?: DesktopBackendManager.DesktopBackendStartConfig;
  readonly configResolve?: Effect.Effect<
    DesktopBackendManager.DesktopBackendStartConfig,
    PlatformError.PlatformError
  >;
  readonly desktopTelemetryStream?: Stream.Stream<Uint8Array>;
  readonly desktopTelemetryPublisher?: Partial<
    DesktopTelemetryPublisher.DesktopTelemetryPublisher["Service"]
  >;
}

// Helper that constructs a primary backend instance using the factory
// directly. The factory's deps (FileSystem, ChildProcessSpawner,
// HttpClient, DesktopBackendOutputLogFactory) are provided per-test via
// a scoped layer; tests yield the returned Effect inside `Effect.scoped`
// to drive the instance's lifecycle.
export function makeTestInstance(input: MakeInstanceInput) {
  const stubLog: DesktopObservability.DesktopBackendOutputLogShape = {
    beginSession: () => Effect.void,
    writeOutputChunk: () => Effect.void,
    persistFailureSnapshot: () => Effect.void,
    persistFailure: () => Effect.void,
    discardSession: Effect.void,
    ...input.backendOutputLog,
  };

  const servicesLayer = Layer.mergeAll(
    FileSystem.layerNoop({
      exists: () => Effect.succeed(true),
    }),
    input.spawnerLayer,
    input.httpClientLayer ?? healthyHttpClientLayer,
    Layer.succeed(DesktopObservability.DesktopBackendOutputLogFactory, {
      forInstance: () => Effect.succeed(stubLog),
    } satisfies DesktopObservability.DesktopBackendOutputLogFactory["Service"]),
    Layer.succeed(DesktopTelemetryPublisher.DesktopTelemetryPublisher, {
      latest: Effect.succeed(Option.none()),
      changes: Stream.empty,
      encoded: input.desktopTelemetryStream ?? Stream.empty,
      handleControl: () => Effect.void,
      handleControlForSource: (_sourceId, message) =>
        (input.desktopTelemetryPublisher?.handleControl ?? (() => Effect.void))(message),
      removeControlSource: () => Effect.void,
      ...input.desktopTelemetryPublisher,
    }),
  );

  const instance = DesktopBackendManager.makeBackendInstance({
    id: DesktopBackendManager.PRIMARY_INSTANCE_ID,
    label: Effect.succeed("Windows"),
    configResolve: input.configResolve ?? Effect.succeed(input.config ?? baseConfig),
    ...(input.onReady ? { onReady: () => input.onReady! } : {}),
    ...(input.onShutdown ? { onShutdown: () => input.onShutdown! } : {}),
    ...(input.onPreflightFailed ? { onPreflightFailed: input.onPreflightFailed } : {}),
  });

  return instance.pipe(Effect.provide(servicesLayer));
}
