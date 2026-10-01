import * as Context from "effect/Context";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import {
  type ShellEnvironmentConfig,
  WINDOWS_PROFILE_ENV_NAMES,
  mergePaths,
  trimNonEmpty,
  knownWindowsCliDirs,
  readEnvPath,
  type EnvironmentPatch,
  listLoginShellCandidates,
  LOGIN_SHELL_ENV_NAMES,
  LOCALE_ENV_NAMES,
  FALLBACK_LC_CTYPE,
  linuxRuntimeDirCandidates,
} from "./ShellEnvironmentPolicy.ts";
import {
  readWindowsEnvironment,
  readLoginShellEnvironment,
  readLaunchctlPath,
} from "./ShellEnvironmentProbe.ts";

export { resolveDefaultLinuxDbusSessionBusAddress } from "./ShellEnvironmentPolicy.ts";

export { DesktopShellEnvironmentCommandError } from "./ShellEnvironmentProbe.ts";

export { DesktopShellEnvironmentCommandTimeoutError } from "./ShellEnvironmentProbe.ts";

export class DesktopShellEnvironment extends Context.Service<
  DesktopShellEnvironment,
  {
    readonly installIntoProcess: Effect.Effect<void>;
  }
>()("@akeru/desktop/shell/DesktopShellEnvironment") {}

const installWindowsEnvironment = Effect.fn("desktop.shellEnvironment.installWindowsEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<void, never, ChildProcessSpawner.ChildProcessSpawner> {
    // Concurrent, not sequential: these two probes are independent (only their
    // results are combined below) and each spawns its own PowerShell. Run in
    // series they sit at offset 0 of desktop.startup, before anything else, and
    // launch traces measured them at 2718ms then 2066ms — the entire 4.8s
    // startup span, of which desktop.bootstrap is ~30ms.
    const [noProfile, profile] = yield* Effect.all(
      [
        readWindowsEnvironment(["PATH"], { loadProfile: false }),
        readWindowsEnvironment(WINDOWS_PROFILE_ENV_NAMES, { loadProfile: true }),
      ],
      { concurrency: 2 },
    );

    const mergedPath = mergePaths("win32", [
      trimNonEmpty(profile.PATH),
      trimNonEmpty(knownWindowsCliDirs(config.env).join(";")),
      trimNonEmpty(noProfile.PATH),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }

    if (!config.env.FNM_DIR && profile.FNM_DIR) {
      config.env.FNM_DIR = profile.FNM_DIR;
    }

    if (!config.env.FNM_MULTISHELL_PATH && profile.FNM_MULTISHELL_PATH) {
      config.env.FNM_MULTISHELL_PATH = profile.FNM_MULTISHELL_PATH;
    }
  },
);

const installPosixEnvironment = Effect.fn("desktop.shellEnvironment.installPosixEnvironment")(
  function* (
    config: ShellEnvironmentConfig,
  ): Effect.fn.Return<
    void,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem
  > {
    const fileSystem = yield* FileSystem.FileSystem;
    const shellEnvironment: EnvironmentPatch = {};

    for (const shell of listLoginShellCandidates(config)) {
      Object.assign(
        shellEnvironment,
        yield* readLoginShellEnvironment(shell, LOGIN_SHELL_ENV_NAMES),
      );

      if (shellEnvironment.PATH) break;
    }

    const launchctlPath =
      config.platform === "darwin" && !shellEnvironment.PATH
        ? yield* readLaunchctlPath
        : Option.none<string>();

    const mergedPath = mergePaths(config.platform, [
      trimNonEmpty(shellEnvironment.PATH).pipe(Option.orElse(() => launchctlPath)),
      readEnvPath(config.env),
    ]);

    if (Option.isSome(mergedPath)) {
      config.env.PATH = mergedPath.value;
    }

    if (!config.env.SSH_AUTH_SOCK && shellEnvironment.SSH_AUTH_SOCK) {
      config.env.SSH_AUTH_SOCK = shellEnvironment.SSH_AUTH_SOCK;
    }

    const shellPreferredEnvNames = [
      "DBUS_SESSION_BUS_ADDRESS",
      "XDG_CURRENT_DESKTOP",
      "XDG_SESSION_DESKTOP",
      "XDG_SESSION_TYPE",
    ] as const;

    for (const name of shellPreferredEnvNames) {
      if (shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    for (const name of [
      "DISPLAY",
      "HOMEBREW_PREFIX",
      "HOMEBREW_CELLAR",
      "HOMEBREW_REPOSITORY",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "WAYLAND_DISPLAY",
    ] as const) {
      if (!config.env[name] && shellEnvironment[name]) {
        config.env[name] = shellEnvironment[name];
      }
    }

    // Locale variables form one precedence group: LC_ALL can override an inherited
    // LANG or LC_CTYPE, so only hydrate the group when the process has none of them.
    if (
      config.platform === "darwin" &&
      LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))
    ) {
      for (const name of LOCALE_ENV_NAMES) {
        const value = trimNonEmpty(shellEnvironment[name]);

        if (Option.isSome(value)) {
          config.env[name] = value.value;
        }
      }

      // GUI launches inherit no locale from launchd, so spawned agents land in the C
      // locale and pbcopy decodes their UTF-8 output as MacRoman. Older supported
      // macOS releases do not provide C.UTF-8, so set only LC_CTYPE to a UTF-8 locale
      // available on those releases. Leaving LANG unset keeps C-stable collation and
      // formatting, so output parsing is unaffected.
      if (LOCALE_ENV_NAMES.every((name) => Option.isNone(trimNonEmpty(config.env[name])))) {
        config.env.LC_CTYPE = FALLBACK_LC_CTYPE;
      }
    }

    if (
      config.platform === "linux" &&
      Option.isNone(trimNonEmpty(config.env.DBUS_SESSION_BUS_ADDRESS))
    ) {
      for (const runtimeDir of linuxRuntimeDirCandidates(config.env, process.getuid?.())) {
        const dbusSessionBusPath = `${runtimeDir}/bus`;

        const busExists = yield* fileSystem
          .exists(dbusSessionBusPath)
          .pipe(Effect.orElseSucceed(() => false));

        if (busExists) {
          config.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${dbusSessionBusPath}`;
          break;
        }
      }
    }
  },
);

const installShellEnvironment = (
  config: ShellEnvironmentConfig,
): Effect.Effect<void, never, ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem> => {
  if (config.platform === "win32") {
    return installWindowsEnvironment(config);
  }

  if (config.platform === "darwin" || config.platform === "linux") {
    return installPosixEnvironment(config);
  }

  return Effect.void;
};

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const installIntoProcess: DesktopShellEnvironment["Service"]["installIntoProcess"] =
    installShellEnvironment({
      env: process.env,
      platform: environment.platform,
      userShell: Option.none(),
    }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.withSpan("desktop.shellEnvironment.installIntoProcess"),
    );

  return DesktopShellEnvironment.of({ installIntoProcess });
});

export const layer = Layer.effect(DesktopShellEnvironment, make);
