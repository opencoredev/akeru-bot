import * as Context from "effect/Context";

import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Option from "effect/Option";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import * as Stream from "effect/Stream";

import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

import { parseWslDistroList, type WslDistro } from "./wslPathParsing.ts";

import {
  PROCESS_TERMINATE_GRACE,
  type EnsureWslNodePtyOptions,
  buildDistroArgs,
  concatChunks,
  decodeUtf8,
} from "./WslShell.ts";

import { type EnsureWslNodePtyResult, ensureNodePtyImpl } from "./WslNodePty.ts";

export {
  type EnsureWslNodePtyResult,
  formatNodePtyProbeFailureReason,
  type ToolchainReport,
  parseToolchainReport,
  parseNodePath,
  parseNodeVersion,
  parseResolvedPath,
  formatMissingToolsReason,
} from "./WslNodePty.ts";

export {
  type EnsureWslNodePtyOptions,
  formatWslShellTransportFailureReason,
  buildWslNodeEnvPreamble,
} from "./WslShell.ts";

const LIST_TIMEOUT = Duration.seconds(8);

const PRE_WARM_TIMEOUT = Duration.seconds(10);

const WSLPATH_TIMEOUT = Duration.seconds(10);

const USER_HOME_TIMEOUT = Duration.seconds(5);

export class DesktopWslDistroListError extends Schema.TaggedErrorClass<DesktopWslDistroListError>()(
  "DesktopWslDistroListError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const isDesktopWslDistroListError = Schema.is(DesktopWslDistroListError);

export class DesktopWslEnvironment extends Context.Service<
  DesktopWslEnvironment,
  {
    readonly isAvailable: Effect.Effect<boolean>;
    // Best-effort enumeration for renderer UX. Backend health checks must use
    // probeDistros so a transient command failure is not mistaken for a
    // successful empty installation.
    readonly listDistros: Effect.Effect<readonly WslDistro[]>;
    readonly probeDistros: Effect.Effect<readonly WslDistro[], DesktopWslDistroListError>;
    readonly preWarm: (distro: string | null) => Effect.Effect<void>;
    readonly windowsToWslPath: (
      distro: string | null,
      windowsPath: string,
    ) => Effect.Effect<Option.Option<string>>;
    // Resolves the user's Linux home dir inside the chosen distro (e.g.
    // "/home/josh"). Used by the folder picker to expand `~` correctly.
    readonly getUserHome: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    // Resolves the WSL distro's IPv4 address on the WSL vEthernet adapter
    // (e.g. "172.x.x.x"). The orchestrator uses this for the WSL backend's
    // httpBaseUrl so the renderer can reach it without relying on wslhost's
    // localhost→WSL automatic forwarding, which is flaky in practice
    // (the backend can be listening for 30+ seconds before wslhost starts
    // forwarding 127.0.0.1:port to WSL-side localhost).
    readonly getDistroIp: (distro: string | null) => Effect.Effect<Option.Option<string>>;
    readonly ensureNodePty: (
      distro: string | null,
      windowsRepoRoot: string,
      options?: EnsureWslNodePtyOptions,
    ) => Effect.Effect<EnsureWslNodePtyResult>;
  }
>()("@akeru/desktop/wsl/DesktopWslEnvironment") {}

export const probeWslDistros: Effect.Effect<
  readonly WslDistro[],
  DesktopWslDistroListError,
  ChildProcessSpawner.ChildProcessSpawner
> = Effect.scoped(
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const command = ChildProcess.make("wsl.exe", ["--list", "--verbose"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      killSignal: "SIGTERM",
      forceKillAfter: PROCESS_TERMINATE_GRACE,
    });
    const handle = yield* spawner.spawn(command);
    const stdoutBytes = yield* Stream.runCollect(handle.stdout);
    const exitCode = yield* handle.exitCode;
    if (exitCode !== 0) {
      return yield* new DesktopWslDistroListError({
        reason: `wsl.exe --list --verbose exited with code ${String(exitCode)}`,
      });
    }
    return parseWslDistroList(Buffer.from(concatChunks(stdoutBytes)));
  }),
).pipe(
  Effect.mapError((error) =>
    isDesktopWslDistroListError(error)
      ? error
      : new DesktopWslDistroListError({
          reason: `Failed to run wsl.exe --list --verbose: ${error.message}`,
        }),
  ),
  Effect.timeoutOption(LIST_TIMEOUT),
  Effect.flatMap(
    Option.match({
      onNone: () =>
        new DesktopWslDistroListError({
          reason: "wsl.exe --list --verbose timed out",
        }),
      onSome: Effect.succeed,
    }),
  ),
);

const preWarmImpl = (
  distro: string | null,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make("wsl.exe", [...buildDistroArgs(distro), "--", "true"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        killSignal: "SIGTERM",
        forceKillAfter: PROCESS_TERMINATE_GRACE,
      });
      const handle = yield* spawner.spawn(command);
      yield* handle.exitCode;
    }),
  ).pipe(
    Effect.timeoutOption(PRE_WARM_TIMEOUT),
    Effect.asVoid,
    Effect.catch(() => Effect.void),
  );

const windowsToWslPathImpl = (
  distro: string | null,
  windowsPath: string,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> => {
  // wsl.exe interprets backslashes as escape chars; normalize to forward slashes.
  const normalized = windowsPath.replaceAll("\\", "/");
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "wslpath", "-u", normalized],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if (exitCode !== 0) return Option.none<string>();
      const converted = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return converted.length > 0 ? Option.some(converted) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(WSLPATH_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
};

const IPV4_PATTERN = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

const getDistroIpImpl = (
  distro: string | null,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      // `hostname -I` prints a space-separated list of all non-loopback
      // IPs the distro has bound. The first entry on the WSL2 default
      // network is always the eth0 vEthernet address Windows can reach
      // directly (no wslhost forwarding required).
      const command = ChildProcess.make(
        "wsl.exe",
        [...buildDistroArgs(distro), "--", "sh", "-c", "hostname -I"],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if (exitCode !== 0) return Option.none<string>();
      const raw = decodeUtf8(concatChunks(stdoutBytes)).trim();
      const candidate = raw.split(/\s+/).find((part) => IPV4_PATTERN.test(part));
      return candidate ? Option.some(candidate) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const getUserHomeImpl = (
  distro: string | null,
): Effect.Effect<Option.Option<string>, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const command = ChildProcess.make(
        "wsl.exe",
        // printf so there's no trailing newline noise; getent so we get the
        // real home from /etc/passwd even if $HOME is unset for some reason.
        [
          ...buildDistroArgs(distro),
          "--",
          "sh",
          "-c",
          'printf "%s" "$(getent passwd "$(id -un)" | cut -d: -f6)"',
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "ignore",
          killSignal: "SIGTERM",
          forceKillAfter: PROCESS_TERMINATE_GRACE,
        },
      );
      const handle = yield* spawner.spawn(command);
      const stdoutBytes = yield* Stream.runCollect(handle.stdout);
      const exitCode = yield* handle.exitCode;
      if (exitCode !== 0) return Option.none<string>();
      const home = decodeUtf8(concatChunks(stdoutBytes)).trim();
      return home.startsWith("/") ? Option.some(home) : Option.none<string>();
    }),
  ).pipe(
    Effect.timeoutOption(USER_HOME_TIMEOUT),
    Effect.map(Option.flatten),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

const makeIsAvailable = (
  platform: NodeJS.Platform,
  windir: string,
): Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (platform !== "win32") return false;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const wslExePath = path.join(windir, "System32", "wsl.exe");
    return yield* fileSystem.exists(wslExePath).pipe(Effect.orElseSucceed(() => false));
  });

export interface DesktopWslEnvironmentTestStub {
  readonly isAvailable?: boolean;
  readonly distros?: ReadonlyArray<WslDistro>;
  readonly distroListError?: DesktopWslDistroListError;
  readonly windowsToWslPath?: (distro: string | null, windowsPath: string) => Option.Option<string>;
  readonly getUserHome?: (distro: string | null) => Option.Option<string>;
  readonly getDistroIp?: (distro: string | null) => Option.Option<string>;
  readonly ensureNodePty?: (
    distro: string | null,
    windowsRepoRoot: string,
    options?: EnsureWslNodePtyOptions,
  ) => EnsureWslNodePtyResult;
}

export const layerTest = (stub: DesktopWslEnvironmentTestStub = {}) => {
  const probeDistros = stub.distroListError
    ? Effect.fail(stub.distroListError)
    : Effect.succeed(stub.distros ?? []);
  return Layer.succeed(
    DesktopWslEnvironment,
    DesktopWslEnvironment.of({
      isAvailable: Effect.succeed(stub.isAvailable ?? false),
      listDistros: probeDistros.pipe(Effect.orElseSucceed(() => [])),
      probeDistros,
      preWarm: () => Effect.void,
      windowsToWslPath: (distro, windowsPath) =>
        Effect.succeed(stub.windowsToWslPath?.(distro, windowsPath) ?? Option.none()),
      getUserHome: (distro) => Effect.succeed(stub.getUserHome?.(distro) ?? Option.none<string>()),
      getDistroIp: (distro) => Effect.succeed(stub.getDistroIp?.(distro) ?? Option.none<string>()),
      ensureNodePty: (distro, windowsRepoRoot, options) =>
        Effect.succeed(
          stub.ensureNodePty?.(distro, windowsRepoRoot, options) ?? {
            ok: false,
            reason: "ensureNodePty stub not configured",
            fatal: true,
          },
        ),
    }),
  );
};

export const layer = Layer.effect(
  DesktopWslEnvironment,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const windir = process.env.WINDIR ?? "C:\\Windows";

    const provideSpawner = <A, E>(
      effect: Effect.Effect<A, E, ChildProcessSpawner.ChildProcessSpawner>,
    ): Effect.Effect<A, E> =>
      effect.pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    // Probe wsl.exe once at layer init and cache the result, exposing
    // `isAvailable` as a resolved value rather than a re-running effect.
    // WSL availability is effectively static for the process lifetime — the
    // Windows feature isn't added/removed mid-session, and backend mode
    // changes already require an app restart — so the cached boolean stays
    // accurate. Crucially this keeps `isAvailable` synchronously resolvable:
    // it's read inside the sync IPC handler getLocalEnvironmentBootstraps
    // (via the primary instance's lazy label -> resolvePrimaryLabel ->
    // describePrimary). The underlying probe does a filesystem `exists`
    // check, so leaving it as a live effect would make Effect.runSync throw
    // there and break the renderer's synchronous bootstrap path.
    const wslAvailable = yield* makeIsAvailable(environment.platform, windir).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, environment.path),
      Effect.withSpan("desktop.wsl.isAvailable"),
    );
    const isAvailable = Effect.succeed(wslAvailable);

    const windowsToWslPath = (distro: string | null, windowsPath: string) =>
      provideSpawner(windowsToWslPathImpl(distro, windowsPath)).pipe(
        Effect.withSpan("desktop.wsl.windowsToWslPath"),
      );

    // Cache user-home results per distro key — folder picker can be opened
    // many times in a session and the value is stable for the life of the
    // distro. Negative results aren't cached so a transient wsl.exe failure
    // doesn't permanently disable tilde expansion.
    const userHomeCache = new Map<string, string>();
    const getUserHome = (distro: string | null) =>
      Effect.gen(function* () {
        const key = distro ?? "__default__";
        const cached = userHomeCache.get(key);
        if (cached !== undefined) return Option.some(cached);
        const resolved = yield* provideSpawner(getUserHomeImpl(distro));
        if (Option.isSome(resolved)) userHomeCache.set(key, resolved.value);
        return resolved;
      }).pipe(Effect.withSpan("desktop.wsl.getUserHome"));

    const getDistroIp = (distro: string | null) =>
      provideSpawner(getDistroIpImpl(distro)).pipe(Effect.withSpan("desktop.wsl.getDistroIp"));

    const probeDistros = provideSpawner(probeWslDistros).pipe(
      Effect.withSpan("desktop.wsl.probeDistros"),
    );

    return DesktopWslEnvironment.of({
      isAvailable,
      listDistros: probeDistros.pipe(
        Effect.orElseSucceed(() => []),
        Effect.withSpan("desktop.wsl.listDistros"),
      ),
      probeDistros,
      preWarm: (distro) =>
        provideSpawner(preWarmImpl(distro)).pipe(Effect.withSpan("desktop.wsl.preWarm")),
      windowsToWslPath,
      getUserHome,
      getDistroIp,
      ensureNodePty: (distro, windowsRepoRoot, options) =>
        provideSpawner(ensureNodePtyImpl(distro, windowsRepoRoot, windowsToWslPath, options)).pipe(
          Effect.withSpan("desktop.wsl.ensureNodePty"),
        ),
    });
  }),
);
