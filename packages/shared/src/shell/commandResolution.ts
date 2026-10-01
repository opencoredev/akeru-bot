// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeFS from "node:fs";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HostProcessEnvironment, HostProcessPlatform } from "../hostProcess.ts";
import * as Context from "effect/Context";
import {
  stripWrappingQuotes,
  pathDelimiterForPlatform,
  readEnvPath,
  resolvePathEnvironmentVariable,
} from "./environment.ts";
import { escapeWindowsShellArg, sanitizeShellModeArgsForPlatform } from "./windows.ts";

function canExecuteFile(filePath: string): boolean {
  try {
    NodeFS.accessSync(filePath, NodeFS.constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

export interface CommandAvailabilityOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly extendEnv?: boolean;
}

export type CommandAvailabilityChecker = (
  command: string,
  options?: CommandAvailabilityOptions,
) => Effect.Effect<boolean, never, FileSystem.FileSystem | Path.Path>;

export class CommandResolutionError extends Data.TaggedError("CommandResolutionError")<{
  readonly command: string;
  readonly reason: "not-found";
}> {}

export interface ResolvedSpawnCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly shell: boolean;
}

export type SpawnExecutableResolver = (
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
) => string | undefined;

function resolveSpawnExecutableWithNode(
  command: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const path = platform === "win32" ? NodePath.win32 : NodePath.posix;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];

  const candidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );

  const isExecutable = (candidate: string) => {
    try {
      if (!NodeFS.statSync(candidate).isFile()) return false;

      if (platform === "win32") {
        return windowsPathExtensions.includes(path.extname(candidate).toUpperCase());
      }

      return canExecuteFile(candidate);
    } catch {
      return false;
    }
  };

  if (command.includes("/") || command.includes("\\")) {
    return candidates.find(isExecutable);
  }

  for (const pathEntry of (readEnvPath(env) ?? "").split(pathDelimiterForPlatform(platform))) {
    const normalizedPathEntry = stripWrappingQuotes(pathEntry.trim());

    if (normalizedPathEntry.length === 0) continue;

    for (const candidate of candidates) {
      const candidatePath = path.join(normalizedPathEntry, candidate);

      if (isExecutable(candidatePath)) return candidatePath;
    }
  }

  return undefined;
}

export const SpawnExecutableResolution = Context.Reference<SpawnExecutableResolver>(
  "@akeru/shared/shell/SpawnExecutableResolution",
  {
    defaultValue: () => resolveSpawnExecutableWithNode,
  },
);

function resolveWindowsPathExtensions(env: NodeJS.ProcessEnv): ReadonlyArray<string> {
  const rawValue = env.PATHEXT;
  const fallback = [".COM", ".EXE", ".BAT", ".CMD"];

  if (!rawValue) return fallback;

  const parsed: string[] = [];

  for (const entry of rawValue.split(";")) {
    const trimmed = entry.trim();

    if (trimmed.length === 0) continue;
    parsed.push(trimmed.startsWith(".") ? trimmed.toUpperCase() : `.${trimmed.toUpperCase()}`);
  }

  return parsed.length > 0 ? Array.from(new Set(parsed)) : fallback;
}

function resolveCommandCandidates(
  command: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
  extname: (path: string) => string,
): ReadonlyArray<string> {
  if (platform !== "win32") return [command];
  const extension = extname(command);
  const normalizedExtension = extension.toUpperCase();

  if (extension.length > 0 && windowsPathExtensions.includes(normalizedExtension)) {
    const commandWithoutExtension = command.slice(0, -extension.length);

    return Array.from(
      new Set([
        command,
        `${commandWithoutExtension}${normalizedExtension}`,
        `${commandWithoutExtension}${normalizedExtension.toLowerCase()}`,
      ]),
    );
  }

  const candidates: string[] = [];

  for (const candidateExtension of windowsPathExtensions) {
    candidates.push(`${command}${candidateExtension}`);
    candidates.push(`${command}${candidateExtension.toLowerCase()}`);
  }

  return Array.from(new Set(candidates));
}

// Session bootstrap resolves the same commands over and over, each PATH scan
// costing hundreds of 'shell.isExecutableFile' filesystem probes (tens of
// thousands per connect). Memoize the scan outcome per
// (platform, PATH, PATHEXT, command) for a short window: repeat scans hit the
// cache while any change to the search environment invalidates immediately.
// Explicit-path resolution is never cached - callers probe paths they have
// just written (e.g. managed binary installs). A "not-found" outcome is also
// cached for the TTL, so a just-installed binary can stay invisible for up to
// 30s unless resolved by explicit path.
// TTL expiry uses the monotonic clock (Clock.currentTimeNanos) so backward
// wall-clock adjustments cannot keep expired entries alive.
const COMMAND_RESOLUTION_CACHE_TTL_NANOS = 30_000_000_000n;

const COMMAND_RESOLUTION_CACHE_MAX_ENTRIES = 512;

const COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR = String.fromCharCode(0);

interface CommandResolutionCacheEntry {
  readonly resolvedPath: string | null;
  readonly expiresAtNanos: bigint;
}

// The cache lives in the Effect environment (like HostProcessPlatform above)
// so tests and embedders can provide an isolated instance; the default is a
// single process-wide map shared by all consumers.
export const CommandResolutionCache = Context.Reference<Map<string, CommandResolutionCacheEntry>>(
  "@akeru/shared/shell/CommandResolutionCache",
  {
    defaultValue: () => new Map(),
  },
);

function cacheCommandResolution(
  cache: Map<string, CommandResolutionCacheEntry>,
  cacheKey: string,
  resolvedPath: string | null,
  nowNanos: bigint,
): void {
  if (cache.size >= COMMAND_RESOLUTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;

    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  cache.set(cacheKey, {
    resolvedPath,
    expiresAtNanos: nowNanos + COMMAND_RESOLUTION_CACHE_TTL_NANOS,
  });
}

const isExecutableFile = Effect.fn("shell.isExecutableFile")(function* (
  filePath: string,
  platform: NodeJS.Platform,
  windowsPathExtensions: ReadonlyArray<string>,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stat = yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));

  if (stat === null || stat.type !== "File") return false;

  if (platform === "win32") {
    const extension = path.extname(filePath);

    if (extension.length === 0) return false;

    return windowsPathExtensions.includes(extension.toUpperCase());
  }

  return canExecuteFile(filePath);
});

const resolveCommandPathForPlatform = Effect.fn("shell.resolveCommandPathForPlatform")(function* (
  command: string,
  options: CommandAvailabilityOptions & { readonly platform: NodeJS.Platform },
): Effect.fn.Return<string, CommandResolutionError, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const platform = options.platform;
  const env = options.env ?? process.env;
  const windowsPathExtensions = platform === "win32" ? resolveWindowsPathExtensions(env) : [];

  const commandCandidates = resolveCommandCandidates(
    command,
    platform,
    windowsPathExtensions,
    path.extname,
  );

  if (command.includes("/") || command.includes("\\")) {
    for (const candidate of commandCandidates) {
      if (yield* isExecutableFile(candidate, platform, windowsPathExtensions)) {
        return candidate;
      }
    }

    return yield* new CommandResolutionError({ command, reason: "not-found" });
  }

  const pathValue = resolvePathEnvironmentVariable(env);

  if (pathValue.length === 0) {
    return yield* new CommandResolutionError({ command, reason: "not-found" });
  }

  const cacheKey = [platform, pathValue, windowsPathExtensions.join(";"), command].join(
    COMMAND_RESOLUTION_CACHE_KEY_SEPARATOR,
  );

  const cache = yield* CommandResolutionCache;
  const nowNanos = yield* Clock.currentTimeNanos;
  const cached = cache.get(cacheKey);

  if (cached !== undefined && cached.expiresAtNanos > nowNanos) {
    if (cached.resolvedPath === null) {
      return yield* new CommandResolutionError({ command, reason: "not-found" });
    }

    return cached.resolvedPath;
  }

  const pathEntries: string[] = [];

  for (const entry of pathValue.split(pathDelimiterForPlatform(platform))) {
    const pathEntry = stripWrappingQuotes(entry.trim());

    if (pathEntry.length > 0) {
      pathEntries.push(pathEntry);
    }
  }

  for (const pathEntry of pathEntries) {
    for (const candidate of commandCandidates) {
      const candidatePath = path.join(pathEntry, candidate);

      if (yield* isExecutableFile(candidatePath, platform, windowsPathExtensions)) {
        cacheCommandResolution(cache, cacheKey, candidatePath, nowNanos);

        return candidatePath;
      }
    }
  }

  cacheCommandResolution(cache, cacheKey, null, nowNanos);

  return yield* new CommandResolutionError({ command, reason: "not-found" });
});

export const resolveCommandPath = Effect.fn("shell.resolveCommandPath")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPathForPlatform(command, {
    env: options.env ?? (yield* HostProcessEnvironment),
    platform: yield* HostProcessPlatform,
  });
});

export const resolveSpawnCommand = Effect.fn("shell.resolveSpawnCommand")(function* (
  command: string,
  args: ReadonlyArray<string>,
  options: CommandAvailabilityOptions = {},
): Effect.fn.Return<ResolvedSpawnCommand> {
  const platform = yield* HostProcessPlatform;

  if (platform !== "win32") {
    return { command, args: [...args], shell: false };
  }

  const hostEnvironment = yield* HostProcessEnvironment;

  const env =
    options.env === undefined
      ? hostEnvironment
      : options.extendEnv
        ? { ...hostEnvironment, ...options.env }
        : options.env;

  const resolveExecutable = yield* SpawnExecutableResolution;
  const resolvedCommand = resolveExecutable(command, platform, env) ?? command;
  const extension = NodePath.win32.extname(resolvedCommand).toLowerCase();

  if (extension !== ".cmd" && extension !== ".bat") {
    return { command: resolvedCommand, args: [...args], shell: false };
  }

  return {
    command: escapeWindowsShellArg(resolvedCommand),
    args: sanitizeShellModeArgsForPlatform(args, platform),
    shell: true,
  };
});

export const isCommandAvailable = Effect.fn("shell.isCommandAvailable")(function* (
  command: string,
  options: CommandAvailabilityOptions = {},
) {
  return yield* resolveCommandPath(command, options).pipe(
    Effect.as(true),
    Effect.catchTag("CommandResolutionError", () => Effect.succeed(false)),
  );
});
