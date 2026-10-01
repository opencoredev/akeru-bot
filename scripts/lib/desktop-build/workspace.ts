// @effect-diagnostics nodeBuiltinImport:off - Node's typed junction API avoids Windows symlink privileges while keeping the probe isolated.
// @effect-diagnostics nodeBuiltinImport:off - Node's typed junction API avoids Windows symlink privileges while keeping the probe isolated.
import * as NodeFSP from "node:fs/promises";

import { fromYaml } from "@akeru/shared/schemaYaml";

import { selectCliPackagedRuntimeDependencies } from "../cli-external-packages.ts";

import { resolveCatalogDependencies } from "../resolve-catalog.ts";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Option from "effect/Option";

import type { PlatformError } from "effect/PlatformError";

import * as Path from "effect/Path";

import * as Schema from "effect/Schema";

import { RepoRoot, BuildPlatform, BuildArch } from "./model.ts";

import { BundleNotSelfContainedError } from "./errors.ts";

const WorkspaceConfig = Schema.Struct({
  catalog: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
});

type WorkspaceConfig = typeof WorkspaceConfig.Type;

const StageWorkspaceConfig = Schema.Struct({
  supportedArchitectures: Schema.Struct({
    os: Schema.Array(Schema.String),
    cpu: Schema.Array(Schema.String),
    libc: Schema.optional(Schema.Array(Schema.String)),
  }),
  // pnpm 11 only reads these from pnpm-workspace.yaml (not package.json#pnpm).
  // Without allowBuilds the staged `vp install --prod` fails with
  // ERR_PNPM_IGNORED_BUILDS for packages that have lifecycle scripts.
  allowBuilds: Schema.optional(Schema.Record(Schema.String, Schema.Boolean)),
  patchedDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  nodeLinker: Schema.optional(Schema.Literals(["hoisted"])),
});

type StageWorkspaceConfig = typeof StageWorkspaceConfig.Type;

const decodeWorkspaceConfig = Schema.decodeEffect(fromYaml(WorkspaceConfig));

export const encodeStageWorkspaceConfig = Schema.encodeEffect(fromYaml(StageWorkspaceConfig));

export const readWorkspaceConfig = Effect.fn("readWorkspaceConfig")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const repoRoot = yield* RepoRoot;
  const workspaceYaml = yield* fs.readFileString(path.join(repoRoot, "pnpm-workspace.yaml"));

  return yield* decodeWorkspaceConfig(workspaceYaml);
});

export interface StagePackageJson {
  readonly name: string;
  readonly version: string;
  readonly buildVersion: string;
  readonly t3codeCommitHash: string;
  readonly private: true;
  readonly packageManager: string;
  readonly description: string;
  readonly author: string;
  readonly license: string;
  readonly main: string;
  readonly build: Record<string, unknown>;
  readonly dependencies: Record<string, unknown>;
  readonly devDependencies: {
    readonly electron: string;
  };
}

export const STAGE_INSTALL_ARGS = ["install", "--prod"] as const;

export function resolveFffNativeDependencies(
  platform: typeof BuildPlatform.Type,
  arch: typeof BuildArch.Type,
  version: string,
): Record<string, string> {
  const architectures = arch === "universal" ? (["arm64", "x64"] as const) : [arch];

  if (platform === "mac") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-darwin-${architecture}`, version]),
    );
  }

  if (platform === "win") {
    return Object.fromEntries(
      architectures.map((architecture) => [`@ff-labs/fff-bin-win32-${architecture}`, version]),
    );
  }

  return Object.fromEntries(
    architectures.flatMap((architecture) =>
      ["gnu", "musl"].map((libc) => [`@ff-labs/fff-bin-linux-${architecture}-${libc}`, version]),
    ),
  );
}

export function resolveMacStageDependencies(input: {
  readonly serverDependencies: Record<string, string>;
  readonly desktopDependencies: Record<string, string>;
  readonly arch: typeof BuildArch.Type;
  readonly fffNodeVersion: string;
}) {
  return {
    ...selectCliPackagedRuntimeDependencies(input.serverDependencies),
    ...input.desktopDependencies,
    ...resolveFffNativeDependencies("mac", input.arch, input.fffNodeVersion),
  };
}

export function createStageWorkspaceConfig(input: {
  readonly platform: typeof BuildPlatform.Type;
  readonly arch: typeof BuildArch.Type;
  readonly allowBuilds?: Record<string, boolean>;
  readonly patchedDependencies?: Record<string, string>;
  readonly overrides?: Record<string, string>;
  // The Windows server sidecar stage runs both the Windows primary and the
  // WSL Linux backend from one dependency tree, so it needs win32 + linux
  // natives (e.g. @yuuang/ffi-rs-linux-x64-gnu) — and a hoisted (physical,
  // symlink-free) node_modules: the tree gets packed into server.asar and
  // later extracted for WSL, and neither step can rely on pnpm's
  // symlink/junction layout surviving the trip.
  readonly linuxServerBackend?: boolean;
}): StageWorkspaceConfig {
  const { platform, arch, allowBuilds, patchedDependencies, overrides, linuxServerBackend } = input;
  const hostOs = platform === "mac" ? "darwin" : platform === "win" ? "win32" : "linux";
  const hostCpu = arch === "universal" ? ["arm64", "x64"] : [arch];

  // Linux AppImages execute a Linux/glibc Node process that loads
  // Linux-native optional deps at runtime. Keep libc explicit so pnpm
  // includes those optional packages in the staged production install.
  const supportedArchitectures =
    platform === "linux"
      ? {
          os: [hostOs],
          cpu: hostCpu,
          libc: ["glibc"],
        }
      : linuxServerBackend
        ? {
            os: Array.from(new Set([hostOs, "linux"])),
            cpu: hostCpu,
            libc: ["glibc"],
          }
        : {
            os: [hostOs],
            cpu: hostCpu,
          };

  return {
    supportedArchitectures,
    ...(allowBuilds && Object.keys(allowBuilds).length > 0 ? { allowBuilds } : {}),
    ...(patchedDependencies && Object.keys(patchedDependencies).length > 0
      ? { patchedDependencies }
      : {}),
    ...(overrides && Object.keys(overrides).length > 0 ? { overrides } : {}),
    ...(linuxServerBackend ? { nodeLinker: "hoisted" as const } : {}),
  };
}

export function createStagePatchedDependencies(
  patchedDependencies: Record<string, string>,
  dependencies: Record<string, unknown>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(patchedDependencies).filter(([patchKey]) =>
      Object.hasOwn(dependencies, getPatchedDependencyPackageName(patchKey)),
    ),
  );
}

function getPatchedDependencyPackageName(patchKey: string): string {
  const versionSeparator = patchKey.lastIndexOf("@");

  return versionSeparator > 0 ? patchKey.slice(0, versionSeparator) : patchKey;
}

/**
 * Every `node_modules` directory that would be visible from `startDir`.
 *
 * The self-containment check is only meaningful in a directory with none of
 * these: Node walks parents when resolving a bare import, so a stray
 * node_modules above the probe would satisfy imports that are missing from the
 * packaged tree and turn the check into a silent pass.
 */
function trimTrailingSeparators(value: string): string {
  let end = value.length;

  while (end > 1 && (value[end - 1] === "/" || value[end - 1] === "\\")) end -= 1;

  return value.slice(0, end);
}

/**
 * Length of the `\\server\share` prefix, or 0 when the path is not UNC.
 *
 * The share is the highest real directory on a UNC path: `\\server` on its own
 * is not one, so the ancestor walk must stop there.
 */
function uncShareRootLength(value: string): number {
  const isUnc = value.startsWith("\\\\") || value.startsWith("//");

  if (!isUnc) return 0;
  const separator = /[\\/]/;
  const serverEnd = value.slice(2).search(separator);

  if (serverEnd < 0) return value.length;
  const shareStart = 2 + serverEnd + 1;
  const shareEnd = value.slice(shareStart).search(separator);

  return shareEnd < 0 ? value.length : shareStart + shareEnd;
}

export function ancestorNodeModulesPaths(
  startDir: string,
  separator: string,
): ReadonlyArray<string> {
  // Walks with lastIndexOf rather than splitting into segments so UNC roots
  // (\\server\share) and drive roots keep their prefix instead of being
  // rebuilt into a relative path that silently resolves against the build cwd.
  const paths: string[] = [];
  let current = trimTrailingSeparators(startDir);
  // On a UNC path the share itself is the root: \\server is not a directory, so
  // walking past \\server\share would emit paths that cannot exist.
  const uncRootLength = uncShareRootLength(current);

  for (;;) {
    const cut = Math.max(current.lastIndexOf("/"), current.lastIndexOf("\\"));

    if (cut < 0 || (uncRootLength > 0 && cut < uncRootLength)) break;
    const parent = cut === 0 ? current.slice(0, 1) : current.slice(0, cut);

    if (parent === current) break;
    paths.push(
      parent.endsWith(separator) ? `${parent}node_modules` : `${parent}${separator}node_modules`,
    );

    if (cut === 0) break;
    current = parent;
  }

  return paths;
}

const NativeMarkerManifest = Schema.Struct({
  dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  optionalDependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
});

const decodeNativeMarkerManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(NativeMarkerManifest),
);

/** Locate a package inside the pnpm store, which is where the real files live. */
export const findStorePackageDirectory = Effect.fn("findStorePackageDirectory")(function* (
  repoRoot: string,
  packageName: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const storeDir = path.join(repoRoot, "node_modules/.pnpm");

  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (!(yield* exists(storeDir))) return null;

  const flattened = `${packageName.replace("/", "+")}@`;

  const entries = yield* fs
    .readDirectory(storeDir)
    .pipe(Effect.orElseSucceed(() => [] as string[]));

  for (const entry of entries) {
    if (!entry.startsWith(flattened)) continue;
    const candidate = path.join(storeDir, entry, "node_modules", packageName);

    if (yield* exists(candidate)) return candidate;
  }

  return null;
});

/** Whether a package builds or ships a native addon it loads at runtime. */
export const hasNativeLoaderMarkers = Effect.fn("hasNativeLoaderMarkers")(function* (
  packageDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const exists = (candidate: string) =>
    fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));

  if (yield* exists(path.join(packageDir, "binding.gyp"))) return true;

  if (yield* exists(path.join(packageDir, "prebuilds"))) return true;

  const manifestPath = path.join(packageDir, "package.json");

  if (!(yield* exists(manifestPath))) return false;
  const source = yield* fs.readFileString(manifestPath).pipe(Effect.orElseSucceed(() => ""));

  if (source === "") return false;

  const manifest = yield* Effect.try(() => decodeNativeMarkerManifest(source)).pipe(
    Effect.orElseSucceed(() => null),
  );

  if (manifest === null) return false;

  return Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies }).some(
    (dependency) => dependency.startsWith("node-gyp-build"),
  );
});

export const copyDirectoryPreservingSymlinks = Effect.fn("copyDirectoryPreservingSymlinks")(
  function* (source: string, destination: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Effect's Node implementation delegates directory copies to fs.cp, whose
    // default rewrites links into absolute source-tree references. Recreate every
    // in-tree directory link as a junction rooted in the isolated copy so the
    // probe cannot resolve through staging and Windows needs no symlink privilege.
    yield* fs.copy(source, destination);

    const restoreRelativeSymlinks = (
      sourceDirectory: string,
      destinationDirectory: string,
    ): Effect.Effect<void, PlatformError | BundleNotSelfContainedError> =>
      Effect.gen(function* () {
        for (const entry of yield* fs.readDirectory(sourceDirectory)) {
          const sourceEntry = path.join(sourceDirectory, entry);
          const destinationEntry = path.join(destinationDirectory, entry);
          const linkTarget = yield* fs.readLink(sourceEntry).pipe(Effect.option);

          if (Option.isSome(linkTarget)) {
            const absoluteSourceTarget = path.isAbsolute(linkTarget.value)
              ? linkTarget.value
              : path.resolve(path.dirname(sourceEntry), linkTarget.value);

            const sourceRelativeTarget = path.relative(source, absoluteSourceTarget);

            if (
              sourceRelativeTarget === ".." ||
              sourceRelativeTarget.startsWith(`..${path.sep}`) ||
              path.isAbsolute(sourceRelativeTarget)
            ) {
              return yield* new BundleNotSelfContainedError({
                exitCode: -1,
                output: `Refusing to copy symlink ${sourceEntry}: its target ${absoluteSourceTarget} escapes the packaged tree.`,
              });
            }

            const target = path.join(destination, sourceRelativeTarget);
            yield* fs.remove(destinationEntry, { recursive: true, force: true });
            yield* Effect.tryPromise({
              try: () => NodeFSP.symlink(target, destinationEntry, "junction"),
              catch: (cause) =>
                new BundleNotSelfContainedError({
                  exitCode: -1,
                  output: `Could not isolate ${sourceEntry}: ${String(cause)}`,
                }),
            });
          } else {
            const info = yield* fs.stat(sourceEntry);

            if (info.type === "Directory") {
              yield* restoreRelativeSymlinks(sourceEntry, destinationEntry);
            }
          }
        }
      });

    yield* restoreRelativeSymlinks(source, destination);
  },
);

export function resolveDesktopRuntimeDependencies(
  dependencies: Record<string, string> | undefined,
  catalog: Record<string, string>,
): Record<string, string> {
  if (!dependencies || Object.keys(dependencies).length === 0) {
    return {};
  }

  const runtimeDependencies = Object.fromEntries(
    Object.entries(dependencies).filter(
      ([dependencyName, dependencySpec]) =>
        dependencyName !== "electron" && !dependencySpec.startsWith("workspace:"),
    ),
  );

  return resolveCatalogDependencies(runtimeDependencies, catalog, "apps/desktop");
}
