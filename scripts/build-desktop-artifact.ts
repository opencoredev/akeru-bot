#!/usr/bin/env node
import { HostProcessPlatform } from "@akeru/shared/hostProcess";

import { resolveSpawnCommand } from "@akeru/shared/shell";

import rootPackageJson from "../package.json" with { type: "json" };

import desktopPackageJson from "../apps/desktop/package.json" with { type: "json" };

import serverPackageJson from "../apps/server/package.json" with { type: "json" };

import { applyWebBrandAssets } from "./apply-web-brand-assets.ts";

import {
  findInlinedExternalPackages,
  selectCliPackagedRuntimeDependencies,
} from "./lib/cli-external-packages.ts";

import { stageReleaseLegalFiles } from "./lib/release-legal.ts";

import { resolveCatalogDependencies } from "./lib/resolve-catalog.ts";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";

import * as NodeServices from "@effect/platform-node/NodeServices";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Layer from "effect/Layer";

import * as Logger from "effect/Logger";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import { Command, Flag } from "effect/unstable/cli";

import { ChildProcess } from "effect/unstable/process";

import { type ResolvedBuildOptions, resolveBuildOptions } from "./lib/desktop-build/options.ts";

import {
  RepoRoot,
  DESKTOP_PACKAGE_NAME,
  encodeJsonString,
  BuildPlatform,
  BuildArch,
} from "./lib/desktop-build/model.ts";

import {
  readWorkspaceConfig,
  resolveDesktopRuntimeDependencies,
  findStorePackageDirectory,
  hasNativeLoaderMarkers,
  resolveMacStageDependencies,
  resolveFffNativeDependencies,
  createStagePatchedDependencies,
  type StagePackageJson,
  createStageWorkspaceConfig,
  encodeStageWorkspaceConfig,
  STAGE_INSTALL_ARGS,
} from "./lib/desktop-build/workspace.ts";

import {
  PLATFORM_CONFIG,
  assertPlatformBuildResources,
  renderMacEntitlements,
  WINDOWS_SERVER_RESOURCE_SOURCE_DIR,
  WINDOWS_SERVER_ASAR_RESOURCE,
  createBuildConfig,
  resolvePackageManagerUserAgent,
  resolveDesktopProductName,
} from "./lib/desktop-build/config.ts";

import {
  UnsupportedDesktopBuildPlatformError,
  MissingServerProductionDependenciesError,
  DesktopBuildDependencyResolutionError,
  MissingDesktopBuildInputError,
  InlinedExternalPackageError,
  InlinedNativePackageError,
  ExternalizedBundleError,
  DesktopBuildDistDirectoryMissingError,
  DesktopBuildNoArtifactsProducedError,
} from "./lib/desktop-build/errors.ts";

import {
  DESKTOP_BUILD_ICON_ASSETS,
  DESKTOP_WEB_ASSET_BRAND,
  validateBundledClientAssets,
  stageDesktopDmgBackground,
} from "./lib/desktop-build/assets.ts";

import {
  resolveGitCommitHash,
  runCommand,
  resolvePythonForNodeGyp,
} from "./lib/desktop-build/process.ts";

import { BUNDLE_SELF_CONTAINED_SENTINEL } from "./lib/desktop-build/bundle-verification.ts";

import { stageResourceMonitor } from "./lib/desktop-build/resource-monitor.ts";

import {
  stageWindowsServerSidecar,
  validateWindowsPackagedPayload,
} from "./lib/desktop-build/windows-payload.ts";

export { DESKTOP_PACKAGE_NAME } from "./lib/desktop-build/model.ts";

export { resolveResourceMonitorRustTargets } from "./lib/desktop-build/resource-monitor.ts";

export { resourceMonitorExecutableName } from "./lib/desktop-build/resource-monitor.ts";

export { resolveResourceMonitorCargoBuildArgs } from "./lib/desktop-build/resource-monitor.ts";

export { UnsupportedHostBuildPlatformError } from "./lib/desktop-build/errors.ts";

export { UnsupportedDesktopBuildArchitectureError } from "./lib/desktop-build/errors.ts";

export { InvalidMockUpdateServerPortError } from "./lib/desktop-build/errors.ts";

export { BuildCommandFailedError } from "./lib/desktop-build/errors.ts";

export { ResourceMonitorBuildOutputMissingError } from "./lib/desktop-build/errors.ts";

export { DesktopIconSourceMissingError } from "./lib/desktop-build/errors.ts";

export { DesktopDmgBackgroundSourceMissingError } from "./lib/desktop-build/errors.ts";

export { BundledClientAssetsMissingError } from "./lib/desktop-build/errors.ts";

export { UnsupportedDesktopBuildPlatformError } from "./lib/desktop-build/errors.ts";

export { DesktopBuildDependencyResolutionError } from "./lib/desktop-build/errors.ts";

export { MissingServerProductionDependenciesError } from "./lib/desktop-build/errors.ts";

export { ExternalizedBundleError } from "./lib/desktop-build/errors.ts";

export { BundleNotSelfContainedError } from "./lib/desktop-build/errors.ts";

export { InlinedNativePackageError } from "./lib/desktop-build/errors.ts";

export { InlinedExternalPackageError } from "./lib/desktop-build/errors.ts";

export { MissingDesktopBuildInputError } from "./lib/desktop-build/errors.ts";

export { MacProvisioningProfileNotFoundError } from "./lib/desktop-build/errors.ts";

export { DesktopBuildDistDirectoryMissingError } from "./lib/desktop-build/errors.ts";

export { DesktopBuildNoArtifactsProducedError } from "./lib/desktop-build/errors.ts";

export { WslNodePtyPrebuildMissingError } from "./lib/desktop-build/errors.ts";

export { WindowsServerSidecarPackError } from "./lib/desktop-build/errors.ts";

export { WindowsPrimaryNativeProbeError } from "./lib/desktop-build/errors.ts";

export { WindowsPackagedPayloadValidationError } from "./lib/desktop-build/errors.ts";

export { WslNodePtyManifestReadError } from "./lib/desktop-build/errors.ts";

export { LinuxIconResizeError } from "./lib/desktop-build/errors.ts";

export { STAGE_INSTALL_ARGS } from "./lib/desktop-build/workspace.ts";

export { DESKTOP_ELECTRON_LANGUAGES } from "./lib/desktop-build/config.ts";

export { DESKTOP_FILE_EXCLUSIONS } from "./lib/desktop-build/config.ts";

export { MAC_FILE_EXCLUSIONS } from "./lib/desktop-build/config.ts";

export { WINDOWS_SERVER_ASAR_RESOURCE } from "./lib/desktop-build/config.ts";

export { DESKTOP_PLUGIN_CATALOG_RESOURCE_SOURCE_DIR } from "./lib/desktop-build/config.ts";

export { WINDOWS_SERVER_ASAR_UNPACK_GLOB } from "./lib/desktop-build/windows-payload.ts";

export { WINDOWS_SERVER_ASAR_IGNORE_GLOBS } from "./lib/desktop-build/windows-payload.ts";

export { resolveWindowsServerAsarIgnoreGlobs } from "./lib/desktop-build/windows-payload.ts";

export { WINDOWS_PACKAGED_PAYLOAD_FILE_LIMIT } from "./lib/desktop-build/windows-payload.ts";

export { WINDOWS_SERVER_RESOURCE_SOURCE_DIR } from "./lib/desktop-build/config.ts";

export { WINDOWS_SERVER_EXTRA_RESOURCES } from "./lib/desktop-build/config.ts";

export { DESKTOP_EXTRA_RESOURCES } from "./lib/desktop-build/config.ts";

export { renderMacEntitlements } from "./lib/desktop-build/config.ts";

export { resolveFffNativeDependencies } from "./lib/desktop-build/workspace.ts";

export { resolveMacStageDependencies } from "./lib/desktop-build/workspace.ts";

export { createStageWorkspaceConfig } from "./lib/desktop-build/workspace.ts";

export { createStagePatchedDependencies } from "./lib/desktop-build/workspace.ts";

export { resolveMockUpdateServerPort } from "./lib/desktop-build/options.ts";

export { resolveBuildOptions } from "./lib/desktop-build/options.ts";

export { ancestorNodeModulesPaths } from "./lib/desktop-build/workspace.ts";

export { copyDirectoryPreservingSymlinks } from "./lib/desktop-build/workspace.ts";

export { stageResourceMonitor } from "./lib/desktop-build/resource-monitor.ts";

export { stageDesktopDmgBackground } from "./lib/desktop-build/assets.ts";

export { stageLinuxIconSize } from "./lib/desktop-build/assets.ts";

export { resolveDesktopRuntimeDependencies } from "./lib/desktop-build/workspace.ts";

export { resolveGitHubPublishConfig } from "./lib/desktop-build/config.ts";

export { DESKTOP_UPDATE_CHANNEL } from "./lib/desktop-build/config.ts";

export { DESKTOP_WEB_ASSET_BRAND } from "./lib/desktop-build/assets.ts";

export { DESKTOP_BUILD_ICON_ASSETS } from "./lib/desktop-build/assets.ts";

export { resolveMockUpdateServerUrl } from "./lib/desktop-build/config.ts";

export { resolvePackageManagerUserAgent } from "./lib/desktop-build/config.ts";

export { resolveDesktopProductName } from "./lib/desktop-build/config.ts";

export { createBuildConfig } from "./lib/desktop-build/config.ts";

export { packWindowsServerAsar } from "./lib/desktop-build/windows-payload.ts";

export { stageWindowsServerSidecar } from "./lib/desktop-build/windows-payload.ts";

export { verifyWindowsPrimaryFffNativeLoad } from "./lib/desktop-build/windows-payload.ts";

export { validateWindowsPackagedPayload } from "./lib/desktop-build/windows-payload.ts";

const buildDesktopArtifact = Effect.fn("buildDesktopArtifact")(function* (
  options: ResolvedBuildOptions,
) {
  const repoRoot = yield* RepoRoot;
  const path = yield* Path.Path;
  const fs = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const workspaceConfig = yield* readWorkspaceConfig();
  const workspaceCatalog = workspaceConfig.catalog ?? {};
  const workspaceOverrides = workspaceConfig.overrides ?? {};
  const workspacePatchedDependencies = workspaceConfig.patchedDependencies ?? {};
  const workspaceAllowBuilds = workspaceConfig.allowBuilds ?? {};

  const platformConfig = PLATFORM_CONFIG[options.platform];

  if (!platformConfig) {
    return yield* new UnsupportedDesktopBuildPlatformError({
      platform: options.platform,
    });
  }

  const electronVersion = desktopPackageJson.dependencies.electron;

  const serverDependencies = serverPackageJson.dependencies;

  if (!serverDependencies || Object.keys(serverDependencies).length === 0) {
    return yield* new MissingServerProductionDependenciesError({
      manifestPath: "apps/server/package.json",
    });
  }

  const resolvedOverrides = yield* Effect.try({
    try: () => resolveCatalogDependencies(workspaceOverrides, workspaceCatalog, "apps/desktop"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "workspace-overrides",
        manifestPath: "pnpm-workspace.yaml",
        cause,
      }),
  });

  const resolvedServerDependencies = yield* Effect.try({
    try: () => resolveCatalogDependencies(serverDependencies, workspaceCatalog, "apps/server"),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "server-production",
        manifestPath: "apps/server/package.json",
        cause,
      }),
  });

  const resolvedServerPackagedRuntimeDependencies = selectCliPackagedRuntimeDependencies(
    resolvedServerDependencies,
  );

  const resolvedDesktopRuntimeDependencies = yield* Effect.try({
    try: () => resolveDesktopRuntimeDependencies(desktopPackageJson.dependencies, workspaceCatalog),
    catch: (cause) =>
      new DesktopBuildDependencyResolutionError({
        kind: "desktop-runtime",
        manifestPath: "apps/desktop/package.json",
        cause,
      }),
  });

  const appVersion = options.version ?? serverPackageJson.version;
  const iconAssets = DESKTOP_BUILD_ICON_ASSETS;
  const commitHash = yield* resolveGitCommitHash(repoRoot);
  const mkdir = options.keepStage ? fs.makeTempDirectory : fs.makeTempDirectoryScoped;

  const stageRoot = yield* mkdir({
    prefix: `t3code-desktop-${options.platform}-stage-`,
  });

  const stageAppDir = path.join(stageRoot, "app");
  const stageResourcesDir = path.join(stageAppDir, "apps/desktop/resources");

  const distDirs = {
    desktopDist: path.join(repoRoot, "apps/desktop/dist-electron"),
    desktopResources: path.join(repoRoot, "apps/desktop/resources"),
    serverDist: path.join(repoRoot, "apps/server/dist"),
  };

  const bundledClientEntry = path.join(distDirs.serverDist, "client/index.html");

  if (!options.skipBuild) {
    yield* Effect.log("[desktop-artifact] Building desktop/server/web artifacts...");
    const spawnCommand = yield* resolveSpawnCommand("vp", ["run", "build:desktop"]);
    yield* runCommand(
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        cwd: repoRoot,
        shell: spawnCommand.shell,
      }),
      { label: "vp run build:desktop", verbose: options.verbose },
    );
  }

  const requiredBuildInputs = [
    { artifact: "desktop-dist", artifactPath: distDirs.desktopDist },
    { artifact: "desktop-resources", artifactPath: distDirs.desktopResources },
    { artifact: "server-dist", artifactPath: distDirs.serverDist },
  ] as const;

  for (const input of requiredBuildInputs) {
    if (!(yield* fs.exists(input.artifactPath))) {
      return yield* new MissingDesktopBuildInputError({
        ...input,
        buildCommand: "vp run build:desktop",
      });
    }
  }

  // Assert against the emitted bundle, not the bundler config. `alwaysBundle`
  // only forces packages IN, so a transitive dependency of an external package
  // is bundled by default however the predicate is written — that silently
  // inlined msgpackr-extract and its native loader while every list-based test
  // still passed. An inlined native loader resolves its prebuilds relative to
  // the bundle and quietly falls back to a slower pure-JS path, so this fails
  // the build rather than shipping a silent regression.
  {
    const chunkNames = (yield* fs.readDirectory(distDirs.serverDist)).filter((entry) =>
      entry.endsWith(".mjs"),
    );

    let totalRegions = 0;
    const inlined = new Set<string>();
    const inlinedPackages = new Set<string>();

    for (const chunkName of chunkNames) {
      const source = yield* fs.readFileString(path.join(distDirs.serverDist, chunkName));
      const scan = findInlinedExternalPackages(source);
      totalRegions += scan.regionCount;

      for (const name of scan.inlined) inlined.add(name);

      for (const name of scan.inlinedPackages) inlinedPackages.add(name);
    }

    if (inlined.size > 0) {
      return yield* new InlinedExternalPackageError({
        packages: [...inlined].sort(),
      });
    }

    // No regions at all means the scan went blind (marker format changed), not
    // that the bundle is clean.
    if (totalRegions === 0) {
      return yield* new InlinedExternalPackageError({
        packages: ["<no module regions found; the bundle scan needs updating>"],
      });
    }

    // The check above is one-directional: it only proves nothing external got
    // inlined. A regression to externalizing everything would also pass it,
    // since source-file regions still exist -- and that is the failure this
    // whole change exists to prevent, because those packages are not in the
    // selected sidecar closure and both backends would die on ERR_MODULE_NOT_FOUND.
    // `effect` is imported by every server module, so it is inlined in any
    // correctly bundled build.
    // The list-based check above only sees packages someone already thought to
    // list. bufferutil and utf-8-validate were inlined for exactly that reason:
    // native, but absent from the list, so nothing flagged them. Ask the store
    // what each inlined package actually is instead.
    const nativeInlined: string[] = [];

    for (const name of [...inlinedPackages].sort()) {
      const packageDir = yield* findStorePackageDirectory(repoRoot, name);

      if (packageDir === null) continue;

      if (yield* hasNativeLoaderMarkers(packageDir)) nativeInlined.push(name);
    }

    if (nativeInlined.length > 0) {
      return yield* new InlinedNativePackageError({ packages: nativeInlined });
    }

    if (!inlinedPackages.has(BUNDLE_SELF_CONTAINED_SENTINEL)) {
      return yield* new ExternalizedBundleError({
        sentinel: BUNDLE_SELF_CONTAINED_SENTINEL,
        inlinedPackageCount: inlinedPackages.size,
      });
    }
  }

  if (!(yield* fs.exists(bundledClientEntry))) {
    return yield* new MissingDesktopBuildInputError({
      artifact: "bundled-server-client",
      artifactPath: bundledClientEntry,
      buildCommand: "vp run build:desktop",
    });
  }

  const webAssetBrand = DESKTOP_WEB_ASSET_BRAND;
  yield* applyWebBrandAssets(webAssetBrand, "apps/server/dist/client");
  yield* Effect.log(`[desktop-artifact] Applied ${webAssetBrand} web client branding.`);
  yield* validateBundledClientAssets(path.dirname(bundledClientEntry));

  yield* fs.makeDirectory(path.join(stageAppDir, "apps/desktop"), { recursive: true });

  if (options.platform !== "win") {
    yield* fs.makeDirectory(path.join(stageAppDir, "apps/server"), { recursive: true });
  }

  yield* Effect.log("[desktop-artifact] Staging release app...");
  yield* fs.copy(distDirs.desktopDist, path.join(stageAppDir, "apps/desktop/dist-electron"));
  yield* fs.copy(distDirs.desktopResources, stageResourcesDir);
  yield* stageReleaseLegalFiles({
    repoRoot,
    destination: path.join(stageAppDir, "legal"),
  });

  if (options.platform === "mac" && options.target === "dmg") {
    yield* stageDesktopDmgBackground(stageResourcesDir, options.verbose);
  }

  // On Windows the server tree ships in the server.asar sidecar instead of
  // app.asar (see stageWindowsServerSidecar), so the app stage omits it.
  if (options.platform !== "win") {
    yield* fs.copy(distDirs.serverDist, path.join(stageAppDir, "apps/server/dist"));
  }

  yield* stageResourceMonitor({
    repoRoot,
    stageResourcesDir,
    platform: options.platform,
    arch: options.arch,
    verbose: options.verbose,
  });

  yield* assertPlatformBuildResources(
    options.platform,
    stageResourcesDir,
    {
      macIconPng: path.join(repoRoot, iconAssets.macIconPng),
      macIconComposer: path.join(repoRoot, iconAssets.macIconComposer),
      linuxIconPng: path.join(repoRoot, iconAssets.linuxIconPng),
      windowsIconIco: path.join(repoRoot, iconAssets.windowsIconIco),
    },
    options.verbose,
  );

  // electron-builder is filtering out stageResourcesDir directory in the AppImage for production
  const stageProdResourcesDir = path.join(stageAppDir, "apps/desktop/prod-resources");
  yield* fs.copy(stageResourcesDir, stageProdResourcesDir);
  yield* fs.copy(
    path.join(repoRoot, "plugins/entries"),
    path.join(stageProdResourcesDir, "plugins/entries"),
  );

  const macEntitlementsPath =
    options.platform === "mac" ? path.join(stageAppDir, "entitlements.mac.plist") : undefined;

  if (macEntitlementsPath) {
    yield* fs.writeFileString(macEntitlementsPath, renderMacEntitlements());
  }

  // Windows splits dependencies per process: app.asar carries only the
  // desktop main-process runtime deps, while the server bundle's deps live in
  // the server.asar sidecar (see stageWindowsServerSidecar). macOS adds only
  // server packages that remain external to its merged app.asar. Linux retains
  // its existing full dependency tree.
  const stageDependencies =
    options.platform === "win"
      ? { ...resolvedDesktopRuntimeDependencies }
      : options.platform === "mac"
        ? resolveMacStageDependencies({
            serverDependencies: resolvedServerDependencies,
            desktopDependencies: resolvedDesktopRuntimeDependencies,
            arch: options.arch,
            fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
          })
        : {
            ...resolvedServerDependencies,
            ...resolvedDesktopRuntimeDependencies,
            ...resolveFffNativeDependencies(
              options.platform,
              options.arch,
              serverPackageJson.dependencies["@ff-labs/fff-node"],
            ),
          };

  const stagePatchedDependencies = createStagePatchedDependencies(
    workspacePatchedDependencies,
    stageDependencies,
  );

  const windowsServerAsarPath =
    options.platform === "win"
      ? path.join(stageAppDir, WINDOWS_SERVER_RESOURCE_SOURCE_DIR, WINDOWS_SERVER_ASAR_RESOURCE)
      : undefined;

  const stagePackageJson: StagePackageJson = {
    // Electron derives app.name (and therefore the macOS safe-storage
    // keychain service) from this manifest name. Keep the packaged identity
    // in Akeru's namespace instead of reusing T3 Code's `t3code` service.
    name: DESKTOP_PACKAGE_NAME,
    version: appVersion,
    buildVersion: appVersion,
    t3codeCommitHash: commitHash,
    private: true,
    packageManager: rootPackageJson.packageManager,
    description: "Akeru Bot desktop build",
    author: "Akeru Bot maintainers",
    license: "MIT",
    main: "apps/desktop/dist-electron/main.cjs",
    build: yield* createBuildConfig(
      options.platform,
      options.target,
      appVersion,
      options.signed,
      options.mockUpdates,
      options.mockUpdateServerPort,
      macEntitlementsPath ? { entitlementsPath: macEntitlementsPath } : undefined,
    ),
    dependencies: stageDependencies,
    devDependencies: {
      electron: electronVersion,
    },
  };

  const stagePackageJsonString = yield* encodeJsonString(stagePackageJson);
  yield* fs.writeFileString(path.join(stageAppDir, "package.json"), `${stagePackageJsonString}\n`);

  const stageWorkspaceConfig = createStageWorkspaceConfig({
    platform: options.platform,
    arch: options.arch,
    allowBuilds: workspaceAllowBuilds,
    patchedDependencies: stagePatchedDependencies,
    overrides: resolvedOverrides,
  });

  const stageWorkspaceConfigString = yield* encodeStageWorkspaceConfig(stageWorkspaceConfig);
  yield* fs.writeFileString(
    path.join(stageAppDir, "pnpm-workspace.yaml"),
    stageWorkspaceConfigString,
  );

  if (Object.keys(stagePatchedDependencies).length > 0) {
    yield* fs.copy(path.join(repoRoot, "patches"), path.join(stageAppDir, "patches"));
  }

  yield* Effect.log("[desktop-artifact] Installing staged production dependencies...");
  const installCommand = yield* resolveSpawnCommand("vp", [...STAGE_INSTALL_ARGS]);
  yield* runCommand(
    ChildProcess.make(installCommand.command, installCommand.args, {
      cwd: stageAppDir,
      shell: installCommand.shell,
    }),
    { label: "vp install --prod", verbose: options.verbose },
  );

  // WSL is Windows-only, so only the Windows artifact carries the server
  // sidecar (which embeds the Linux node-pty prebuild); other platforms
  // ignore the prebuild input.
  if (options.platform === "win" && windowsServerAsarPath) {
    yield* stageWindowsServerSidecar({
      stageRoot,
      repoRoot,
      serverDistDir: distDirs.serverDist,
      arch: options.arch,
      appVersion,
      runtimeExternalDependencies: resolvedServerPackagedRuntimeDependencies,
      fffNodeVersion: serverPackageJson.dependencies["@ff-labs/fff-node"],
      allowBuilds: workspaceAllowBuilds,
      patchedDependencies: workspacePatchedDependencies,
      overrides: resolvedOverrides,
      wslPrebuildPath: options.wslPrebuild,
      asarPath: windowsServerAsarPath,
      verbose: options.verbose,
    });
  }

  // electron-builder treats several set-but-empty variables (e.g. CSC_LINK="")
  // as enabled, so copy the host env and scrub empty values instead of relying
  // on `extendEnv` merging.
  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
  };

  buildEnv.npm_config_user_agent = resolvePackageManagerUserAgent(rootPackageJson.packageManager);

  for (const [key, value] of Object.entries(buildEnv)) {
    if (value === "") {
      delete buildEnv[key];
    }
  }

  if (!options.signed) {
    buildEnv.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    delete buildEnv.CSC_LINK;
    delete buildEnv.CSC_KEY_PASSWORD;
    delete buildEnv.APPLE_API_KEY;
    delete buildEnv.APPLE_API_KEY_ID;
    delete buildEnv.APPLE_API_ISSUER;
  }

  if (hostPlatform === "win32") {
    const python = yield* resolvePythonForNodeGyp();

    if (python) {
      buildEnv.PYTHON = python;
      buildEnv.npm_config_python = python;
    }

    buildEnv.npm_config_msvs_version = buildEnv.npm_config_msvs_version ?? "2022";
    buildEnv.GYP_MSVS_VERSION = buildEnv.GYP_MSVS_VERSION ?? "2022";
  }

  if (options.verbose) {
    const debugNamespaces = [
      "electron-builder",
      "electron-builder:*",
      ...(options.platform === "mac" ? ["electron-osx-sign*", "electron-notarize*"] : []),
    ];

    buildEnv.DEBUG = [buildEnv.DEBUG, ...debugNamespaces].filter(Boolean).join(",");
  }

  yield* Effect.log(
    `[desktop-artifact] Building ${options.platform}/${options.target} (arch=${options.arch}, version=${appVersion})...`,
  );

  const builderArgs = [
    "exec",
    "--filter",
    "@akeru/desktop",
    "--",
    "electron-builder",
    "--projectDir",
    stageAppDir,
    platformConfig.cliFlag,
    `--${options.arch}`,
    "--publish",
    "never",
  ];

  const builderCommand = yield* resolveSpawnCommand("vp", builderArgs, { env: buildEnv });
  yield* runCommand(
    ChildProcess.make(builderCommand.command, builderCommand.args, {
      cwd: repoRoot,
      env: buildEnv,
      shell: builderCommand.shell,
    }),
    {
      label: `vp exec --filter @akeru/desktop -- electron-builder --projectDir ${stageAppDir} ${platformConfig.cliFlag} --${options.arch} --publish never`,
      verbose: options.verbose,
    },
  );

  const stageDistDir = path.join(stageAppDir, "dist");

  if (!(yield* fs.exists(stageDistDir))) {
    return yield* new DesktopBuildDistDirectoryMissingError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  // Prove the packaged bundle is self-contained by loading it the way the WSL
  // backend does, rather than by reasoning about the emitted source.
  //
  // Static analysis kept getting this wrong here. Scanning for bare imports
  // matched specifiers inside effect's JSDoc examples and inside ajv's runtime
  // codegen template, and asserting that one sentinel package was inlined
  // missed a build that inlined `effect` while leaving `yaml` external. Node's
  // resolver has no such ambiguity: it either finds every import or it does not.
  //
  // Only Windows unpacks anything; macOS and Linux keep the whole tree inside
  // the app asar. Windows validates and executes the separately packed server
  // sidecar after electron-builder copies it into the final payload.
  if (options.platform === "win") {
    yield* validateWindowsPackagedPayload({
      stageDistDir,
      appExecutableName: `${resolveDesktopProductName()}.exe`,
      targetArch: options.arch,
      verbose: options.verbose,
    });
  }

  const stageEntries = yield* fs.readDirectory(stageDistDir);
  yield* fs.makeDirectory(options.outputDir, { recursive: true });

  const copiedArtifacts: string[] = [];

  for (const entry of stageEntries) {
    const from = path.join(stageDistDir, entry);
    const stat = yield* fs.stat(from).pipe(Effect.orElseSucceed(() => null));

    if (!stat || stat.type !== "File") continue;

    const to = path.join(options.outputDir, entry);
    yield* fs.copyFile(from, to);
    copiedArtifacts.push(to);
  }

  if (copiedArtifacts.length === 0) {
    return yield* new DesktopBuildNoArtifactsProducedError({
      distPath: stageDistDir,
      platform: options.platform,
      arch: options.arch,
    });
  }

  yield* Effect.log("[desktop-artifact] Done. Artifacts:").pipe(
    Effect.annotateLogs({ artifacts: copiedArtifacts }),
  );
});

const buildDesktopArtifactCli = Command.make("build-desktop-artifact", {
  platform: Flag.choice("platform", BuildPlatform.literals).pipe(
    Flag.withDescription("Build platform (env: T3CODE_DESKTOP_PLATFORM)."),
    Flag.optional,
  ),
  target: Flag.string("target").pipe(
    Flag.withDescription(
      "Artifact target, for example dmg/AppImage/nsis (env: T3CODE_DESKTOP_TARGET).",
    ),
    Flag.optional,
  ),
  arch: Flag.choice("arch", BuildArch.literals).pipe(
    Flag.withDescription("Build arch, for example arm64/x64/universal (env: T3CODE_DESKTOP_ARCH)."),
    Flag.optional,
  ),
  buildVersion: Flag.string("build-version").pipe(
    Flag.withDescription("Artifact version metadata (env: T3CODE_DESKTOP_VERSION)."),
    Flag.optional,
  ),
  outputDir: Flag.string("output-dir").pipe(
    Flag.withDescription("Output directory for artifacts (env: T3CODE_DESKTOP_OUTPUT_DIR)."),
    Flag.optional,
  ),
  skipBuild: Flag.boolean("skip-build").pipe(
    Flag.withDescription(
      "Skip `vp run build:desktop` and use existing dist artifacts (env: T3CODE_DESKTOP_SKIP_BUILD).",
    ),
    Flag.optional,
  ),
  keepStage: Flag.boolean("keep-stage").pipe(
    Flag.withDescription("Keep temporary staging files (env: T3CODE_DESKTOP_KEEP_STAGE)."),
    Flag.optional,
  ),
  signed: Flag.boolean("signed").pipe(
    Flag.withDescription(
      "Enable signing/notarization discovery; Windows uses Azure Trusted Signing (env: T3CODE_DESKTOP_SIGNED).",
    ),
    Flag.optional,
  ),
  verbose: Flag.boolean("verbose").pipe(
    Flag.withDescription("Stream subprocess stdout (env: T3CODE_DESKTOP_VERBOSE)."),
    Flag.optional,
  ),
  mockUpdates: Flag.boolean("mock-updates").pipe(
    Flag.withDescription("Enable mock updates (env: T3CODE_DESKTOP_MOCK_UPDATES)."),
    Flag.optional,
  ),
  mockUpdateServerPort: Flag.integer("mock-update-server-port").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
    Flag.withDescription("Mock update server port (env: T3CODE_DESKTOP_MOCK_UPDATE_SERVER_PORT)."),
    Flag.optional,
  ),
  wslPrebuild: Flag.string("wsl-prebuild").pipe(
    Flag.withDescription(
      "Path to a prebuilt Linux node-pty (pty.node) for the target arch, staged for the WSL backend (env: T3CODE_DESKTOP_WSL_PREBUILD).",
    ),
    Flag.optional,
  ),
}).pipe(
  Command.withDescription("Build a desktop artifact for Akeru Bot."),
  Command.withHandler((input) => Effect.flatMap(resolveBuildOptions(input), buildDesktopArtifact)),
);

const cliRuntimeLayer = Layer.mergeAll(Logger.layer([Logger.consolePretty()]), NodeServices.layer);

if (import.meta.main) {
  Command.run(buildDesktopArtifactCli, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(cliRuntimeLayer),
    NodeRuntime.runMain,
  );
}
