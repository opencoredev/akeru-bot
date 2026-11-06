import type { EnvironmentHostTool, ExecutionEnvironmentPlatformOs } from "@akeru/contracts";
import * as Effect from "effect/Effect";

interface ToolProbe {
  /** Executable names looked up on PATH. */
  readonly commands: ReadonlyArray<string>;
  /** Fixed install locations, such as macOS app bundles, checked as-is. */
  readonly paths?: Partial<Record<ExecutionEnvironmentPlatformOs, ReadonlyArray<string>>>;
  /**
   * The tool ships in a macOS developer directory (Xcode or the command line
   * tools). Its `/usr/bin` copy is Apple's stub, which only works when a
   * developer directory exists, so PATH hits in `/usr/bin` do not count and
   * the developer directories are checked for the real binary instead.
   */
  readonly darwinDeveloperTool?: boolean;
  /** Platforms the tool exists on. Omitted means every platform. */
  readonly onlyOn?: ReadonlyArray<ExecutionEnvironmentPlatformOs>;
}

const TOOL_PROBES = {
  xcodebuild: {
    commands: ["xcodebuild"],
    darwinDeveloperTool: true,
    onlyOn: ["darwin"],
  },
  docker: {
    commands: ["docker"],
    paths: { darwin: ["/Applications/Docker.app"] },
  },
  "nvidia-smi": {
    commands: ["nvidia-smi"],
    paths: { windows: ["C:\\Windows\\System32\\nvidia-smi.exe"] },
  },
  git: {
    commands: ["git"],
    darwinDeveloperTool: true,
    paths: { darwin: ["/Library/Developer/CommandLineTools/usr/bin/git"] },
  },
  chrome: {
    commands: ["google-chrome", "google-chrome-stable", "chrome"],
    paths: {
      darwin: ["/Applications/Google Chrome.app"],
      windows: [
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      ],
    },
  },
  chromium: {
    commands: ["chromium", "chromium-browser"],
    paths: { darwin: ["/Applications/Chromium.app"] },
  },
  firefox: {
    commands: ["firefox"],
    paths: {
      darwin: ["/Applications/Firefox.app"],
      windows: ["C:\\Program Files\\Mozilla Firefox\\firefox.exe"],
    },
  },
  safari: {
    commands: [],
    paths: { darwin: ["/Applications/Safari.app"] },
  },
  edge: {
    commands: ["microsoft-edge", "microsoft-edge-stable"],
    paths: {
      darwin: ["/Applications/Microsoft Edge.app"],
      windows: [
        "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      ],
    },
  },
} as const satisfies Record<EnvironmentHostTool, ToolProbe>;

const ENVIRONMENT_HOST_TOOLS = Object.keys(TOOL_PROBES).filter(
  (tool): tool is EnvironmentHostTool => Object.hasOwn(TOOL_PROBES, tool),
);

const DARWIN_STUB_DIRECTORY = "/usr/bin";

/** `xcode-select --switch` points this symlink at the selected developer directory. */
export const DARWIN_SELECTED_DEVELOPER_LINK = "/var/db/xcode_select_link";

/** Where Xcode looks when nothing was selected. */
const DARWIN_DEFAULT_DEVELOPER_DIRECTORIES = [
  "/Applications/Xcode.app/Contents/Developer",
  "/Applications/Xcode-beta.app/Contents/Developer",
];

/**
 * Developer directories to check, most specific first: `DEVELOPER_DIR`
 * (which may name the app bundle or its `Contents/Developer`), the
 * `xcode-select` selection, then the default install locations.
 */
const darwinDeveloperDirectories = (developerDirectory: string | undefined) => {
  const fromEnvironment = developerDirectory?.trim().replace(/\/+$/u, "");

  return [
    ...(fromEnvironment ? [fromEnvironment, `${fromEnvironment}/Contents/Developer`] : []),
    DARWIN_SELECTED_DEVELOPER_LINK,
    ...DARWIN_DEFAULT_DEVELOPER_DIRECTORIES,
  ];
};

export interface DetectEnvironmentHostToolsInput {
  readonly os: ExecutionEnvironmentPlatformOs;
  /** Directories from PATH, in order. */
  readonly searchPath: ReadonlyArray<string>;
  /** The `DEVELOPER_DIR` value, when set. Only macOS reads it. */
  readonly developerDirectory?: string | undefined;
  /** True when a file or app bundle exists at the path. Must not run it. */
  readonly exists: (path: string) => Effect.Effect<boolean>;
}

const candidatePaths = (
  tool: EnvironmentHostTool,
  input: DetectEnvironmentHostToolsInput,
): ReadonlyArray<string> => {
  const probe: ToolProbe = TOOL_PROBES[tool];

  if (probe.onlyOn !== undefined && !probe.onlyOn.includes(input.os)) return [];
  const separator = input.os === "windows" ? "\\" : "/";
  const suffix = input.os === "windows" ? ".exe" : "";

  const darwinDeveloperTool = probe.darwinDeveloperTool === true && input.os === "darwin";

  const directories = input.searchPath.filter(
    (directory) =>
      !(darwinDeveloperTool && directory.replace(/\/+$/u, "") === DARWIN_STUB_DIRECTORY),
  );

  const onPath = directories.flatMap((directory) =>
    probe.commands.map(
      (command) => `${directory.replace(/[\\/]+$/u, "")}${separator}${command}${suffix}`,
    ),
  );

  const inDeveloperDirectories = darwinDeveloperTool
    ? darwinDeveloperDirectories(input.developerDirectory).flatMap((directory) =>
        probe.commands.map((command) => `${directory}/usr/bin/${command}`),
      )
    : [];

  return [...onPath, ...inDeveloperDirectories, ...(probe.paths?.[input.os] ?? [])];
};

/**
 * Finds which known tools are installed by checking file paths only. Each
 * tool stops at its first hit, so a typical machine checks a few dozen paths.
 */
export const detectEnvironmentHostTools = (
  input: DetectEnvironmentHostToolsInput,
): Effect.Effect<ReadonlyArray<EnvironmentHostTool>> =>
  Effect.forEach(
    ENVIRONMENT_HOST_TOOLS,
    (tool) =>
      Effect.gen(function* () {
        for (const path of candidatePaths(tool, input)) {
          if (yield* input.exists(path)) return [tool];
        }

        return [];
      }),
    { concurrency: 4 },
  ).pipe(Effect.map((found) => found.flat()));

/** Splits a PATH value the way the platform does. Empty segments are dropped. */
export const splitSearchPath = (
  value: string | undefined,
  os: ExecutionEnvironmentPlatformOs,
): ReadonlyArray<string> =>
  (value ?? "").split(os === "windows" ? ";" : ":").filter((directory) => directory.length > 0);
