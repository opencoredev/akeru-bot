import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Context from "effect/Context";
import {
  WINDOWS_PATH_DELIMITER,
  type WindowsShellEnvironmentReader,
  readEnvironmentFromWindowsShell,
  mergePathValues,
  readEnvPath,
  readWindowsEnvironmentSafely,
  mergeWindowsEnv,
} from "./shell/environment.ts";
import { type CommandAvailabilityChecker, isCommandAvailable } from "./shell/commandResolution.ts";
import { resolveKnownWindowsCliDirs } from "./shell/windows.ts";

export const WindowsShellEnvironment = Context.Reference<WindowsShellEnvironmentReader>(
  "@akeru/shared/shell/WindowsShellEnvironment",
  {
    defaultValue: () => readEnvironmentFromWindowsShell,
  },
);

export const CommandAvailability = Context.Reference<CommandAvailabilityChecker>(
  "@akeru/shared/shell/CommandAvailability",
  {
    defaultValue: () => isCommandAvailable,
  },
);

export const resolveWindowsEnvironment = Effect.fn("shell.resolveWindowsEnvironment")(function* (
  env: NodeJS.ProcessEnv,
): Effect.fn.Return<Partial<NodeJS.ProcessEnv>, never, FileSystem.FileSystem | Path.Path> {
  const readEnvironment = yield* WindowsShellEnvironment;
  const commandAvailable = yield* CommandAvailability;
  const inheritedPath = readEnvPath(env);
  const shellPath = readWindowsEnvironmentSafely(readEnvironment, ["PATH"], {
    loadProfile: false,
  }).PATH;
  const mergedPath = mergePathValues(shellPath, inheritedPath, "win32");
  const knownCliPath = resolveKnownWindowsCliDirs(env).join(WINDOWS_PATH_DELIMITER);
  const baselinePath = mergePathValues(knownCliPath, mergedPath, "win32");
  const baselinePatch: Partial<NodeJS.ProcessEnv> = baselinePath ? { PATH: baselinePath } : {};
  const baselineEnv = mergeWindowsEnv(env, baselinePatch);

  if (yield* commandAvailable("node", { env: baselineEnv })) {
    return baselinePatch;
  }

  const profiledEnvironment = readWindowsEnvironmentSafely(
    readEnvironment,
    ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"],
    { loadProfile: true },
  );
  const profiledPath = mergePathValues(profiledEnvironment.PATH, baselinePath, "win32");
  const profiledPatch: Partial<NodeJS.ProcessEnv> = {
    ...(profiledPath ? { PATH: profiledPath } : {}),
    ...(profiledEnvironment.FNM_DIR ? { FNM_DIR: profiledEnvironment.FNM_DIR } : {}),
    ...(profiledEnvironment.FNM_MULTISHELL_PATH
      ? { FNM_MULTISHELL_PATH: profiledEnvironment.FNM_MULTISHELL_PATH }
      : {}),
  };
  return Object.keys(profiledPatch).length > 0
    ? { ...baselinePatch, ...profiledPatch }
    : baselinePatch;
});
export {
  type WindowsEnvironmentProbeOptions,
  listLoginShellCandidates,
  extractPathFromShellOutput,
  readPathFromLoginShell,
  readPathFromLaunchctl,
  mergePathEntries,
  type ShellEnvironmentReader,
  readEnvironmentFromLoginShell,
  type WindowsShellEnvironmentReader,
  readEnvironmentFromWindowsShell,
  mergePathValues,
} from "./shell/environment.ts";
export {
  type CommandAvailabilityOptions,
  type CommandAvailabilityChecker,
  CommandResolutionError,
  type ResolvedSpawnCommand,
  type SpawnExecutableResolver,
  SpawnExecutableResolution,
  CommandResolutionCache,
  resolveCommandPath,
  resolveSpawnCommand,
  isCommandAvailable,
} from "./shell/commandResolution.ts";
export { resolveKnownWindowsCliDirs } from "./shell/windows.ts";
