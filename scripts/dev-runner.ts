#!/usr/bin/env node
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as NetService from "@akeru/shared/Net";

import { resolveGitWorktreePath, resolveWorktreeT3Home } from "@akeru/shared/devHome";

import { HostProcessEnvironment, HostProcessWorkingDirectory } from "@akeru/shared/hostProcess";

import { resolveSpawnCommand } from "@akeru/shared/shell";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Logger from "effect/Logger";

import * as Option from "effect/Option";

import * as Schema from "effect/Schema";

import { Argument, Command, Flag } from "effect/unstable/cli";

import { ChildProcess } from "effect/unstable/process";

import { type DevShareError, shareDevServer, unshareDevServer } from "./lib/dev-share.ts";

import { loadRepoEnv } from "./lib/public-config.ts";

import {
  BASE_SERVER_PORT,
  BASE_WEB_PORT,
  MAX_PORT,
  DEFAULT_T3_HOME,
  MODE_ARGS,
  type DevMode,
  DEV_RUNNER_MODES,
  DevRunnerConfigurationError,
  DevRunnerInvalidPortOffsetError,
  optionalStringConfig,
  optionalBooleanConfig,
  optionalPortConfig,
  OffsetConfig,
  resolveOffset,
  createDevRunnerEnv,
} from "./lib/dev-runner/config.ts";

export {
  DEFAULT_T3_HOME,
  getDevRunnerModeArgs,
  DevRunnerConfigurationError,
  DevRunnerInvalidPortOffsetError,
  resolveOffset,
  createDevRunnerEnv,
} from "./lib/dev-runner/config.ts";

Object.assign(process.env, loadRepoEnv());

// HTTP(S) requests to these ports are blocked by the Fetch standard before a
// browser reaches the network. Keep the complete list here so explicit or
// future wider offsets cannot produce a URL that curl accepts but browsers
// reject. https://fetch.spec.whatwg.org/#port-blocking
const FETCH_BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102,
  103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465,
  512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993,
  995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668,
  6669, 6679, 6697, 10080,
]);

// Dev servers bind loopback, so loopback is the only interface whose
// availability decides whether we can use a port. Probing wildcards too made
// the runner walk away from a perfectly free port whenever something else held
// the same number on another interface — `tailscale serve` does exactly that,
// which silently moved the ports out from under a URL that had just been shared.
const DEV_PORT_PROBE_HOSTS = ["127.0.0.1", "::1"] as const;

/**
 * Bind hosts on which a backend still answers `http://localhost:<port>`, which
 * is where single-origin browser dev proxies to. Loopback and the wildcards
 * qualify; a specific interface (e.g. a LAN IP) does not — the OS binds only
 * that address and the proxy target goes dark.
 */
export function isProxiableBindHost(host: string): boolean {
  const normalized = host.trim();

  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized === "0.0.0.0" ||
    normalized === "::" ||
    normalized === "[::]"
  );
}

/**
 * `role` matters because only the backend honours `--host`/`T3CODE_HOST`; the
 * web port is always loopback. Passed explicitly rather than inferred from the
 * port number, which stops distinguishing them under a large port offset.
 */
type PortAvailabilityCheck<R = never> = (
  port: number,
  role?: "server" | "web",
) => Effect.Effect<boolean, never, R>;

export function isBrowserAllowedPort(port: number): boolean {
  return !FETCH_BAD_PORTS.has(port);
}

export class DevRunnerPortExhaustedError extends Schema.TaggedErrorClass<DevRunnerPortExhaustedError>()(
  "DevRunnerPortExhaustedError",
  {
    startOffset: Schema.Number,
    requireServerPort: Schema.Boolean,
    requireWebPort: Schema.Boolean,
    baseServerPort: Schema.Number,
    baseWebPort: Schema.Number,
    maximumPort: Schema.Number,
  },
) {
  override get message(): string {
    return `No required dev ports were available from offset ${this.startOffset} through maximum port ${this.maximumPort}.`;
  }
}

export class DevRunnerProcessError extends Schema.TaggedErrorClass<DevRunnerProcessError>()(
  "DevRunnerProcessError",
  {
    operation: Schema.Literals(["spawn", "wait-for-exit"]),
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Dev-runner process operation "${this.operation}" failed for mode "${this.mode}".`;
  }
}

export class DevRunnerProcessExitError extends Schema.TaggedErrorClass<DevRunnerProcessExitError>()(
  "DevRunnerProcessExitError",
  {
    mode: Schema.Literals(["dev", "dev:server", "dev:web", "dev:desktop"]),
    executable: Schema.Literal("vp"),
    argumentCount: Schema.Number,
    shell: Schema.Boolean,
    exitCode: Schema.Number,
  },
) {
  override get message(): string {
    return `Dev-runner process exited with code ${this.exitCode} in mode "${this.mode}".`;
  }
}

export class DevRunnerHostNotProxiableError extends Schema.TaggedErrorClass<DevRunnerHostNotProxiableError>()(
  "DevRunnerHostNotProxiableError",
  {
    mode: Schema.Literals(["dev", "dev:web"]),
    host: Schema.String,
  },
) {
  override get message(): string {
    return `--host ${this.host} cannot be combined with ${this.mode}: single-origin browser dev proxies the backend at localhost, and a backend bound only to ${this.host} leaves localhost unanswered, so every proxied request fails. Use a wildcard (0.0.0.0 or ::) to serve that interface and loopback together, or --share for remote access.`;
  }
}

export const DevRunnerError = Schema.Union([
  DevRunnerConfigurationError,
  DevRunnerHostNotProxiableError,
  DevRunnerInvalidPortOffsetError,
  DevRunnerPortExhaustedError,
  DevRunnerProcessError,
  DevRunnerProcessExitError,
]);

export type DevRunnerError = typeof DevRunnerError.Type;

export const isDevRunnerError = Schema.is(DevRunnerError);

function portPairForOffset(offset: number): {
  readonly serverPort: number;
  readonly webPort: number;
} {
  return {
    serverPort: BASE_SERVER_PORT + offset,
    webPort: BASE_WEB_PORT + offset,
  };
}

export function checkPortAvailabilityOnHosts<R>(
  port: number,
  hosts: ReadonlyArray<string>,
  canListenOnHost: (port: number, host: string) => Effect.Effect<boolean, never, R>,
): Effect.Effect<boolean, never, R> {
  return Effect.gen(function* () {
    for (const host of hosts) {
      if (!(yield* canListenOnHost(port, host))) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Hosts to probe for a dev server bound to `configuredHost`.
 *
 * Loopback is always checked because the web server and the desktop renderer
 * target reach it there. When `--host`/`T3CODE_HOST` moves the backend onto
 * another interface, that interface decides whether the bind actually
 * succeeds — probing only loopback would hand back a port that is free here
 * and taken there, and the server would fail to start.
 *
 * `configuredHost` applies to the *backend* only. Vite takes its bind address
 * from `HOST`, which the runner sets for desktop alone, so the web port stays
 * on loopback and must not be judged against the backend's interface —
 * a port free on loopback but busy on that interface would otherwise be
 * rejected for a server that was never going to bind there.
 */
export function devPortProbeHosts(configuredHost: string | undefined): ReadonlyArray<string> {
  const host = configuredHost?.trim();

  if (!host || DEV_PORT_PROBE_HOSTS.includes(host as (typeof DEV_PORT_PROBE_HOSTS)[number])) {
    return DEV_PORT_PROBE_HOSTS;
  }

  return [...DEV_PORT_PROBE_HOSTS, host];
}

const makeDefaultCheckPortAvailability =
  (configuredHost: string | undefined): PortAvailabilityCheck<NetService.NetService> =>
  (port, role) =>
    Effect.gen(function* () {
      const net = yield* NetService.NetService;
      const hosts = role === "web" ? DEV_PORT_PROBE_HOSTS : devPortProbeHosts(configuredHost);

      return yield* checkPortAvailabilityOnHosts(port, hosts, (candidatePort, host) =>
        net.canListenOnHost(candidatePort, host),
      );
    });

const defaultCheckPortAvailability = makeDefaultCheckPortAvailability(undefined);

interface FindFirstAvailableOffsetInput<R = NetService.NetService> {
  readonly startOffset: number;
  readonly requireServerPort: boolean;
  readonly requireWebPort: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function findFirstAvailableOffset<R = NetService.NetService>({
  startOffset,
  requireServerPort,
  requireWebPort,
  checkPortAvailability,
}: FindFirstAvailableOffsetInput<R>): Effect.Effect<number, DevRunnerPortExhaustedError, R> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    for (let candidate = startOffset; ; candidate += 1) {
      const { serverPort, webPort } = portPairForOffset(candidate);
      const serverPortOutOfRange = serverPort > MAX_PORT;
      const webPortOutOfRange = webPort > MAX_PORT;

      if (
        (requireServerPort && serverPortOutOfRange) ||
        (requireWebPort && webPortOutOfRange) ||
        (!requireServerPort && !requireWebPort && (serverPortOutOfRange || webPortOutOfRange))
      ) {
        break;
      }

      if (requireWebPort && !isBrowserAllowedPort(webPort)) {
        continue;
      }

      const checks: Array<Effect.Effect<boolean, never, R>> = [];

      if (requireServerPort) {
        checks.push(checkPort(serverPort, "server"));
      }

      if (requireWebPort) {
        checks.push(checkPort(webPort, "web"));
      }

      if (checks.length === 0) {
        return candidate;
      }

      const availability = yield* Effect.all(checks);

      if (availability.every(Boolean)) {
        return candidate;
      }
    }

    return yield* new DevRunnerPortExhaustedError({
      startOffset,
      requireServerPort,
      requireWebPort,
      baseServerPort: BASE_SERVER_PORT,
      baseWebPort: BASE_WEB_PORT,
      maximumPort: MAX_PORT,
    });
  });
}

interface ResolveModePortOffsetsInput<R = NetService.NetService> {
  readonly mode: DevMode;
  readonly startOffset: number;
  readonly hasExplicitServerPort: boolean;
  readonly hasExplicitDevUrl: boolean;
  readonly checkPortAvailability?: PortAvailabilityCheck<R>;
}

export function resolveModePortOffsets<R = NetService.NetService>({
  mode,
  startOffset,
  hasExplicitServerPort,
  hasExplicitDevUrl,
  checkPortAvailability,
}: ResolveModePortOffsetsInput<R>): Effect.Effect<
  { readonly serverOffset: number; readonly webOffset: number },
  DevRunnerPortExhaustedError,
  R
> {
  return Effect.gen(function* () {
    const checkPort = (checkPortAvailability ??
      defaultCheckPortAvailability) as PortAvailabilityCheck<R>;

    if (mode === "dev:web") {
      if (hasExplicitDevUrl) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const webOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: false,
        requireWebPort: true,
        checkPortAvailability: checkPort,
      });

      return { serverOffset: startOffset, webOffset };
    }

    if (mode === "dev:server") {
      if (hasExplicitServerPort) {
        return { serverOffset: startOffset, webOffset: startOffset };
      }

      const serverOffset = yield* findFirstAvailableOffset({
        startOffset,
        requireServerPort: true,
        requireWebPort: false,
        checkPortAvailability: checkPort,
      });

      return { serverOffset, webOffset: serverOffset };
    }

    const sharedOffset = yield* findFirstAvailableOffset({
      startOffset,
      requireServerPort: !hasExplicitServerPort,
      requireWebPort: !hasExplicitDevUrl,
      checkPortAvailability: checkPort,
    });

    return { serverOffset: sharedOffset, webOffset: sharedOffset };
  });
}

interface DevRunnerCliInput {
  readonly mode: DevMode;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
  readonly dryRun: boolean;
  readonly share: boolean;
  readonly runArgs: ReadonlyArray<string>;
}

export function runDevRunnerWithInput(input: DevRunnerCliInput) {
  return Effect.gen(function* () {
    const { portOffset, devInstance } = yield* OffsetConfig.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerConfigurationError({
            configKeys: ["T3CODE_PORT_OFFSET", "T3CODE_DEV_INSTANCE"],
            cause,
          }),
      ),
    );

    // Single-origin browser dev proxies the backend at localhost. A wildcard
    // bind still answers there; a specific non-loopback interface does not,
    // which breaks every proxied request in a way that reads as "server is
    // broken" rather than "flag combination is unsupported". Reject it up
    // front instead. (dev:server and dev:desktop don't proxy — untouched.)
    if (
      (input.mode === "dev" || input.mode === "dev:web") &&
      input.host !== undefined &&
      !isProxiableBindHost(input.host)
    ) {
      return yield* new DevRunnerHostNotProxiableError({ mode: input.mode, host: input.host });
    }

    const worktreePath = yield* resolveGitWorktreePath(yield* HostProcessWorkingDirectory);

    const { offset, source } = yield* resolveOffset({
      portOffset,
      devInstance,
      worktreePath,
    });

    const { serverOffset, webOffset } = yield* resolveModePortOffsets({
      mode: input.mode,
      startOffset: offset,
      hasExplicitServerPort: input.port !== undefined,
      hasExplicitDevUrl: input.devUrl !== undefined,
      // A non-loopback bind host decides whether the backend can actually take
      // the port, so it has to be probed alongside loopback.
      checkPortAvailability: makeDefaultCheckPortAvailability(input.host),
    });

    const hostEnvironment = yield* HostProcessEnvironment;
    // A dev server started inside a worktree defaults to that worktree's own
    // (gitignored) `.akeru` — see @akeru/shared/devHome for why this must
    // outrank an ambient T3CODE_HOME. `--home-dir` still wins.
    const worktreeHome = yield* resolveWorktreeT3Home(yield* HostProcessWorkingDirectory);

    // Trim before choosing: `--home-dir ""` is not a selection, and treating it
    // as one would skip the worktree default and land on the shared home —
    // exactly the outcome this precedence exists to prevent.
    const resolvedT3Home =
      (input.t3Home?.trim() || undefined) ??
      worktreeHome ??
      (hostEnvironment.T3CODE_HOME?.trim() || undefined);

    const env = yield* createDevRunnerEnv({
      mode: input.mode,
      baseEnv: hostEnvironment,
      serverOffset,
      webOffset,
      t3Home: resolvedT3Home,
      browser: input.browser,
      autoBootstrapProjectFromCwd: input.autoBootstrapProjectFromCwd,
      logWebSocketEvents: input.logWebSocketEvents,
      host: input.host,
      port: input.port,
      devUrl: input.devUrl,
    });

    const selectionSuffix =
      serverOffset !== offset || webOffset !== offset
        ? ` selectedOffset(server=${serverOffset},web=${webOffset})`
        : "";

    const baseDir = env.T3CODE_HOME ?? (yield* DEFAULT_T3_HOME);

    yield* Effect.logInfo(
      `[dev-runner] mode=${input.mode} source=${source}${selectionSuffix} serverPort=${String(env.T3CODE_PORT)} webPort=${String(env.PORT)} baseDir=${baseDir}`,
    );

    // Before the share block: --dry-run only resolves and prints. Sharing would
    // replace, then tear down, whatever mapping the port already had — a
    // surprising side effect from a command documented as inert.
    if (input.dryRun) {
      return;
    }

    const sharedWebPort = BASE_WEB_PORT + webOffset;

    if (input.share) {
      if (input.mode === "dev:server") {
        yield* Effect.logInfo("[dev-runner] --share has no effect for dev:server (no web server).");
      } else if (input.mode === "dev:desktop") {
        // Desktop is not single-origin: the renderer gets VITE_HTTP_URL and
        // VITE_WS_URL baked to loopback, so a tailnet visitor would load the UI
        // and then watch it dial its own 127.0.0.1 for the backend. Worse,
        // sharing would overwrite VITE_DEV_SERVER_URL, which is the origin
        // Electron itself loads the renderer from. Refuse rather than hand out
        // a URL that is broken in a way the user cannot see.
        yield* Effect.logWarning(
          "[dev-runner] --share is not supported for dev:desktop (the renderer is pinned to loopback). Use `dev`, which runs the whole browser stack.",
        );
      } else {
        // acquireRelease, not share-then-addFinalizer: the mapping outlives this
        // process (and reboots), so the cleanup has to be registered atomically
        // with creating it. An interrupt landing in between would otherwise
        // leave a mapping pointing at a port nothing is listening on.
        //
        // Deliberately no ownership tracking beyond that: if a second runner
        // takes this port during a fast restart, the first's exit can briefly
        // tear down the new mapping — visible (the URL stops working) and fixed
        // by re-running --share. A lease protocol closing that window existed
        // and was removed as more machinery than a dev convenience warrants.
        //
        // A tailnet that isn't up shouldn't stop the dev server from starting —
        // warn, and carry on serving locally.
        const shared = yield* Effect.acquireRelease(
          shareDevServer({ webPort: sharedWebPort }),
          () =>
            // Serve config outlives this process, so a cleanup that did not
            // take leaves a tailnet URL pointing at a port nothing serves.
            unshareDevServer(sharedWebPort).pipe(
              Effect.flatMap((result) =>
                result.cleared
                  ? Effect.void
                  : Effect.logWarning(
                      `[dev-runner] could not remove the tailnet mapping for port ${String(sharedWebPort)}${
                        result.explanation ? `: ${result.explanation}` : ""
                      }. Remove it with \`tailscale serve --https=${String(sharedWebPort)} off\`.`,
                    ),
              ),
            ),
        ).pipe(
          Effect.tapError((error: DevShareError) =>
            Effect.logWarning(
              `[dev-runner] could not share on the tailnet: ${error.message}${
                error.hint ? ` — ${error.hint}` : ""
              }`,
            ),
          ),
          Effect.option,
          Effect.map(Option.getOrUndefined),
        );

        if (shared) {
          // The app is reached from the tailnet origin. Vite already allows
          // *.ts.net hosts; the backend needs the origin for credentialed
          // requests that bypass the proxy (desktop renderer, direct calls).
          env.T3CODE_DEV_ALLOWED_ORIGINS = [
            env.T3CODE_DEV_ALLOWED_ORIGINS,
            new URL(shared.url).origin,
          ]
            .filter((entry) => entry && entry.length > 0)
            .join(",");

          // The server builds its pairing URL from this, so the URL printed at
          // startup is already the shareable one — no rewriting by hand. An
          // explicit --dev-url still wins.
          if (input.devUrl === undefined) {
            env.VITE_DEV_SERVER_URL = shared.url;
          }

          // A shared origin serves a remote browser, where unbundled dev's
          // per-module requests each pay a tailnet round trip — a cold module
          // graph takes minutes to first paint. Bundled dev collapses that to
          // a few chunk requests. Only defaulted, so T3CODE_BUNDLED_DEV=0
          // still opts a --share run back out.
          if (env.T3CODE_BUNDLED_DEV === undefined) {
            env.T3CODE_BUNDLED_DEV = "1";
          }

          yield* Effect.logInfo(`[dev-runner] shared on tailnet: ${shared.url}`);
        }
      }
    }

    const spawnCommand = yield* resolveSpawnCommand(
      "vp",
      [...MODE_ARGS[input.mode], ...input.runArgs],
      { env },
    );

    const processContext = {
      mode: input.mode,
      executable: "vp" as const,
      argumentCount: spawnCommand.args.length,
      shell: spawnCommand.shell,
    } as const;

    const child = yield* ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env,
      extendEnv: false,
      shell: spawnCommand.shell,
      // Keep Vite+ in the same process group so terminal signals (Ctrl+C)
      // reach it directly. Effect defaults to detached: true on non-Windows,
      // which would put the runner in a new group and require manual forwarding.
      detached: false,
      forceKillAfter: "1500 millis",
    }).pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "spawn",
            cause,
          }),
      ),
    );

    const exitCode = yield* child.exitCode.pipe(
      Effect.mapError(
        (cause) =>
          new DevRunnerProcessError({
            ...processContext,
            operation: "wait-for-exit",
            cause,
          }),
      ),
    );

    if (exitCode !== 0) {
      return yield* new DevRunnerProcessExitError({
        ...processContext,
        exitCode,
      });
    }
  });
}

const devRunnerCli = Command.make("dev-runner", {
  mode: Argument.choice("mode", DEV_RUNNER_MODES).pipe(
    Argument.withDescription("Development mode to run."),
  ),
  t3Home: Flag.string("home-dir").pipe(
    Flag.withDescription(
      "Explicit Akeru Bot data directory; runtime state is stored under userdata (equivalent to T3CODE_HOME). Inside a git worktree this defaults to that worktree's own .akeru so dev state stays off the shared home.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  browser: Flag.boolean("browser").pipe(
    Flag.withDescription("Open a browser automatically (disabled by default for web dev)."),
  ),
  autoBootstrapProjectFromCwd: Flag.boolean("auto-bootstrap-project-from-cwd").pipe(
    Flag.withDescription(
      "Auto-bootstrap toggle (equivalent to T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD).",
    ),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD")),
  ),
  logWebSocketEvents: Flag.boolean("log-websocket-events").pipe(
    Flag.withDescription("WebSocket event logging toggle (equivalent to T3CODE_LOG_WS_EVENTS)."),
    Flag.withAlias("log-ws-events"),
    Flag.withFallbackConfig(optionalBooleanConfig("T3CODE_LOG_WS_EVENTS")),
  ),
  host: Flag.string("host").pipe(
    Flag.withDescription("Server host/interface override (forwards to T3CODE_HOST)."),
    Flag.withFallbackConfig(optionalStringConfig("T3CODE_HOST")),
  ),
  port: Flag.integer("port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Server port override (forwards to T3CODE_PORT)."),
    Flag.withFallbackConfig(optionalPortConfig("T3CODE_PORT")),
  ),
  devUrl: Flag.string("dev-url").pipe(
    Flag.withSchema(Schema.URLFromString),
    Flag.withDescription(
      "Explicit web dev URL override (forwards to VITE_DEV_SERVER_URL). Ambient VITE_DEV_SERVER_URL values are ignored so a parent dev app cannot redirect the child runner.",
    ),
    Flag.optional,
    Flag.map(Option.getOrUndefined),
  ),
  dryRun: Flag.boolean("dry-run").pipe(
    Flag.withDescription("Resolve mode/ports/env and print, but do not spawn Vite+."),
    Flag.withDefault(false),
  ),
  share: Flag.boolean("share").pipe(
    Flag.withDescription(
      "Publish the web dev server on this machine's tailnet over HTTPS (via `tailscale serve`) and print the pairing URL for it. Removed again on exit.",
    ),
    Flag.withDefault(false),
  ),
  runArgs: Argument.string("run-arg").pipe(
    Argument.withDescription("Additional Vite+ run args (pass after `--`)."),
    Argument.variadic(),
  ),
}).pipe(
  Command.withDescription("Run monorepo development modes with deterministic port/env wiring."),
  Command.withHandler((input) => runDevRunnerWithInput(input)),
);

const cliRuntimeLayer = Layer.mergeAll(
  Logger.layer([Logger.consolePretty()]),
  NodeServices.layer,
  NetService.layer,
);

if (import.meta.main) {
  Command.run(devRunnerCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
