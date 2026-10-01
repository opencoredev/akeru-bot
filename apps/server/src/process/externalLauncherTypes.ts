import { type EditorId, type LaunchEditorInput } from "@akeru/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/unstable/process/ChildProcess";

// ==============================
// Definitions
// ==============================

export {
  ExternalLauncherError,
  ExternalLauncherBrowserSpawnError,
  ExternalLauncherCommandNotFoundError,
  ExternalLauncherEditorSpawnError,
  ExternalLauncherUnknownEditorError,
  ExternalLauncherUnsupportedEditorError,
  isExternalLauncherError,
} from "@akeru/contracts";

export type { LaunchEditorInput };

export interface EditorLaunch {
  readonly editor: EditorId;
  readonly target: string;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface ProcessLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
}

export interface TargetPathAndPosition {
  readonly path: string;
  readonly line: string;
  readonly column: Option.Option<string>;
}

export const TARGET_WITH_POSITION_PATTERN = /^(.*?):(\d+)(?::(\d+))?$/;

export const POWERSHELL_ARGUMENTS_PREFIX = [
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-EncodedCommand",
] as const;

export const DETACHED_IGNORE_STDIO_OPTIONS = {
  detached: true,
  stdin: "ignore",
  stdout: "ignore",
  stderr: "ignore",
} as const satisfies ChildProcess.CommandOptions;

export const compactEnv = (input: Record<string, Option.Option<string>>): NodeJS.ProcessEnv =>
  Object.fromEntries(
    Object.entries(input).flatMap(([key, value]) =>
      Option.match(value, {
        onNone: () => [],
        onSome: (resolved) => [[key, resolved]],
      }),
    ),
  );

export const BrowserLaunchEnvConfig = Config.all({
  SYSTEMROOT: Config.string("SYSTEMROOT").pipe(Config.option),
  windir: Config.string("windir").pipe(Config.option),
  WSL_DISTRO_NAME: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
  WSL_INTEROP: Config.string("WSL_INTEROP").pipe(Config.option),
  SSH_CONNECTION: Config.string("SSH_CONNECTION").pipe(Config.option),
  SSH_TTY: Config.string("SSH_TTY").pipe(Config.option),
  container: Config.string("container").pipe(Config.option),
  DISPLAY: Config.string("DISPLAY").pipe(Config.option),
  WAYLAND_DISPLAY: Config.string("WAYLAND_DISPLAY").pipe(Config.option),
}).pipe(Config.map(compactEnv));

export const CommandLookupEnvConfig = Config.all({
  PATH: Config.string("PATH").pipe(Config.option),
  Path: Config.string("Path").pipe(Config.option),
  path: Config.string("path").pipe(Config.option),
  PATHEXT: Config.string("PATHEXT").pipe(Config.option),
}).pipe(Config.map(compactEnv));

export const readBrowserLaunchEnv = BrowserLaunchEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

export const readCommandLookupEnv = CommandLookupEnvConfig.pipe(Effect.orElseSucceed(() => ({})));

// Editor discovery walks PATH for every known editor and runs for every
// client connect (the server config embeds the available editors). Memoize
// the discovered set for a bounded window so repeat connects skip even the
// per-command cache lookups in @akeru/shared/shell.
//
// This deliberately does not use `Effect.cachedWithTTL`: that memoizes the
// first caller's Exit whatever it is, including an interrupt. Callers run this
// on the connection fiber under a timeout (`resolveAvailableEditorsForConfig`),
// so one client disconnecting mid-scan would cache the interrupt and replay it
// to every later connect for the whole TTL, breaking `server.getConfig`
// permanently. Storing only on success means an interrupted scan leaves the
// cache untouched and the next connect simply rescans.
// Expiry uses the monotonic clock (Clock.currentTimeNanos), matching the
// command-resolution cache in @akeru/shared/shell, so a backward wall-clock
// adjustment cannot keep an expired entry alive.
export const EDITOR_DISCOVERY_CACHE_TTL_NANOS = 60_000_000_000n;

export interface EditorDiscoveryCacheEntry {
  readonly editors: ReadonlyArray<EditorId>;
  readonly expiresAtNanos: bigint;
}
