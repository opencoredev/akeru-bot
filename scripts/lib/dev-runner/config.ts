import * as NodeOS from "node:os";

import { PRODUCT_HOME_DIRNAME } from "@akeru/shared/devHome";

import * as Config from "effect/Config";

import * as Effect from "effect/Effect";

import * as Hash from "effect/Hash";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

export const BASE_SERVER_PORT = 13773;

export const BASE_WEB_PORT = 5733;

const MAX_HASH_OFFSET = 3000;

export const MAX_PORT = 65535;

const DESKTOP_DEV_LOOPBACK_HOST = "127.0.0.1";

export const DEFAULT_T3_HOME = Effect.map(Effect.service(Path.Path), (path) =>
  path.join(NodeOS.homedir(), PRODUCT_HOME_DIRNAME),
);

export const MODE_ARGS = {
  dev: [
    "run",
    "--filter=@akeru/contracts",
    "--filter=@akeru/web",
    "--filter=akeru-bot",
    "--parallel",
    "dev",
  ],
  "dev:server": ["run", "--filter=akeru-bot", "dev"],
  "dev:web": ["run", "--filter=@akeru/web", "dev"],
  "dev:desktop": ["run", "--filter=@akeru/desktop", "--filter=@akeru/web", "dev"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type DevMode = keyof typeof MODE_ARGS;

export const DEV_RUNNER_MODES = Object.keys(MODE_ARGS) as Array<DevMode>;

export function getDevRunnerModeArgs(mode: DevMode): ReadonlyArray<string> {
  return MODE_ARGS[mode];
}

export class DevRunnerConfigurationError extends Schema.TaggedErrorClass<DevRunnerConfigurationError>()(
  "DevRunnerConfigurationError",
  {
    configKeys: Schema.Array(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read dev-runner configuration: ${this.configKeys.join(", ")}.`;
  }
}

export class DevRunnerInvalidPortOffsetError extends Schema.TaggedErrorClass<DevRunnerInvalidPortOffsetError>()(
  "DevRunnerInvalidPortOffsetError",
  {
    configKey: Schema.Literal("T3CODE_PORT_OFFSET"),
    portOffset: Schema.Number,
    minimum: Schema.Number,
  },
) {
  override get message(): string {
    return `${this.configKey} must be at least ${this.minimum}; received ${this.portOffset}.`;
  }
}

export const optionalStringConfig = (name: string): Config.Config<string | undefined> =>
  Config.string(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const optionalBooleanConfig = (name: string): Config.Config<boolean | undefined> =>
  Config.boolean(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const optionalPortConfig = (name: string): Config.Config<number | undefined> =>
  Config.port(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

const optionalIntegerConfig = (name: string): Config.Config<number | undefined> =>
  Config.int(name).pipe(
    Config.option,
    Config.map((value) => Option.getOrUndefined(value)),
  );

export const OffsetConfig = Config.all({
  portOffset: optionalIntegerConfig("T3CODE_PORT_OFFSET"),
  devInstance: optionalStringConfig("T3CODE_DEV_INSTANCE"),
});

export function resolveOffset(config: {
  readonly portOffset: number | undefined;
  readonly devInstance: string | undefined;
  readonly worktreePath?: string | undefined;
}): Effect.Effect<
  { readonly offset: number; readonly source: string },
  DevRunnerInvalidPortOffsetError
> {
  if (config.portOffset !== undefined) {
    if (config.portOffset < 0) {
      return Effect.fail(
        new DevRunnerInvalidPortOffsetError({
          configKey: "T3CODE_PORT_OFFSET",
          portOffset: config.portOffset,
          minimum: 0,
        }),
      );
    }
    return Effect.succeed({
      offset: config.portOffset,
      source: `T3CODE_PORT_OFFSET=${config.portOffset}`,
    });
  }

  const seed = config.devInstance?.trim();
  if (seed) {
    if (/^\d+$/.test(seed)) {
      return Effect.succeed({
        offset: Number(seed),
        source: `numeric T3CODE_DEV_INSTANCE=${seed}`,
      });
    }

    const offset = ((Hash.string(seed) >>> 0) % MAX_HASH_OFFSET) + 1;
    return Effect.succeed({ offset, source: `hashed T3CODE_DEV_INSTANCE=${seed}` });
  }

  // Worktrees get ports derived from their path so each one is stable across
  // restarts and distinct from its siblings. Without this every worktree starts
  // at offset 0 and scan-collides onto whatever happens to be free that minute,
  // so ports move under you between runs — which breaks any URL you already
  // shared. The main checkout keeps the documented 5733/13773.
  const worktreePath = config.worktreePath?.trim();
  if (worktreePath) {
    const offset = ((Hash.string(worktreePath) >>> 0) % MAX_HASH_OFFSET) + 1;
    return Effect.succeed({ offset, source: `worktree ${worktreePath}` });
  }

  return Effect.succeed({ offset: 0, source: "default ports" });
}

function resolveBaseDir(baseDir: string | undefined): Effect.Effect<string, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const configured = baseDir?.trim();

    if (configured) {
      return path.resolve(configured);
    }

    return yield* DEFAULT_T3_HOME;
  });
}

interface CreateDevRunnerEnvInput {
  readonly mode: DevMode;
  readonly baseEnv: NodeJS.ProcessEnv;
  readonly serverOffset: number;
  readonly webOffset: number;
  readonly t3Home: string | undefined;
  readonly browser: boolean | undefined;
  readonly autoBootstrapProjectFromCwd: boolean | undefined;
  readonly logWebSocketEvents: boolean | undefined;
  readonly host: string | undefined;
  readonly port: number | undefined;
  readonly devUrl: URL | undefined;
}

export function createDevRunnerEnv({
  mode,
  baseEnv,
  serverOffset,
  webOffset,
  t3Home,
  browser,
  autoBootstrapProjectFromCwd,
  logWebSocketEvents,
  host,
  port,
  devUrl,
}: CreateDevRunnerEnvInput): Effect.Effect<NodeJS.ProcessEnv, never, Path.Path> {
  return Effect.gen(function* () {
    const serverPort = port ?? BASE_SERVER_PORT + serverOffset;
    const webPort = BASE_WEB_PORT + webOffset;
    // Precedence (--home-dir > worktree .akeru > ambient T3CODE_HOME) is resolved
    // by the caller; an unset t3Home here genuinely means "use the default".
    const configuredBaseDir = t3Home?.trim() || undefined;
    const resolvedBaseDir = yield* resolveBaseDir(configuredBaseDir);
    const isDesktopMode = mode === "dev:desktop";

    const output: NodeJS.ProcessEnv = {
      ...baseEnv,
      PORT: String(webPort),
      VITE_DEV_SERVER_URL:
        devUrl?.toString() ??
        `http://${isDesktopMode ? DESKTOP_DEV_LOOPBACK_HOST : "localhost"}:${webPort}`,
    };

    if (configuredBaseDir !== undefined) {
      output.T3CODE_HOME = resolvedBaseDir;
    } else {
      delete output.T3CODE_HOME;
    }

    // A dev-runner server is never launcher-managed. When the shell that runs
    // this script was itself spawned by the machine's managed t3 service (an
    // agent working inside T3 Code), these leak through and the child server
    // fails startup with "The service launcher started a different t3 version"
    // (serviceLauncherClient.ts resolveStartup).
    delete output.T3_SERVICE_LAUNCHER_CONTEXT;
    delete output.T3_BOOT_SERVICE_UNIT;

    if (!isDesktopMode) {
      output.T3CODE_PORT = String(serverPort);
      // HOST is Vite's own bind address, and the desktop branch below is the
      // only place we set it. An inherited one (an exported HOST, a container,
      // a `HOST=0.0.0.0 npm start` habit) would otherwise reach Vite and pin
      // its HMR socket to that address — see the `explicitHost` gate in
      // apps/web/vite.config.ts. Over a shared origin that is invisible: the
      // page loads and only HMR quietly dials the wrong machine.
      delete output.HOST;
      if (mode === "dev" || mode === "dev:web") {
        // Browser dev is single-origin: everything (including /ws) is proxied
        // through Vite, so the client must resolve its backend from
        // window.location.origin rather than a baked-in localhost URL. See
        // resolveConfiguredPrimaryTarget in apps/web/src/environments/primary/target.ts
        // — it only defers to the origin when both of these are absent. Baking
        // localhost here is what breaks any non-localhost origin (tailnet, LAN,
        // phone): the remote browser dials its own machine.
        delete output.VITE_HTTP_URL;
        delete output.VITE_WS_URL;
        // Deleting is not enough on its own: vite.config.ts calls loadRepoEnv,
        // which merges `.env`/`.env.local` *under* this env, so a developer
        // with either URL in their `.env` would get it back and silently lose
        // single-origin mode. This states the intent positively so Vite can
        // ignore those values rather than infer from their absence.
        output.T3CODE_SINGLE_ORIGIN_DEV = "1";
      } else {
        output.VITE_HTTP_URL = `http://localhost:${serverPort}`;
        output.VITE_WS_URL = `ws://localhost:${serverPort}`;
        delete output.T3CODE_SINGLE_ORIGIN_DEV;
      }
    } else {
      output.T3CODE_PORT = String(serverPort);
      output.VITE_HTTP_URL = `http://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      output.VITE_WS_URL = `ws://${DESKTOP_DEV_LOOPBACK_HOST}:${serverPort}`;
      // Desktop pins the renderer to loopback on purpose; an ambient marker
      // must not make Vite drop those URLs.
      delete output.T3CODE_SINGLE_ORIGIN_DEV;
      delete output.T3CODE_MODE;
      delete output.T3CODE_NO_BROWSER;
      delete output.T3CODE_HOST;
    }

    if (!isDesktopMode && host !== undefined) {
      output.T3CODE_HOST = host;
    }

    if (!isDesktopMode) {
      output.T3CODE_NO_BROWSER = browser === true ? "0" : "1";
    }

    if (autoBootstrapProjectFromCwd !== undefined) {
      output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD = autoBootstrapProjectFromCwd ? "1" : "0";
    } else {
      delete output.T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD;
    }

    if (logWebSocketEvents !== undefined) {
      output.T3CODE_LOG_WS_EVENTS = logWebSocketEvents ? "1" : "0";
    } else {
      delete output.T3CODE_LOG_WS_EVENTS;
    }

    if (mode === "dev") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (mode === "dev:server" || mode === "dev:web") {
      output.T3CODE_MODE = "web";
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    if (isDesktopMode) {
      output.HOST = DESKTOP_DEV_LOOPBACK_HOST;
      delete output.T3CODE_DESKTOP_WS_URL;
    }

    return output;
  });
}
