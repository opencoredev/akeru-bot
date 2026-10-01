import { resolveSpawnCommand } from "@akeru/shared/shell";

import * as Config from "effect/Config";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import { ChildProcess } from "effect/unstable/process";

import { BuildPlatform, BuildArch } from "./model.ts";

import { runCommand } from "./process.ts";

import { ResourceMonitorBuildOutputMissingError } from "./errors.ts";

export function resolveResourceMonitorRustTargets(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
): ReadonlyArray<string> {
  if (platform === "mac") {
    if (arch === "universal") {
      return ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    }
    return [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
  }
  if (platform === "linux") {
    return [arch === "arm64" ? "aarch64-unknown-linux-gnu" : "x86_64-unknown-linux-gnu"];
  }
  return [arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc"];
}

export function resourceMonitorExecutableName(platform: typeof BuildPlatform.Type): string {
  return platform === "win" ? "t3-resource-monitor.exe" : "t3-resource-monitor";
}

export function resolveResourceMonitorCargoBuildArgs(
  manifestPath: string,
  targetDirectory: string,
  rustTarget: string,
): ReadonlyArray<string> {
  return [
    "build",
    "--locked",
    "--release",
    "--manifest-path",
    manifestPath,
    "--target-dir",
    targetDirectory,
    "--target",
    rustTarget,
  ];
}

export const stageResourceMonitor = Effect.fn("stageResourceMonitor")(function* (input: {
  readonly repoRoot: string;
  readonly stageResourcesDir: string;
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly verbose: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const manifestPath = path.join(input.repoRoot, "native/resource-monitor/Cargo.toml");
  const targetDirectory = path.join(input.repoRoot, "native/resource-monitor/target");
  const executableName = resourceMonitorExecutableName(input.platform);
  const rustTargets = resolveResourceMonitorRustTargets(input.platform, input.arch);
  const reuseResourceMonitor = yield* Config.boolean("T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR").pipe(
    Config.withDefault(false),
  );
  const builtBinaries: string[] = [];

  for (const rustTarget of rustTargets) {
    if (!reuseResourceMonitor) {
      const spawnCommand = yield* resolveSpawnCommand(
        "cargo",
        resolveResourceMonitorCargoBuildArgs(manifestPath, targetDirectory, rustTarget),
      );
      yield* runCommand(
        ChildProcess.make(spawnCommand.command, spawnCommand.args, {
          cwd: input.repoRoot,
          shell: spawnCommand.shell,
        }),
        {
          label: `cargo build resource monitor (${rustTarget})`,
          verbose: input.verbose,
        },
      );
    }

    const binaryPath = path.join(targetDirectory, rustTarget, "release", executableName);
    if (!(yield* fs.exists(binaryPath))) {
      return yield* new ResourceMonitorBuildOutputMissingError({
        binaryPath,
        rustTarget,
        platform: input.platform,
        arch: input.arch,
      });
    }
    if (reuseResourceMonitor) {
      yield* Effect.log(`[desktop-artifact] Reusing cached resource monitor (${rustTarget}).`);
    }
    builtBinaries.push(binaryPath);
  }

  const destinationDirectory = path.join(input.stageResourcesDir, "resource-monitor");
  const destinationPath = path.join(destinationDirectory, executableName);
  yield* fs.remove(destinationDirectory, { recursive: true, force: true }).pipe(Effect.ignore);
  yield* fs.makeDirectory(destinationDirectory, { recursive: true });

  if (builtBinaries.length === 1) {
    yield* fs.copyFile(builtBinaries[0]!, destinationPath);
  } else {
    yield* runCommand(
      ChildProcess.make("lipo", ["-create", ...builtBinaries, "-output", destinationPath]),
      {
        label: "lipo resource monitor universal binary",
        verbose: input.verbose,
      },
    );
  }

  if (input.platform !== "win") {
    yield* fs.chmod(destinationPath, 0o755);
  }
});
