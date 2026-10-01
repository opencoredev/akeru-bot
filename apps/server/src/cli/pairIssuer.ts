import { AuthAdministrativeScopes, AuthStandardClientScopes } from "@akeru/contracts";
import { DEFAULT_TAILSCALE_SERVE_PORT } from "@akeru/tailscale";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import { hasPairedAdminClient } from "../auth/adminClients.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerConfig from "../config.ts";
import { DEV_VARIANT_PLACEHOLDER_URL, AdminAlreadyPairedError } from "./pairTypes.ts";
import { type DiscoveredPairTarget } from "./pairTarget.ts";

/**
 * Server config pointed at the discovered server's state directory, so the
 * minted token lands in the database the running server reads from. Built by
 * hand rather than through `resolveServerConfig` to keep the dev-vs-userdata
 * choice pinned to where the runtime state was actually found, independent of
 * ambient environment variables.
 */
export const makePairServerConfig = Effect.fn(function* (input: {
  readonly target: DiscoveredPairTarget;
  readonly logLevel: ServerConfig.ServerConfig["Service"]["logLevel"];
}) {
  const { baseDir, variant, state } = input.target;
  // The state-dir variant does not imply dev-ness: a worktree dev server uses
  // an explicit home and therefore lands in `userdata`. The recorded devUrl is
  // what actually marks a dev server.
  const devUrl = state.devUrl !== undefined ? new URL(state.devUrl) : undefined;

  const derivedPaths = yield* ServerConfig.deriveServerPaths(
    baseDir,
    variant === "dev" ? DEV_VARIANT_PLACEHOLDER_URL : undefined,
    {},
  );

  return ServerConfig.make({
    logLevel: input.logLevel,
    traceMinLevel: "Info",
    traceTimingEnabled: false,
    traceBatchWindowMs: 1_000,
    traceMaxBytes: 10 * 1024 * 1024,
    traceMaxFiles: 10,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "akeru-server",
    mode: "web",
    port: state.port,
    host: state.host,
    cwd: process.cwd(),
    baseDir,
    ...derivedPaths,
    staticDir: undefined,
    devUrl,
    devAllowedOrigins: [],
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    desktopTelemetryFd: undefined,
    desktopTelemetryControlFd: undefined,
    resourceMonitorPath: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: DEFAULT_TAILSCALE_SERVE_PORT,
    publicOrigin: undefined,
  });
});

/**
 * Admin bootstrap for a headless install whose first-boot link was missed or expired. It writes
 * straight into the environment database, so only someone on the machine can run it, and it closes
 * for good once a person has paired an admin client. Bot and script sessions do not close it.
 */
export const issueAdminPairingLink = Effect.fn("pair.issueAdminPairingLink")(function* (input: {
  readonly ttl: Option.Option<Duration.Duration>;
  readonly label: Option.Option<string>;
}) {
  const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

  if (hasPairedAdminClient(yield* environmentAuth.listSessions())) {
    return yield* new AdminAlreadyPairedError();
  }

  return yield* environmentAuth.createPairingLink({
    scopes: AuthAdministrativeScopes,
    subject: "one-time-token",
    label: Option.getOrElse(input.label, () => "akeru pair --admin"),
    ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
  });
});

export const mintPairingLink = Effect.fn("pair.mintPairingLink")(function* (input: {
  readonly config: ServerConfig.ServerConfig["Service"];
  readonly ttl: Option.Option<Duration.Duration>;
  readonly label: Option.Option<string>;
  readonly admin: boolean;
}) {
  return yield* Effect.gen(function* () {
    if (input.admin) {
      return yield* issueAdminPairingLink({ ttl: input.ttl, label: input.label });
    }

    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;

    return yield* environmentAuth.createPairingLink({
      scopes: AuthStandardClientScopes,
      subject: "one-time-token",
      label: Option.getOrElse(input.label, () => "akeru pair"),
      ...(Option.isSome(input.ttl) ? { ttl: input.ttl.value } : {}),
    });
  }).pipe(
    Effect.provide(
      EnvironmentAuth.runtimeLayer.pipe(
        Layer.provide(ServerConfig.layer(input.config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, input.config.logLevel)),
      ),
    ),
  );
});
