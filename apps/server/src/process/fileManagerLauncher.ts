import { type FileManagerRevealKind } from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { isCommandAvailable } from "@akeru/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
  type EditorLaunch,
  POWERSHELL_ARGUMENTS_PREFIX,
  readBrowserLaunchEnv,
  readCommandLookupEnv,
} from "./externalLauncherTypes.ts";
import {
  encodeUtf16LeBase64,
  escapePowerShellStringLiteral,
  resolvePowerShellPath,
  WSL_POWERSHELL_COMMAND,
  shouldUseWindowsHostFromWsl,
} from "./browserLauncher.ts";

export function hasGraphicalLinuxSession(env: NodeJS.ProcessEnv): boolean {
  return [env.DISPLAY, env.WAYLAND_DISPLAY].some(
    (value) => value !== undefined && value.trim().length > 0,
  );
}

export function fileManagerCommandForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  switch (platform) {
    case "darwin":
      return "open";
    case "win32":
      return "explorer";
    default:
      if (shouldUseWindowsHostFromWsl(platform, env)) {
        return env.WSL_DISTRO_NAME?.trim() ? "explorer.exe" : undefined;
      }

      return hasGraphicalLinuxSession(env) ? "xdg-open" : undefined;
  }
}

export // A graphical session variable plus an executable `xdg-open` does not prove
// that opening a directory does anything: without an `inode/directory` MIME
// handler, `xdg-open` exits nonzero after the launcher has already detached,
// so the client would see a silent no-op. Require the handler before
// advertising the file manager on Linux.
//
// The probe carries its own timeout well inside the scan timeout
// `server.getConfig` applies to editor discovery: that outer timeout degrades
// to an empty editor list, so a hung `xdg-mime` (broken D-Bus or desktop
// session) must cost only the file manager, not every discovered editor.
const LINUX_DIRECTORY_HANDLER_PROBE_TIMEOUT = "2 seconds";

export const hasUsableLinuxDirectoryHandler = Effect.fn(
  "externalLauncher.hasUsableLinuxDirectoryHandler",
)(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  boolean,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  if (!(yield* isCommandAvailable("xdg-mime", { env }))) {
    return false;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  return yield* spawner
    .spawn(
      ChildProcess.make("xdg-mime", ["query", "default", "inode/directory"], {
        stdin: "ignore",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.flatMap((handle) =>
        Effect.all([handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode], {
          concurrency: "unbounded",
        }),
      ),
      Effect.map(([stdout, exitCode]) => exitCode === 0 && stdout.trim().length > 0),
      Effect.scoped,
      Effect.timeout(LINUX_DIRECTORY_HANDLER_PROBE_TIMEOUT),
      Effect.orElseSucceed(() => false),
    );
});

export const isUsableFileManagerCommand = Effect.fn("externalLauncher.isUsableFileManagerCommand")(
  function* (
    command: string,
    env: NodeJS.ProcessEnv,
  ): Effect.fn.Return<
    boolean,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    if (!(yield* isCommandAvailable(command, { env }))) {
      return false;
    }

    return command !== "xdg-open" || (yield* hasUsableLinuxDirectoryHandler(env));
  },
);

export // The file-manager command a launch can actually run, not just the platform
// preference. WSL hosts prefer the Windows Explorer bridge, but interop can
// exist without `explorer.exe` on PATH (appendWindowsPath=false) or without a
// distro name while WSLg still provides a working Linux file manager, so they
// keep the `xdg-open` fallback instead of losing the editor entirely.
const resolveUsableFileManagerCommand = Effect.fn(
  "externalLauncher.resolveUsableFileManagerCommand",
)(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  string | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const command = fileManagerCommandForPlatform(platform, env);

  if (command !== undefined && (yield* isUsableFileManagerCommand(command, env))) {
    return command;
  }

  if (
    shouldUseWindowsHostFromWsl(platform, env) &&
    hasGraphicalLinuxSession(env) &&
    (yield* isUsableFileManagerCommand("xdg-open", env))
  ) {
    return "xdg-open";
  }

  return undefined;
});

export // Reveal on Windows and WSL runs through PowerShell (see
// resolveFileManagerRevealLaunch), not the `explorer` command that gates the
// file-manager editor itself, so the capability must probe the executables the
// reveal actually spawns. Callers gate on file-manager availability first;
// the Linux "files" kind relies on that gate for the directory-handler probe,
// while the WSL fallback re-probes because its availability may have come
// from the Explorer bridge instead.
const fileManagerRevealKindForPlatform = Effect.fn(
  "externalLauncher.fileManagerRevealKindForPlatform",
)(function* (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<
  FileManagerRevealKind | undefined,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  if (platform === "darwin") return "finder";

  if (platform === "win32") {
    return (yield* isCommandAvailable(resolvePowerShellPath(env), { env }))
      ? "file-explorer"
      : undefined;
  }

  if (shouldUseWindowsHostFromWsl(platform, env)) {
    if (
      env.WSL_DISTRO_NAME?.trim() &&
      (yield* isCommandAvailable("explorer.exe", { env })) &&
      (yield* isCommandAvailable(WSL_POWERSHELL_COMMAND, { env }))
    ) {
      return "file-explorer";
    }

    return hasGraphicalLinuxSession(env) && (yield* isUsableFileManagerCommand("xdg-open", env))
      ? "files"
      : undefined;
  }

  return hasGraphicalLinuxSession(env) ? "files" : undefined;
});

export function resolveWslFileManagerPath(target: string, distroName: string): string {
  const relativePath = target.replace(/^\/+/, "").replaceAll("/", "\\");

  return `\\\\wsl.localhost\\${distroName}${relativePath.length > 0 ? `\\${relativePath}` : ""}`;
}

export const resolveFileManagerRevealKind = Effect.fn(
  "externalLauncher.resolveFileManagerRevealKind",
)(function* () {
  const platform = yield* HostProcessPlatform;
  const env = { ...(yield* readBrowserLaunchEnv), ...(yield* readCommandLookupEnv) };

  return yield* fileManagerRevealKindForPlatform(platform, env);
});

/**
 * PowerShell source that launches File Explorer with its raw selection
 * switch. Explorer's contract is the single argument `/select,"<path>"` with
 * only the path quoted; Node's default spawn quoting wraps the whole argument
 * when the path has spaces and Explorer misparses it, silently opening a
 * fallback folder. A single `-ArgumentList` string in Windows PowerShell 5.1
 * reaches the child's command line verbatim, preserving the raw switch.
 *
 * Exported so the Windows smoke test can drive the identical source through a
 * real PowerShell against a recording stub instead of Explorer.
 */
export function buildFileExplorerRevealPowerShellSource(
  explorerCommand: string,
  target: string,
): string {
  return `$ProgressPreference = 'SilentlyContinue'; Start-Process ${escapePowerShellStringLiteral(explorerCommand)} -ArgumentList ('/select,"' + ${escapePowerShellStringLiteral(target)} + '"')`;
}

export function fileExplorerRevealLaunch(
  target: string,
  explorerTarget: string,
  powershellCommand: string,
): EditorLaunch {
  return {
    editor: "file-manager",
    target,
    command: powershellCommand,
    args: [
      ...POWERSHELL_ARGUMENTS_PREFIX,
      encodeUtf16LeBase64(buildFileExplorerRevealPowerShellSource("explorer.exe", explorerTarget)),
    ],
  };
}

export const resolveFileManagerRevealLaunch = Effect.fn("resolveFileManagerRevealLaunch")(
  function* (
    target: string,
    platform: NodeJS.Platform,
    env: NodeJS.ProcessEnv,
    // The command resolveUsableFileManagerCommand picked; a WSL host that fell
    // back to the Linux file manager must reveal through it as well.
    command: string,
  ): Effect.fn.Return<
    EditorLaunch,
    never,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
  > {
    if (platform === "darwin") {
      return { editor: "file-manager", target, command: "open", args: ["-R", target] };
    }

    if (platform === "win32") {
      return fileExplorerRevealLaunch(target, target, resolvePowerShellPath(env));
    }

    if (
      command === "explorer.exe" &&
      shouldUseWindowsHostFromWsl(platform, env) &&
      env.WSL_DISTRO_NAME !== undefined
    ) {
      const explorerTarget = resolveWslFileManagerPath(target, env.WSL_DISTRO_NAME);

      if (yield* isCommandAvailable(WSL_POWERSHELL_COMMAND, { env })) {
        // Explorer's raw switch cannot express a double quote, and unlike
        // Windows paths a WSL path may legally contain one: open the containing
        // directory in File Explorer instead, matching the advertised
        // "file-explorer" kind.
        if (explorerTarget.includes('"')) {
          const path = yield* Path.Path;

          return {
            editor: "file-manager",
            target,
            command: "explorer.exe",
            args: [resolveWslFileManagerPath(path.dirname(target), env.WSL_DISTRO_NAME)],
          };
        }

        return fileExplorerRevealLaunch(target, explorerTarget, WSL_POWERSHELL_COMMAND);
      }

      // Without interop PowerShell the capability advertised the Linux "files"
      // kind when it advertised anything at all, so the reveal must open the
      // Linux file manager the label promised, not File Explorer.
      if (hasGraphicalLinuxSession(env) && (yield* isUsableFileManagerCommand("xdg-open", env))) {
        const path = yield* Path.Path;

        return {
          editor: "file-manager",
          target,
          command: "xdg-open",
          args: [path.dirname(target)],
        };
      }

      // Nothing was advertised here; open the parent in File Explorer as the
      // best remaining effort for a stale client.
      const path = yield* Path.Path;

      return {
        editor: "file-manager",
        target,
        command: "explorer.exe",
        args: [resolveWslFileManagerPath(path.dirname(target), env.WSL_DISTRO_NAME)],
      };
    }

    // Linux file managers have no portable "select this file" flag, so open
    // the containing directory instead.
    const path = yield* Path.Path;

    return { editor: "file-manager", target, command, args: [path.dirname(target)] };
  },
);
