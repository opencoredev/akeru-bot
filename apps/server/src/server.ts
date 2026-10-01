import * as Predicate from "effect/Predicate";
import { EnvironmentHttpApi } from "@akeru/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { whatsAppWebhookRouteLayer } from "./channels/ChannelRuntime.ts";
import * as ServerConfig from "./config.ts";
import { otlpTracesProxyRouteLayer, assetRouteLayer, attachmentUploadRouteLayer, serverEnvironmentHttpApiLayer, staticAndDevRouteLayer, browserApiCorsLayer, httpCompressionLayer } from "./http.ts";
import { guardHttpResponseWriteErrors } from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import { websocketRpcRouteLayer } from "./ws.ts";
import { remoteMachineUpdateRouteLayer } from "./remote/updateRoute.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewAutomationServerHost from "./mcp/PreviewAutomationServerHost.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./auth/http.ts";
import * as ServerSelfUpdate from "./cloud/selfUpdate.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import { clearPersistedServerRuntimeState, makePersistedServerRuntimeState, persistServerRuntimeState } from "./serverRuntimeState.ts";
import { orchestrationHttpApiLayer } from "./orchestration/http.ts";
import { disableTailscaleServe, ensureTailscaleServe } from "@akeru/tailscale";
import { ServerActivation } from "./serverActivation.ts";

import { McpSessionRegistryLayerLive, RuntimeDependenciesLive, ApplicationObservabilityLive } from "./serverLayers.ts";

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// T3's primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;

const HttpServerLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    if (typeof Bun !== "undefined") {
      const BunHttpServer = yield* Effect.promise(
        () => import("@effect/platform-bun/BunHttpServer"),
      );
      return BunHttpServer.layer({
        port: config.port,
        hostname: config.host ?? "127.0.0.1",
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        websocket: {
          // Negotiate permessage-deflate with clients that offer it; clients
          // that don't still get uncompressed frames on their connection. A
          // dedicated compressor keeps a per-connection sliding window
          // (context takeover) so the compression dictionary is shared across
          // server-to-client frames. Decompression uses the shared
          // decompressor: uWebSockets' dedicated decompressor path can abort
          // connections (close 1006) on valid DEFLATE input — see
          // https://github.com/uNetworking/uWebSockets.js/issues/633.
          perMessageDeflate: {
            compress: "dedicated",
            decompress: "shared",
          },
        },
      });
    } else {
      const [NodeHttpServer, NodeHttp] = yield* Effect.all([
        Effect.promise(() => import("@effect/platform-node/NodeHttpServer")),
        Effect.promise(() => import("node:http")),
      ]);
      return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
        host: config.host ?? "127.0.0.1",
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Negotiate permessage-deflate with clients that offer it; clients
        // that don't still get uncompressed frames on their connection.
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        websocket: { perMessageDeflate: true },
      });
    }
  }),
);

const PlatformServicesLive = Layer.unwrap(
  Effect.gen(function* () {
    if (typeof Bun !== "undefined") {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-bun/BunServices"));
      return layer;
    } else {
      const { layer } = yield* Effect.promise(() => import("@effect/platform-node/NodeServices"));
      return layer;
    }
  }),
);

const commandReadinessLayer = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

const makeRoutesLayerWithSharedMcpRegistry = Layer.mergeAll(
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(authHttpApiLayer),
      Layer.provide(orchestrationHttpApiLayer),
      Layer.provide(serverEnvironmentHttpApiLayer),
      Layer.provide(environmentAuthenticatedAuthLayer),
    ),
    otlpTracesProxyRouteLayer,
    whatsAppWebhookRouteLayer,
    assetRouteLayer,
    attachmentUploadRouteLayer,
    staticAndDevRouteLayer,
    websocketRpcRouteLayer,
    remoteMachineUpdateRouteLayer,
  ),
  McpHttpServer.layer,
).pipe(
  Layer.provide(ServerSelfUpdate.layer),
  Layer.provide(commandReadinessLayer),
  Layer.provide(browserApiCorsLayer),
  Layer.provide(httpCompressionLayer),
);

// Route-only tests do not build the provider runtime, so give those callers a
// private registry. The real server uses the runtime-owned registry below.
export const makeRoutesLayer = makeRoutesLayerWithSharedMcpRegistry.pipe(
  Layer.provide(McpSessionRegistryLayerLive),
  Layer.provide(PreviewAutomationBroker.layer),
);

export const makeServerLayer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const activationLayer = Layer.succeed(ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const tailscaleParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();
    const launcherLayer = ServiceLauncherClient.layer;

    yield* fixPath();

    const httpListeningLayer = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
      }),
    );
    const runtimeStateLayer = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.gen(function* () {
          yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
          yield* awaitActivation;
          const server = yield* HttpServer.HttpServer;
          const address = server.address;
          if (Predicate.isString(address) || !("port" in address)) {
            return;
          }

          const state = yield* makePersistedServerRuntimeState({
            config,
            port: address.port,
          });
          yield* persistServerRuntimeState({
            path: config.serverRuntimeStatePath,
            state,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
        }),
        () =>
          clearPersistedServerRuntimeState(config.serverRuntimeStatePath).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to clear server runtime state", { cause }),
            ),
          ),
      ),
    );
    const tailscaleServeLayer = config.tailscaleServeEnabled
      ? Layer.effectDiscard(
          Effect.acquireRelease(
            Effect.gen(function* () {
              yield* Deferred.succeed(tailscaleParked, undefined).pipe(Effect.orDie);
              yield* awaitActivation;
              const server = yield* HttpServer.HttpServer;
              const address = server.address;
              if (Predicate.isString(address) || !("port" in address)) {
                return null;
              }

              const localPort = address.port;
              return yield* ensureTailscaleServe({
                localPort,
                servePort: config.tailscaleServePort,
                localHost: "127.0.0.1",
              }).pipe(
                Effect.as({ localPort, servePort: config.tailscaleServePort }),
                Effect.tap(() =>
                  Effect.logInfo("Tailscale Serve configured", {
                    localPort,
                    servePort: config.tailscaleServePort,
                  }),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("Failed to configure Tailscale Serve", {
                    cause,
                    localPort,
                    servePort: config.tailscaleServePort,
                  }).pipe(Effect.as(null)),
                ),
              );
            }),
            (configured) =>
              configured
                ? disableTailscaleServe({ servePort: configured.servePort }).pipe(
                    Effect.tap(() =>
                      Effect.logInfo("Tailscale Serve disabled", {
                        servePort: configured.servePort,
                      }),
                    ),
                    Effect.catch((cause) =>
                      Effect.logWarning("Failed to disable Tailscale Serve", {
                        cause,
                        servePort: configured.servePort,
                      }),
                    ),
                  )
                : Effect.void,
          ),
        )
      : Layer.empty;
    const runtimeServicesLive = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [
          Deferred.await(runtimeStateParked),
          Deferred.await(routesReady),
          ...(config.tailscaleServeEnabled ? [Deferred.await(tailscaleParked)] : []),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(RuntimeDependenciesLive), Layer.provide(launcherLayer));

    const routesLayer = HttpRouter.serve(
      makeRoutesLayerWithSharedMcpRegistry.pipe(Layer.provide(launcherLayer)),
      {
        disableLogger: !config.logWebSocketEvents,
      },
    ).pipe(Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)));
    const serverApplicationLayer = Layer.mergeAll(
      routesLayer,
      PreviewAutomationServerHost.layer,
      httpListeningLayer,
      runtimeStateLayer,
      tailscaleServeLayer,
    );

    return serverApplicationLayer.pipe(
      Layer.provideMerge(runtimeServicesLive),
      Layer.provide(PreviewAutomationBroker.layer),
      Layer.provide(activationLayer),
      Layer.provideMerge(HttpServerLive),
      Layer.provide(ApplicationObservabilityLive),
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(VcsProcess.layer),
      Layer.provideMerge(PlatformServicesLive),
    );
  }),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(makeServerLayer);

export { RuntimeMemoryRepositoriesLive } from "./serverLayers.ts";
