/**
 * How a Claude Code login instance starts Claude Code: which program, which
 * environment, and which adapter options. The driver and its tests share this,
 * so the tests check the exact environment a real session gets.
 *
 * @module provider/claudeCode/ClaudeCodeSession
 */
import {
  type ClaudeSettings,
  defaultInstanceIdForDriver,
  type ProviderInstanceEnvironment,
  type ProviderInstanceId,
} from "@akeru/contracts";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { resolveCommandPath } from "@akeru/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { mergeSubscriptionInstanceEnvironment } from "../../subscription-auth/runtime.ts";
import { resolveClaudeSdkExecutablePath } from "../Drivers/ClaudeExecutable.ts";
import type { ClaudeAdapterLiveOptions } from "../Layers/ClaudeAdapter.ts";
import { claudeChildHomeDirectory } from "../Layers/claude/ClaudeChildHome.ts";
import {
  CLAUDE_CODE_DRIVER_KIND,
  CLAUDE_CODE_PATH_ENV,
  claudeCodeCommand,
  claudeCodeLoginEnvironment,
} from "./ClaudeCodeLogin.ts";

/**
 * The account's CLAUDE_CONFIG_DIR as one absolute path: its config path, then
 * its own CLAUDE_CONFIG_DIR variable, then the folder the server assigned it.
 * `~` and relative values are taken from the user's home, never from the
 * server's working folder, so the probe, the session, and the policy all see
 * the same folder. `published` is false when the folder came from a
 * sensitive variable, which stays on the server.
 */
export const claudeCodeConfigDirectory = Effect.fn("claudeCodeConfigDirectory")(function* (
  settings: Pick<ClaudeSettings, "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  homeDirectory: string,
  assignedDirectory?: string,
) {
  const path = yield* Path.Path;
  const homePath = settings.homePath.trim();

  const variable = homePath
    ? undefined
    : instanceEnvironment?.findLast(({ name }) => name === "CLAUDE_CONFIG_DIR");

  const raw = homePath || variable?.value.trim() || assignedDirectory;

  if (!raw) return undefined;

  const expanded =
    raw === "~" || raw.startsWith("~/") || raw.startsWith("~\\")
      ? path.join(homeDirectory, raw.slice(1))
      : raw;

  return {
    directory: path.isAbsolute(expanded)
      ? path.resolve(expanded)
      : path.resolve(homeDirectory, expanded),
    published: !(variable?.sensitive && variable.value.trim()),
  };
});

/**
 * The folder the server gives a separate Claude Agent account that names
 * none, so it never shares the default account's login. The default
 * `claudeCode` instance keeps Claude Code's own default folder.
 */
export const claudeCodeAssignedConfigDirectory = Effect.fn("claudeCodeAssignedConfigDirectory")(
  function* (instanceId: ProviderInstanceId, stateDir: string) {
    const path = yield* Path.Path;

    return instanceId === defaultInstanceIdForDriver(CLAUDE_CODE_DRIVER_KIND)
      ? undefined
      : path.join(stateDir, "providers", "claude-code", instanceId);
  },
);

/**
 * The program clients may show for an instance: the command when it is not
 * plain `claude`, unless it came from the account's own sensitive
 * AKERU_CLAUDE_PATH variable, which stays on the server.
 */
function publishedExecutable(
  settings: Pick<ClaudeSettings, "binaryPath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (command === "claude") return undefined;

  const configured = settings.binaryPath.trim();

  if (configured.length > 0 && configured !== "claude") return command;

  // The same row the command came from: on Windows any spelling, the last one winning.
  const variable = instanceEnvironment?.findLast(({ name }) =>
    platform === "win32"
      ? name.toUpperCase() === CLAUDE_CODE_PATH_ENV
      : name === CLAUDE_CODE_PATH_ENV,
  );

  return variable?.sensitive ? undefined : command;
}

/**
 * Windows variable names are case-insensitive, so one name per variable, in uppercase, is all the
 * server reads and all Claude Code receives. Inherited spellings resolve as Node's spawn does (first
 * in sorted order), then the account's rows override them, the last row winning, as the login card
 * reads them.
 */
function windowsEnvironment(
  merged: NodeJS.ProcessEnv,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") return merged;
  const accountNames = new Set((instanceEnvironment ?? []).map(({ name }) => name));
  const result: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(merged).toSorted(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )) {
    const key = name.toUpperCase();

    if (!accountNames.has(name) && !(key in result)) result[key] = value;
  }

  for (const { name } of instanceEnvironment ?? []) {
    const value = merged[name];

    if (value !== undefined) result[name.toUpperCase()] = value;
  }

  return result;
}

/**
 * The command, environment, and config folder for one instance. The command
 * reads `AKERU_CLAUDE_PATH` from the full environment, the server's included;
 * Claude Code itself gets only the allowlisted variables, plus the account's
 * own CLAUDE_CONFIG_DIR. An inherited CLAUDE_CONFIG_DIR is dropped.
 * `executable` is the command as clients may quote it in the login step.
 */
export const claudeCodeInstanceEnvironment = Effect.fn("claudeCodeInstanceEnvironment")(function* (
  settings: Pick<ClaudeSettings, "binaryPath" | "homePath">,
  instanceEnvironment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
  assignedConfigDirectory?: string,
) {
  const platform = yield* HostProcessPlatform;

  const merged = windowsEnvironment(
    mergeSubscriptionInstanceEnvironment(instanceEnvironment, baseEnv),
    instanceEnvironment,
    platform,
  );

  const homeDirectory = claudeChildHomeDirectory(merged, platform);

  const folder = yield* claudeCodeConfigDirectory(
    settings,
    instanceEnvironment,
    homeDirectory,
    assignedConfigDirectory,
  );

  const configDirectory = folder?.directory;
  const command = claudeCodeCommand(settings, merged);
  const executable = publishedExecutable(settings, instanceEnvironment, command, platform);

  return {
    command,
    ...(executable ? { executable } : {}),
    configDirectory,
    ...(folder?.published ? { publishedConfigDirectory: folder.directory } : {}),
    environment: claudeCodeLoginEnvironment(merged, { claudeConfigDirectory: configDirectory }),
  };
});

/** Adapter options for a Claude Code login instance. */
export const claudeCodeAdapterOptions = Effect.fn("claudeCodeAdapterOptions")(function* (input: {
  readonly instanceId: ProviderInstanceId;
  readonly command: string;
  readonly loginEnvironment: NodeJS.ProcessEnv;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const command = input.command;

  // The SDK spawns the path directly, so a Windows `claude.cmd` shim is
  // followed to the packaged binary the way the API-key adapter does it.
  const resolveExecutablePath = resolveCommandPath(command, { env: input.loginEnvironment }).pipe(
    Effect.orElseSucceed(() => command),
    Effect.flatMap((found) => resolveClaudeSdkExecutablePath(found, input.loginEnvironment)),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  return {
    command,
    options: {
      instanceId: input.instanceId,
      driverKind: CLAUDE_CODE_DRIVER_KIND,
      environment: input.loginEnvironment,
      resolveExecutablePath,
      sessionEnvironment: Effect.succeed(input.loginEnvironment),
      enforceBotPermissionPolicy: true,
      isolateClaudeSettings: true,
    } satisfies ClaudeAdapterLiveOptions,
  };
});
