import {
  createPackageWithOptions,
  getRawHeader,
  statFile,
  type DirectoryRecord,
} from "@electron/asar";

import { HostProcessArchitecture, HostProcessPlatform } from "@akeru/shared/hostProcess";

import { resolveSpawnCommand } from "@akeru/shared/shell";

import rootPackageJson from "../../../package.json" with { type: "json" };

import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import { ChildProcess } from "effect/unstable/process";

import { BuildArch, encodeJsonString } from "./model.ts";

import {
  WslNodePtyPrebuildMissingError,
  WslNodePtyManifestReadError,
  WindowsServerSidecarPackError,
  WindowsPrimaryNativeProbeError,
  WindowsPackagedPayloadValidationError,
} from "./errors.ts";

import {
  resolveFffNativeDependencies,
  createStagePatchedDependencies,
  createStageWorkspaceConfig,
  encodeStageWorkspaceConfig,
  STAGE_INSTALL_ARGS,
} from "./workspace.ts";

import { runCommand } from "./process.ts";

import { WINDOWS_SERVER_ASAR_RESOURCE } from "./config.ts";

import { resourceMonitorExecutableName } from "./resource-monitor.ts";

import { verifyPackagedBundleIsSelfContained } from "./bundle-verification.ts";

const decodeNodePtyManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ version: Schema.String })),
);

const WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT = Duration.seconds(30);

const WINDOWS_PRIMARY_FFF_PROBE_SOURCE = `
const { join } = await import("node:path");
const { pathToFileURL } = await import("node:url");
const { FileFinder } = await import(pathToFileURL(process.argv[1]).href);
const probeRoot = process.argv[2];
const result = FileFinder.create({
  basePath: probeRoot,
  frecencyDbPath: join(probeRoot, "frecency.mdb"),
  historyDbPath: join(probeRoot, "history.mdb"),
  disableWatch: true,
  disableMmapCache: true,
  disableContentIndexing: true,
});
if (!result.ok) throw new Error(result.error);
result.value.destroy();
`;

// dlopen/spawn need real files, so native modules, shared libraries, and
// helper executables live in the server.asar.unpacked sibling (the standard
// asar redirect convention). Everything else stays packed.
export const WINDOWS_SERVER_ASAR_UNPACK_GLOB =
  "{**/*.node,**/*.dll,**/*.exe,**/*.so,**/*.so.*,**/*.dylib}";

// Mirrors DESKTOP_FILE_EXCLUSIONS for the hand-packed sidecar: the Claude SDK
// platform packages are dead weight (see above), and node_modules/.bin shims
// are never spawned at runtime (and are symlinks on POSIX build hosts, which
// the asar extraction path deliberately does not support).
export const WINDOWS_SERVER_ASAR_IGNORE_GLOBS = [
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*",
  "**/node_modules/@anthropic-ai/claude-agent-sdk-*/**",
  "**/node_modules/.bin",
  "**/node_modules/.bin/**",
] as const;

export function resolveWindowsServerAsarIgnoreGlobs(arch: typeof BuildArch.Type) {
  const unusedArch = arch === "arm64" ? "x64" : "arm64";
  const unusedPrebuild = `**/node_modules/node-pty/prebuilds/win32-${unusedArch}`;
  const unusedConpty = `**/node_modules/node-pty/third_party/conpty/*/win10-${unusedArch}`;

  return [
    ...WINDOWS_SERVER_ASAR_IGNORE_GLOBS,
    unusedPrebuild,
    `${unusedPrebuild}/**`,
    unusedConpty,
    `${unusedConpty}/**`,
  ];
}

export const WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT = 80;

// Stage the prebuilt Linux node-pty binary into the packaged app so the WSL
// backend never compiles on the user's machine. node-pty publishes no Linux
// prebuilt and the WSL Linux Node can't load the Windows/Electron binary, so the
// Linux CI job builds pty.node and hands it here. We drop it into the staged
// node-pty's prebuilds/linux-<arch>/ with a t3code marker the WSL preflight
// checks (arch + node-pty version; the binary is N-API, hence ABI-stable across
// Node versions). A missing prebuild is a warning, not an error, so local and
// non-Windows builds still succeed — they just won't ship a working WSL backend.
const stageWslNodePtyPrebuild = Effect.fn("stageWslNodePtyPrebuild")(function* (input: {
  readonly stageAppDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly prebuildPath: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  if (input.prebuildPath === undefined) {
    yield* Effect.logWarning(
      "[desktop-artifact] No WSL node-pty prebuild provided (--wsl-prebuild / T3CODE_DESKTOP_WSL_PREBUILD); the packaged WSL backend will not start until a Linux pty.node is bundled.",
    );

    return;
  }

  // WSL runs the same CPU arch as the Windows host; universal is mac-only.
  const linuxArch = input.arch === "x64" ? "x64" : input.arch === "arm64" ? "arm64" : undefined;

  if (linuxArch === undefined) {
    yield* Effect.logWarning(
      `[desktop-artifact] No WSL node-pty prebuild mapping for arch "${input.arch}"; skipping WSL backend bundling.`,
    );

    return;
  }

  const prebuildExists = yield* fs
    .exists(input.prebuildPath)
    .pipe(Effect.orElseSucceed(() => false));

  if (!prebuildExists) {
    return yield* new WslNodePtyPrebuildMissingError({
      prebuildPath: input.prebuildPath,
    });
  }

  // Resolve through the (pnpm) symlink so we write into the stage's own node-pty
  // copy, never a shared content-addressable store.
  const nodePtyLink = path.join(input.stageAppDir, "node_modules", "node-pty");
  const nodePtyDir = yield* fs.realPath(nodePtyLink).pipe(Effect.orElseSucceed(() => nodePtyLink));

  const manifestPath = path.join(nodePtyDir, "package.json");
  const pkgRaw = yield* fs.readFileString(manifestPath);

  const manifest = yield* decodeNodePtyManifest(pkgRaw).pipe(
    Effect.mapError(
      (cause) =>
        new WslNodePtyManifestReadError({
          manifestPath,
          cause,
        }),
    ),
  );

  const nodePtyVersion = manifest.version;

  const prebuildDir = path.join(nodePtyDir, "prebuilds", `linux-${linuxArch}`);
  yield* fs.makeDirectory(prebuildDir, { recursive: true });
  yield* fs.copyFile(input.prebuildPath, path.join(prebuildDir, "pty.node"));
  const markerJson = yield* encodeJsonString({ arch: linuxArch, nodePtyVersion });
  yield* fs.writeFileString(path.join(prebuildDir, "t3code-wsl-node-pty.json"), `${markerJson}\n`);

  yield* Effect.log(
    `[desktop-artifact] Staged WSL node-pty prebuild (linux-${linuxArch}, node-pty ${nodePtyVersion}).`,
  );
});

// Stage and pack the Windows server sidecar: the bundled server plus a hoisted
// install of only its runtime-external/native dependency closure for win32 and
// WSL Linux. The Windows primary runs from the archive through the asar-aware
// ELECTRON_RUN_AS_NODE runtime; enabling WSL extracts it to a real directory.
// Shipping one packed archive instead of thousands of loose files is what
// makes the NSIS install/update fast.
export const packWindowsServerAsar = Effect.fn("packWindowsServerAsar")(function* (input: {
  readonly sourceDir: string;
  readonly asarPath: string;
  readonly arch: typeof BuildArch.Type;
}) {
  const fs = yield* FileSystem.FileSystem;
  yield* Effect.tryPromise({
    try: () =>
      createPackageWithOptions(input.sourceDir, input.asarPath, {
        dot: true,
        unpack: WINDOWS_SERVER_ASAR_UNPACK_GLOB,
        globOptions: { ignore: resolveWindowsServerAsarIgnoreGlobs(input.arch) },
      }),
    catch: (cause) => new WindowsServerSidecarPackError({ asarPath: input.asarPath, cause }),
  });
  const unpackedDirPath = `${input.asarPath}.unpacked`;

  if (!(yield* fs.exists(unpackedDirPath))) {
    return yield* new WindowsServerSidecarPackError({
      asarPath: input.asarPath,
      cause: new Error(`expected native binaries at ${unpackedDirPath}, but none were unpacked`),
    });
  }
});

export const stageWindowsServerSidecar = Effect.fn("stageWindowsServerSidecar")(function* (input: {
  readonly stageRoot: string;
  readonly repoRoot: string;
  readonly serverDistDir: string;
  readonly arch: typeof BuildArch.Type;
  readonly appVersion: string;
  readonly runtimeExternalDependencies: Record<string, string>;
  readonly fffNodeVersion: string;
  readonly allowBuilds: Record<string, boolean>;
  readonly patchedDependencies: Record<string, string>;
  readonly overrides: Record<string, string>;
  readonly wslPrebuildPath: string | undefined;
  readonly asarPath: string;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const serverStageDir = path.join(input.stageRoot, "server");
  yield* fs.makeDirectory(path.join(serverStageDir, "apps/server"), { recursive: true });
  yield* fs.copy(input.serverDistDir, path.join(serverStageDir, "apps/server/dist"));

  const sidecarDependencies = {
    ...input.runtimeExternalDependencies,
    // The sidecar serves two processes: the Windows primary loads win32
    // natives, and the WSL backend loads the matching Linux natives (fff via
    // ffi-rs) from the extracted copy of this same tree.
    ...resolveFffNativeDependencies("win", input.arch, input.fffNodeVersion),
    ...resolveFffNativeDependencies("linux", input.arch, input.fffNodeVersion),
  };

  const sidecarPatchedDependencies = createStagePatchedDependencies(
    input.patchedDependencies,
    sidecarDependencies,
  );

  const sidecarPackageJson = {
    name: "t3code-server",
    version: input.appVersion,
    private: true,
    packageManager: rootPackageJson.packageManager,
    dependencies: sidecarDependencies,
  };

  const sidecarPackageJsonString = yield* encodeJsonString(sidecarPackageJson);
  yield* fs.writeFileString(
    path.join(serverStageDir, "package.json"),
    `${sidecarPackageJsonString}\n`,
  );

  const sidecarWorkspaceConfig = createStageWorkspaceConfig({
    platform: "win",
    arch: input.arch,
    allowBuilds: input.allowBuilds,
    patchedDependencies: sidecarPatchedDependencies,
    overrides: input.overrides,
    linuxServerBackend: true,
  });

  const sidecarWorkspaceConfigString = yield* encodeStageWorkspaceConfig(sidecarWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(serverStageDir, "pnpm-workspace.yaml"),
    sidecarWorkspaceConfigString,
  );

  if (Object.keys(sidecarPatchedDependencies).length > 0) {
    yield* fs.copy(path.join(input.repoRoot, "patches"), path.join(serverStageDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing server sidecar runtime externals...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: serverStageDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod (server sidecar)", verbose: input.verbose },
  );

  yield* stageWslNodePtyPrebuild({
    stageAppDir: serverStageDir,
    arch: input.arch,
    prebuildPath: input.wslPrebuildPath,
  });

  yield* Effect.log("[desktop-artifact] Packing server.asar...");
  yield* fs.makeDirectory(path.dirname(input.asarPath), { recursive: true });
  yield* packWindowsServerAsar({
    sourceDir: serverStageDir,
    asarPath: input.asarPath,
    arch: input.arch,
  });
  const packedStat = yield* fs.stat(input.asarPath);
  yield* Effect.log(
    `[desktop-artifact] Packed server.asar (${String(packedStat.size)} bytes) + unpacked natives.`,
  );
});

function collectUnpackedAsarFiles(
  directory: DirectoryRecord,
  parentPath = "",
  output: string[] = [],
): readonly string[] {
  for (const [name, entry] of Object.entries(directory.files)) {
    const entryPath = parentPath.length === 0 ? name : `${parentPath}/${name}`;

    if ("files" in entry) {
      collectUnpackedAsarFiles(entry, entryPath, output);
    } else if (entry.unpacked) {
      output.push(entryPath);
    }
  }

  return output;
}

const countPayloadFiles = Effect.fn("desktopArtifact.countPayloadFiles")(function* (input: {
  readonly root: string;
  readonly excludedDirectories?: ReadonlyArray<string>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const excludedDirectories = new Set(input.excludedDirectories ?? []);
  const pendingDirectories = [input.root];
  let count = 0;

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop();

    if (directory === undefined) break;
    const entries = yield* fs.readDirectory(directory);

    for (const entry of entries) {
      const entryPath = path.join(directory, entry);
      const stat = yield* fs.stat(entryPath);

      if (stat.type === "Directory") {
        if (!excludedDirectories.has(entryPath)) pendingDirectories.push(entryPath);
      } else if (stat.type === "File") {
        count += 1;
      }
    }
  }

  return count;
});

export const verifyWindowsPrimaryFffNativeLoad = Effect.fn(
  "desktopArtifact.verifyWindowsPrimaryFffNativeLoad",
)(function* (input: {
  readonly packagedAppDir: string;
  readonly asarPath: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const executablePath = path.join(input.packagedAppDir, input.appExecutableName);
  const executableStat = yield* fs.stat(executablePath).pipe(Effect.orElseSucceed(() => null));

  if (executableStat?.type !== "File") {
    return yield* new WindowsPrimaryNativeProbeError({
      executablePath,
      exitCode: -1,
      output: "The unpacked application does not contain its expected primary executable.",
    });
  }

  if (hostPlatform !== "win32" || hostArchitecture !== input.targetArch) return;

  const probeRoot = yield* fs.makeTempDirectoryScoped({
    prefix: "t3code-windows-primary-native-probe-",
  });

  const fffEntryPath = path.join(
    input.asarPath,
    "node_modules/@ff-labs/fff-node/dist/src/index.js",
  );

  const probeEnv = { ...process.env };
  delete probeEnv.ELECTRON_NO_ASAR;
  delete probeEnv.NODE_OPTIONS;

  yield* runCommand(
    ChildProcess.make(
      executablePath,
      [
        "--no-global-search-paths",
        "--input-type=module",
        "--eval",
        WINDOWS_PRIMARY_FFF_PROBE_SOURCE,
        fffEntryPath,
        probeRoot,
      ],
      {
        cwd: input.packagedAppDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...probeEnv,
          ELECTRON_RUN_AS_NODE: "1",
          NODE_PATH: "",
        },
      },
    ),
    {
      label: "Windows primary fff native-load probe",
      verbose: input.verbose,
    },
  ).pipe(
    Effect.timeout(WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT),
    Effect.catchTags({
      TimeoutError: () =>
        Effect.fail(
          new WindowsPrimaryNativeProbeError({
            executablePath,
            exitCode: -1,
            output: `The native-load probe did not finish within ${Duration.toSeconds(WINDOWS_PRIMARY_NATIVE_PROBE_TIMEOUT)}s.`,
          }),
        ),
      BuildCommandFailedError: (error) =>
        Effect.fail(
          new WindowsPrimaryNativeProbeError({
            executablePath,
            exitCode: error.exitCode,
            output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
          }),
        ),
    }),
  );
});

export const validateWindowsPackagedPayload = Effect.fn(
  "desktopArtifact.validateWindowsPackagedPayload",
)(function* (input: {
  readonly stageDistDir: string;
  readonly appExecutableName: string;
  readonly targetArch: typeof BuildArch.Type;
  readonly fileLimit?: number;
  readonly verbose?: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fileLimit = input.fileLimit ?? WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT;

  const isFile = (filePath: string) =>
    fs.stat(filePath).pipe(
      Effect.map((stat) => stat.type === "File"),
      Effect.orElseSucceed(() => false),
    );

  const stageEntries = yield* fs.readDirectory(input.stageDistDir);
  let packagedAppDir: string | undefined;

  for (const entry of stageEntries) {
    if (!entry.endsWith("-unpacked")) continue;
    const candidate = path.join(input.stageDistDir, entry);
    const stat = yield* fs.stat(candidate).pipe(Effect.orElseSucceed(() => null));

    if (stat?.type === "Directory") {
      packagedAppDir = candidate;
      break;
    }
  }

  if (packagedAppDir === undefined) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "packaged-app-missing",
      packagedAppDir: path.join(input.stageDistDir, "win-unpacked"),
    });
  }

  const resourcesDir = path.join(packagedAppDir, "resources");
  const asarPath = path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE);

  if (!(yield* fs.exists(asarPath).pipe(Effect.orElseSucceed(() => false)))) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "sidecar-missing",
      packagedAppDir,
      missingFiles: [WINDOWS_SERVER_ASAR_RESOURCE],
    });
  }

  const unpackedFiles = yield* Effect.try({
    try: () => {
      // The entry lookup proves the archive contains the server executable,
      // while the single header walk identifies every file ASAR redirects to
      // the unpacked sibling at runtime.
      // @electron/asar resolves entry names using the host path separator.
      // POSIX separators work on Linux/macOS but fail on Windows even when the
      // entry is present in the archive.
      statFile(asarPath, path.join("apps", "server", "dist", "bin.mjs"));

      return [...collectUnpackedAsarFiles(getRawHeader(asarPath).header)].sort();
    },
    catch: (cause) =>
      new WindowsPackagedPayloadValidationError({
        reason: "sidecar-invalid",
        packagedAppDir,
        cause,
      }),
  });

  if (unpackedFiles.length === 0) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "sidecar-invalid",
      packagedAppDir,
      cause: new Error("server.asar does not declare any unpacked native files"),
    });
  }

  const missingFiles: string[] = [];

  for (const unpackedFile of unpackedFiles) {
    const unpackedPath = path.join(
      resourcesDir,
      `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`,
      ...unpackedFile.split("/"),
    );

    if (!(yield* isFile(unpackedPath))) {
      missingFiles.push(`${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked/${unpackedFile}`);
    }
  }

  if (missingFiles.length > 0) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "unpacked-native-missing",
      packagedAppDir,
      missingFiles,
    });
  }

  const resourceMonitorPath = path.join(
    resourcesDir,
    "resource-monitor",
    resourceMonitorExecutableName("win"),
  );

  if (!(yield* isFile(resourceMonitorPath))) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "resource-monitor-missing",
      packagedAppDir,
      missingFiles: ["resource-monitor/t3-resource-monitor.exe"],
    });
  }

  const fileCount = yield* countPayloadFiles({
    root: packagedAppDir,
    excludedDirectories: [path.join(resourcesDir, "plugins")],
  });

  if (fileCount > fileLimit) {
    return yield* new WindowsPackagedPayloadValidationError({
      reason: "file-limit-exceeded",
      packagedAppDir,
      fileCount,
      fileLimit,
    });
  }

  yield* verifyWindowsPrimaryFffNativeLoad({
    packagedAppDir,
    asarPath,
    appExecutableName: input.appExecutableName,
    targetArch: input.targetArch,
    verbose: input.verbose ?? false,
  });

  yield* verifyPackagedBundleIsSelfContained({
    asarPath,
    pluginCatalogPath: path.join(resourcesDir, "plugins"),
    verbose: input.verbose ?? false,
  });

  yield* Effect.log(
    `[desktop-artifact] Validated Windows payload (${String(fileCount)} files, ${String(unpackedFiles.length)} sidecar natives).`,
  );

  return { packagedAppDir, fileCount, unpackedFiles } as const;
});
