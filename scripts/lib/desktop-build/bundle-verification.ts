import { extractAll } from "@electron/asar";

import { CLI_LAZY_RUNTIME_PACKAGES } from "../cli-external-packages.ts";

import * as Duration from "effect/Duration";

import * as Effect from "effect/Effect";

import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import { ChildProcess } from "effect/unstable/process";

import { BundleNotSelfContainedError } from "./errors.ts";

import { copyDirectoryPreservingSymlinks, ancestorNodeModulesPaths } from "./workspace.ts";

import { runCommand } from "./process.ts";

/**
 * Imported by every server module, so it is inlined in any correctly bundled
 * build. Its absence means the bundle went back to externalizing its
 * dependencies, which the sidecar's selected runtime closure does not cover.
 */
export const BUNDLE_SELF_CONTAINED_SENTINEL = "effect";

const BUNDLE_SELF_CHECK_TIMEOUT = Duration.seconds(120);

export const verifyPackagedBundleIsSelfContained = Effect.fn("verifyPackagedBundleIsSelfContained")(
  function* (input: {
    readonly asarPath: string;
    readonly pluginCatalogPath: string;
    readonly verbose: boolean;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const probeRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "t3code-bundle-selfcheck-",
    });
    const extractedApp = path.join(probeRoot, "extracted");
    const probeApp = path.join(probeRoot, "app");
    yield* Effect.try({
      try: () => extractAll(input.asarPath, extractedApp),
      catch: (cause) =>
        new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Could not extract ${input.asarPath} for the bundle self-containment check: ${String(cause)}`,
        }),
    });
    // Keep the existing symlink isolation guard even though the sidecar stage
    // is hoisted and should be physical. A future package-manager layout change
    // must not let the probe resolve through the build tree.
    yield* copyDirectoryPreservingSymlinks(extractedApp, probeApp);
    yield* copyDirectoryPreservingSymlinks(
      input.pluginCatalogPath,
      path.join(probeRoot, "plugins"),
    );

    // Guard the guard: if anything above the probe provides a node_modules, a
    // missing dependency would resolve there and the check would pass while the
    // packaged tree is broken.
    for (const candidate of ancestorNodeModulesPaths(probeApp, path.sep)) {
      if (yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false))) {
        return yield* new BundleNotSelfContainedError({
          exitCode: -1,
          output: `Refusing to report success: ${candidate} is visible from the probe directory, so bare imports could resolve outside the packaged tree. Remove or rename it, or point TMPDIR somewhere without one.`,
        });
      }
    }

    const entryPoint = path.join(probeApp, "apps/server/dist/bin.mjs");
    if (!(yield* fs.exists(entryPoint).pipe(Effect.orElseSucceed(() => false)))) {
      return yield* new BundleNotSelfContainedError({
        exitCode: -1,
        output: `Expected the server entry at ${entryPoint}.`,
      });
    }

    // --version exercises the eagerly loaded module graph, which is where a
    // missing dependency shows up, without starting a server or touching disk
    // state. It does not cover lazily imported externals: node-pty is checked
    // by the WSL preflight probe at runtime, while ffi-rs, @ff-labs/fff-node
    // and the bun adapters are covered by the shared runtime-external closure
    // and emitted-bundle checks.
    yield* runCommand(
      ChildProcess.make(
        process.execPath,
        // --no-global-search-paths because clearing NODE_PATH is not enough:
        // CommonJS resolution still falls back to $HOME/.node_modules,
        // $HOME/.node_libraries and the install prefix, so a globally installed
        // copy of a missing dependency would quietly satisfy this check.
        ["--no-global-search-paths", entryPoint, "--version"],
        {
          cwd: probeApp,
          stdout: "pipe",
          stderr: "pipe",
          // NODE_PATH would let a createRequire call inside the bundle resolve
          // a missing external from outside the packaged tree, which is the
          // whole thing this is trying to rule out.
          env: { ...process.env, NODE_PATH: "" },
        },
      ),
      {
        label: "server sidecar self-containment check (node bin.mjs --version)",
        verbose: input.verbose,
      },
    ).pipe(
      // Printing a version should be immediate. A regression that blocks (on
      // stdin, a port, a lock) would otherwise hang release CI until the job
      // times out with nothing useful in the log.
      Effect.timeout(BUNDLE_SELF_CHECK_TIMEOUT),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new BundleNotSelfContainedError({
            exitCode: -1,
            output: `The packaged bundle did not print its version within ${Duration.toSeconds(BUNDLE_SELF_CHECK_TIMEOUT)}s; it is hanging rather than failing to resolve.`,
          }),
        ),
      ),
      Effect.catchTag("BuildCommandFailedError", (error) =>
        Effect.fail(
          new BundleNotSelfContainedError({
            exitCode: error.exitCode,
            output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
          }),
        ),
      ),
    );

    for (const packageName of CLI_LAZY_RUNTIME_PACKAGES) {
      yield* runCommand(
        ChildProcess.make(
          process.execPath,
          [
            "--no-global-search-paths",
            "--input-type=module",
            "--eval",
            "await import(process.argv[1])",
            packageName,
          ],
          {
            cwd: probeApp,
            stdout: "pipe",
            stderr: "pipe",
            env: { ...process.env, NODE_PATH: "" },
          },
        ),
        {
          label: `server sidecar lazy dependency check (${packageName})`,
          verbose: input.verbose,
        },
      ).pipe(
        Effect.catchTag("BuildCommandFailedError", (error) =>
          Effect.fail(
            new BundleNotSelfContainedError({
              exitCode: error.exitCode,
              output: `${error.stderrTail ?? ""}${error.stdoutTail ?? ""}`.trim(),
            }),
          ),
        ),
      );
    }
  },
);
