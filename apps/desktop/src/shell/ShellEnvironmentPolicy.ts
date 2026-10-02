import * as Match from "effect/Match";
import * as Duration from "effect/Duration";

import * as Option from "effect/Option";

export type EnvironmentPatch = Record<string, string>;

export interface ShellEnvironmentConfig {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly userShell: Option.Option<string>;
}

export interface WindowsProbeOptions {
  readonly loadProfile: boolean;
}

export const LOGIN_SHELL_ENV_NAMES = [
  "PATH",
  "DBUS_SESSION_BUS_ADDRESS",
  "DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSH_AUTH_SOCK",
  "HOMEBREW_PREFIX",
  "HOMEBREW_CELLAR",
  "HOMEBREW_REPOSITORY",
  "XDG_CONFIG_HOME",
  "XDG_CURRENT_DESKTOP",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_SESSION_DESKTOP",
  "XDG_SESSION_TYPE",
  "WAYLAND_DISPLAY",
] as const;

export const WINDOWS_PROFILE_ENV_NAMES = ["PATH", "FNM_DIR", "FNM_MULTISHELL_PATH"] as const;

export const LOCALE_ENV_NAMES = ["LANG", "LC_ALL", "LC_CTYPE"] as const;

export const FALLBACK_LC_CTYPE = "en_US.UTF-8";

export const WINDOWS_SHELL_CANDIDATES = ["pwsh.exe", "powershell.exe"] as const;

export const LOGIN_SHELL_TIMEOUT = Duration.seconds(5);

export const LAUNCHCTL_TIMEOUT = Duration.seconds(2);

export const PROCESS_TERMINATE_GRACE = Duration.seconds(1);

export const trimNonEmpty = (value: string | null | undefined): Option.Option<string> =>
  Option.fromNullishOr(value).pipe(
    Option.map((entry) => entry.trim()),
    Option.filter((entry) => entry.length > 0),
  );

export const pathDelimiter = (platform: NodeJS.Platform) => (platform === "win32" ? ";" : ":");

export const readEnvPath = (env: NodeJS.ProcessEnv): Option.Option<string> =>
  trimNonEmpty(env.PATH ?? env.Path ?? env.path);

export const normalizeRuntimeDir = (value: string): string => value.replace(/\/+$/u, "");

export const linuxRuntimeDirCandidates = (
  env: NodeJS.ProcessEnv,
  uid: number | undefined,
): ReadonlyArray<string> => {
  const candidates: string[] = [];
  const fromEnv = trimNonEmpty(env.XDG_RUNTIME_DIR);

  if (Option.isSome(fromEnv)) {
    candidates.push(normalizeRuntimeDir(fromEnv.value));
  }

  if (uid !== undefined) {
    candidates.push(`/run/user/${uid}`);
  }

  return candidates.filter((candidate) => candidate.length > 0);
};

export function resolveDefaultLinuxDbusSessionBusPath(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly uid: number | undefined;
  readonly exists: (path: string) => boolean;
}): string | null {
  for (const runtimeDir of linuxRuntimeDirCandidates(input.env, input.uid)) {
    const busPath = `${runtimeDir}/bus`;

    if (input.exists(busPath)) {
      return busPath;
    }
  }

  return null;
}

export function resolveDefaultLinuxDbusSessionBusAddress(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly exists: (path: string) => boolean;
  readonly uid: number | undefined;
}): string | null {
  const busPath = resolveDefaultLinuxDbusSessionBusPath(input);

  return busPath !== null ? `unix:path=${busPath}` : null;
}

export const pathComparisonKey = (entry: string, platform: NodeJS.Platform) => {
  const normalized = entry.trim().replace(/^"+|"+$/g, "");

  return platform === "win32" ? normalized.toLowerCase() : normalized;
};

export const mergePaths = (
  platform: NodeJS.Platform,
  values: ReadonlyArray<Option.Option<string>>,
): Option.Option<string> => {
  const delimiter = pathDelimiter(platform);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (Option.isNone(value)) continue;

    for (const entry of value.value.split(delimiter)) {
      const trimmed = entry.trim();

      if (trimmed.length === 0) continue;

      const key = pathComparisonKey(trimmed, platform);

      if (key.length === 0 || seen.has(key)) continue;

      seen.add(key);
      entries.push(trimmed);
    }
  }

  return entries.length > 0 ? Option.some(entries.join(delimiter)) : Option.none();
};

export const listLoginShellCandidates = (config: ShellEnvironmentConfig): ReadonlyArray<string> => {
  const fallback = Match.value(config.platform).pipe(
    Match.when("darwin", () => "/bin/zsh"),
    Match.when("linux", () => "/bin/bash"),
    Match.orElse(() => ""),
  );

  const seen = new Set<string>();
  const candidates: string[] = [];

  for (const candidate of [
    trimNonEmpty(config.env.SHELL),
    config.userShell,
    trimNonEmpty(fallback),
  ]) {
    if (Option.isNone(candidate) || seen.has(candidate.value)) continue;
    seen.add(candidate.value);
    candidates.push(candidate.value);
  }

  return candidates;
};

export const knownWindowsCliDirs = (env: NodeJS.ProcessEnv): ReadonlyArray<string> => [
  ...trimNonEmpty(env.APPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\npm`],
    }),
  ),
  ...trimNonEmpty(env.LOCALAPPDATA).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\Programs\\nodejs`, `${value}\\Volta\\bin`, `${value}\\pnpm`],
    }),
  ),
  ...trimNonEmpty(env.USERPROFILE).pipe(
    Option.match({
      onNone: () => [],
      onSome: (value) => [`${value}\\.local\\bin`, `${value}\\.bun\\bin`, `${value}\\scoop\\shims`],
    }),
  ),
];

export const startMarker = (name: string) => `__T3CODE_ENV_${name}_START__`;

export const endMarker = (name: string) => `__T3CODE_ENV_${name}_END__`;

export const executableName = (command: string): string =>
  command.split(/[\\/]/u).at(-1) ?? command;

export const capturePosixEnvironmentCommand = (names: ReadonlyArray<string>) =>
  names
    .map((name) => {
      return [
        `printf '%s\\n' '${startMarker(name)}'`,
        `printenv ${name} || true`,
        `printf '%s\\n' '${endMarker(name)}'`,
      ].join("; ");
    })
    .join("; ");

export const captureWindowsEnvironmentCommand = (names: ReadonlyArray<string>) =>
  [
    "$ErrorActionPreference = 'Stop'",
    ...names.flatMap((name) => {
      return [
        `Write-Output '${startMarker(name)}'`,
        `$value = [Environment]::GetEnvironmentVariable('${name}')`,
        "if ($null -ne $value -and $value.Length -gt 0) { Write-Output $value }",
        `Write-Output '${endMarker(name)}'`,
      ];
    }),
  ].join("; ");

export const extractEnvironment = (output: string, names: ReadonlyArray<string>) => {
  const environment: EnvironmentPatch = {};

  for (const name of names) {
    const start = output.indexOf(startMarker(name));

    if (start === -1) continue;

    const valueStart = start + startMarker(name).length;
    const end = output.indexOf(endMarker(name), valueStart);

    if (end === -1) continue;

    const value = output
      .slice(valueStart, end)
      .replace(/^\r?\n/, "")
      .replace(/\r?\n$/, "");

    if (value.length > 0) {
      environment[name] = value;
    }
  }

  return environment;
};
