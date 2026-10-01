import * as Schema from "effect/Schema";

import { BuildPlatform, BuildArch } from "./model.ts";

export class UnsupportedHostBuildPlatformError extends Schema.TaggedErrorClass<UnsupportedHostBuildPlatformError>()(
  "UnsupportedHostBuildPlatformError",
  {
    hostPlatform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported host platform '${this.hostPlatform}'.`;
  }
}

export class UnsupportedDesktopBuildArchitectureError extends Schema.TaggedErrorClass<UnsupportedDesktopBuildArchitectureError>()(
  "UnsupportedDesktopBuildArchitectureError",
  {
    platform: BuildPlatform,
    arch: BuildArch,
    supportedArchitectures: Schema.Array(BuildArch),
  },
) {
  override get message(): string {
    return `Unsupported architecture '${this.arch}' for ${this.platform}.`;
  }
}

const InvalidMockUpdateServerPortReason = Schema.Literals([
  "not-numeric",
  "not-integer",
  "out-of-range",
]);

export class InvalidMockUpdateServerPortError extends Schema.TaggedErrorClass<InvalidMockUpdateServerPortError>()(
  "InvalidMockUpdateServerPortError",
  {
    reason: InvalidMockUpdateServerPortReason,
    inputLength: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Invalid mock update server port.";
  }

  static fromConfigValue(configuredPort: string, cause: unknown) {
    return new InvalidMockUpdateServerPortError({
      reason: invalidMockUpdateServerPortReason(configuredPort),
      inputLength: configuredPort.length,
      cause,
    });
  }
}

export class BuildCommandFailedError extends Schema.TaggedErrorClass<BuildCommandFailedError>()(
  "BuildCommandFailedError",
  {
    command: Schema.String,
    exitCode: Schema.Int,
    stdoutTail: Schema.optionalKey(Schema.String),
    stderrTail: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    const outputSections = [
      `Command: ${this.command}`,
      formatOutputSection("stdout", this.stdoutTail ?? ""),
      formatOutputSection("stderr", this.stderrTail ?? ""),
    ].filter((section): section is string => section !== undefined);

    const outputSuffix = outputSections.length > 0 ? `\n\n${outputSections.join("\n\n")}` : "";

    return `Command exited with non-zero exit code (${this.exitCode})${outputSuffix}`;
  }
}

export class ResourceMonitorBuildOutputMissingError extends Schema.TaggedErrorClass<ResourceMonitorBuildOutputMissingError>()(
  "ResourceMonitorBuildOutputMissingError",
  {
    binaryPath: Schema.String,
    rustTarget: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Resource monitor build for ${this.rustTarget} did not produce ${this.binaryPath}.`;
  }
}

const desktopIconPlatformNames = {
  mac: "macOS",
  linux: "Linux",
  win: "Windows",
} satisfies Record<typeof BuildPlatform.Type, string>;

export class DesktopIconSourceMissingError extends Schema.TaggedErrorClass<DesktopIconSourceMissingError>()(
  "DesktopIconSourceMissingError",
  {
    platform: BuildPlatform,
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${desktopIconPlatformNames[this.platform]} icon source is missing at ${this.sourcePath}`;
  }
}

export class DesktopDmgBackgroundSourceMissingError extends Schema.TaggedErrorClass<DesktopDmgBackgroundSourceMissingError>()(
  "DesktopDmgBackgroundSourceMissingError",
  {
    channel: Schema.Literal("latest"),
    sourcePath: Schema.String,
  },
) {
  override get message(): string {
    return `Desktop ${this.channel} DMG background source is missing at ${this.sourcePath}`;
  }
}

export class BundledClientAssetsMissingError extends Schema.TaggedErrorClass<BundledClientAssetsMissingError>()(
  "BundledClientAssetsMissingError",
  {
    indexPath: Schema.String,
    missingFiles: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    const preview = this.missingFiles.slice(0, 6).join(", ");
    const suffix = this.missingFiles.length > 6 ? ` (+${this.missingFiles.length - 6} more)` : "";

    return `Bundled client references missing files in ${this.indexPath}: ${preview}${suffix}. Rebuild web/server artifacts.`;
  }
}

export class UnsupportedDesktopBuildPlatformError extends Schema.TaggedErrorClass<UnsupportedDesktopBuildPlatformError>()(
  "UnsupportedDesktopBuildPlatformError",
  {
    platform: Schema.String,
  },
) {
  override get message(): string {
    return `Unsupported platform '${this.platform}'.`;
  }
}

const dependencyResolutionDescriptions = {
  "server-production": "production dependencies",
  "workspace-overrides": "overrides",
  "desktop-runtime": "desktop runtime dependencies",
} as const;

const DependencyResolutionKind = Schema.Literals([
  "server-production",
  "workspace-overrides",
  "desktop-runtime",
]);

export class DesktopBuildDependencyResolutionError extends Schema.TaggedErrorClass<DesktopBuildDependencyResolutionError>()(
  "DesktopBuildDependencyResolutionError",
  {
    kind: DependencyResolutionKind,
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not resolve ${dependencyResolutionDescriptions[this.kind]} from ${this.manifestPath}.`;
  }
}

export class MissingServerProductionDependenciesError extends Schema.TaggedErrorClass<MissingServerProductionDependenciesError>()(
  "MissingServerProductionDependenciesError",
  {
    manifestPath: Schema.String,
  },
) {
  override get message(): string {
    return `Could not resolve production dependencies from ${this.manifestPath}.`;
  }
}

const DesktopBuildInputArtifact = Schema.Literals([
  "desktop-dist",
  "desktop-resources",
  "server-dist",
  "bundled-server-client",
]);

type DesktopBuildInputArtifact = typeof DesktopBuildInputArtifact.Type;

const desktopBuildInputArtifactNames = {
  "desktop-dist": "desktopDist",
  "desktop-resources": "desktopResources",
  "server-dist": "serverDist",
  "bundled-server-client": "bundled server client",
} satisfies Record<DesktopBuildInputArtifact, string>;

export class ExternalizedBundleError extends Schema.TaggedErrorClass<ExternalizedBundleError>()(
  "ExternalizedBundleError",
  { sentinel: Schema.String, inlinedPackageCount: Schema.Number },
) {
  override get message(): string {
    return `The server bundle did not inline "${this.sentinel}" (${this.inlinedPackageCount} packages inlined). The bundle is meant to be self-contained apart from the runtime externals; if its dependencies are external again they will be absent from the sidecar, and the backend will fail with ERR_MODULE_NOT_FOUND. Check the deps.alwaysBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class BundleNotSelfContainedError extends Schema.TaggedErrorClass<BundleNotSelfContainedError>()(
  "BundleNotSelfContainedError",
  { exitCode: Schema.Number, output: Schema.String },
) {
  override get message(): string {
    return `The packaged server bundle could not load from the isolated, extracted sidecar (exit ${this.exitCode}). Anything it imports that is neither a Node built-in nor in the selected runtime-external closure is unavailable to both backends. Output:
${this.output}`;
  }
}

export class InlinedNativePackageError extends Schema.TaggedErrorClass<InlinedNativePackageError>()(
  "InlinedNativePackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that load native binaries: ${this.packages.join(", ")}. A node-gyp-build style loader resolves prebuilds relative to its own file, so inlined into a chunk it finds none and the importer quietly falls back to a slower JS path. Add them to CLI_RUNTIME_EXTERNAL_PREFIXES in scripts/lib/cli-external-packages.ts so they stay external and are staged in the sidecar.`;
  }
}

export class InlinedExternalPackageError extends Schema.TaggedErrorClass<InlinedExternalPackageError>()(
  "InlinedExternalPackageError",
  { packages: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `The server bundle inlined packages that must stay external: ${this.packages.join(", ")}. These are native addons or their loaders; inlined, they resolve prebuilds relative to the bundle and silently lose native acceleration. Check the deps.neverBundle wiring in apps/server/vite.config.ts.`;
  }
}

export class MissingDesktopBuildInputError extends Schema.TaggedErrorClass<MissingDesktopBuildInputError>()(
  "MissingDesktopBuildInputError",
  {
    artifact: DesktopBuildInputArtifact,
    artifactPath: Schema.String,
    buildCommand: Schema.Literal("vp run build:desktop"),
  },
) {
  override get message(): string {
    return `Missing ${desktopBuildInputArtifactNames[this.artifact]} at ${this.artifactPath}. Run '${this.buildCommand}' first.`;
  }
}

export class MacProvisioningProfileNotFoundError extends Schema.TaggedErrorClass<MacProvisioningProfileNotFoundError>()(
  "MacProvisioningProfileNotFoundError",
  {
    provisioningProfilePath: Schema.String,
  },
) {
  override get message(): string {
    return `macOS provisioning profile not found: ${this.provisioningProfilePath}`;
  }
}

export class DesktopBuildDistDirectoryMissingError extends Schema.TaggedErrorClass<DesktopBuildDistDirectoryMissingError>()(
  "DesktopBuildDistDirectoryMissingError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but dist directory was not found at ${this.distPath}`;
  }
}

export class DesktopBuildNoArtifactsProducedError extends Schema.TaggedErrorClass<DesktopBuildNoArtifactsProducedError>()(
  "DesktopBuildNoArtifactsProducedError",
  {
    distPath: Schema.String,
    platform: BuildPlatform,
    arch: BuildArch,
  },
) {
  override get message(): string {
    return `Build completed but no files were produced in ${this.distPath}`;
  }
}

export class WslNodePtyPrebuildMissingError extends Schema.TaggedErrorClass<WslNodePtyPrebuildMissingError>()(
  "WslNodePtyPrebuildMissingError",
  {
    prebuildPath: Schema.String,
  },
) {
  override get message(): string {
    return `WSL node-pty prebuild not found at ${this.prebuildPath}.`;
  }
}

export class WindowsServerSidecarPackError extends Schema.TaggedErrorClass<WindowsServerSidecarPackError>()(
  "WindowsServerSidecarPackError",
  {
    asarPath: Schema.String,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to pack the Windows server sidecar at ${this.asarPath}.`;
  }
}

export class WindowsPrimaryNativeProbeError extends Schema.TaggedErrorClass<WindowsPrimaryNativeProbeError>()(
  "WindowsPrimaryNativeProbeError",
  {
    executablePath: Schema.String,
    exitCode: Schema.Number,
    output: Schema.String,
  },
) {
  override get message(): string {
    return `The packaged Windows primary could not load fff from server.asar (exit ${this.exitCode}). Output:\n${this.output}`;
  }
}

const WindowsPackagedPayloadValidationReason = Schema.Literals([
  "packaged-app-missing",
  "sidecar-missing",
  "sidecar-invalid",
  "unpacked-native-missing",
  "resource-monitor-missing",
  "file-limit-exceeded",
]);

export class WindowsPackagedPayloadValidationError extends Schema.TaggedErrorClass<WindowsPackagedPayloadValidationError>()(
  "WindowsPackagedPayloadValidationError",
  {
    reason: WindowsPackagedPayloadValidationReason,
    packagedAppDir: Schema.String,
    missingFiles: Schema.optionalKey(Schema.Array(Schema.String)),
    fileCount: Schema.optionalKey(Schema.Int),
    fileLimit: Schema.optionalKey(Schema.Int),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    if (this.reason === "file-limit-exceeded") {
      return `Windows packaged payload contains ${String(this.fileCount)} files; expected at most ${String(this.fileLimit)}.`;
    }

    if (this.reason === "unpacked-native-missing") {
      return `Windows server sidecar is missing ${String(this.missingFiles?.length ?? 0)} unpacked native files.`;
    }

    if (this.reason === "resource-monitor-missing") {
      return "Windows packaged payload is missing the resource monitor executable.";
    }

    if (this.reason === "sidecar-invalid") {
      return "Windows packaged payload contains an invalid server.asar sidecar.";
    }

    if (this.reason === "sidecar-missing") {
      return "Windows packaged payload is missing resources/server.asar.";
    }

    return `Windows packaged application directory was not found at ${this.packagedAppDir}.`;
  }
}

export class WslNodePtyManifestReadError extends Schema.TaggedErrorClass<WslNodePtyManifestReadError>()(
  "WslNodePtyManifestReadError",
  {
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not read node-pty version from ${this.manifestPath}.`;
  }
}

export class LinuxIconResizeError extends Schema.TaggedErrorClass<LinuxIconResizeError>()(
  "LinuxIconResizeError",
  {
    operation: Schema.Literal("resize"),
    iconSize: Schema.Int,
    primaryTool: Schema.Literal("magick"),
    fallbackTool: Schema.Literal("convert"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} the Linux desktop icon to ${this.iconSize}x${this.iconSize} with \`${this.primaryTool}\` or \`${this.fallbackTool}\`. Install ImageMagick so either tool is available.`;
  }
}

function formatOutputSection(label: string, output: string): string | undefined {
  const trimmed = output.trim();

  if (!trimmed) return undefined;

  return `${label} tail:\n${trimmed}`;
}

function invalidMockUpdateServerPortReason(
  configuredPort: string,
): typeof InvalidMockUpdateServerPortReason.Type {
  const parsed = Number(configuredPort);

  if (!Number.isFinite(parsed)) return "not-numeric";

  if (!Number.isInteger(parsed)) return "not-integer";

  if (parsed < 1 || parsed > 65535) return "out-of-range";

  // This mapper is only called after schema decoding failed. An otherwise
  // valid integer therefore used a representation the decoder did not accept.
  return "not-numeric";
}
