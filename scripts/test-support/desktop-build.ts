import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, it } from "@effect/vitest";

import * as FileSystem from "effect/FileSystem";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import * as Path from "effect/Path";

import * as Sink from "effect/Sink";

import * as Stream from "effect/Stream";

import { ChildProcessSpawner } from "effect/unstable/process";

import {
  packWindowsServerAsar,
  ancestorNodeModulesPaths,
  copyDirectoryPreservingSymlinks,
  WINDOWS_SERVER_ASAR_RESOURCE,
} from "../build-desktop-artifact.ts";

export function mockProcess(exitCode: number) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

export function iconResizeSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  exitCodes: ReadonlyArray<number>,
) {
  let commandIndex = 0;
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(mockProcess(exitCodes[commandIndex++] ?? 0));
    }),
  );
}

export const makeWindowsPayloadFixture = Effect.fn("test.makeWindowsPayloadFixture")(
  function* (input: {
    readonly copyUnpackedNatives: boolean;
    readonly includeLazyRuntimePackage?: boolean;
    readonly serverEntrySource?: string;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const tempDir = yield* fs.makeTempDirectoryScoped({
      prefix: "t3-windows-payload-test-",
    });
    const sourceDir = path.join(tempDir, "server-source");
    const serverEntryPath = path.join(sourceDir, "apps/server/dist/bin.mjs");
    const nativePath = path.join(sourceDir, "node_modules/native/addon.node");
    const execaManifestPath = path.join(sourceDir, "node_modules/execa/package.json");
    yield* fs.makeDirectory(path.dirname(serverEntryPath), { recursive: true });
    yield* fs.makeDirectory(path.dirname(nativePath), { recursive: true });
    yield* fs.writeFileString(
      serverEntryPath,
      input.serverEntrySource ??
        'import { readdirSync } from "node:fs";\nreaddirSync(new URL("../../../../plugins/entries/", import.meta.url));\nconsole.log("server");\n',
    );
    yield* fs.writeFileString(nativePath, "native-binary");
    if (input.includeLazyRuntimePackage !== false) {
      yield* fs.makeDirectory(path.dirname(execaManifestPath), { recursive: true });
      yield* fs.writeFileString(
        execaManifestPath,
        '{"name":"execa","version":"9.6.1","type":"module","exports":"./index.js"}',
      );
      yield* fs.writeFileString(
        path.join(sourceDir, "node_modules/execa/index.js"),
        "export const execa = () => undefined;\n",
      );
    }

    const generatedAsarPath = path.join(tempDir, WINDOWS_SERVER_ASAR_RESOURCE);
    yield* packWindowsServerAsar({ sourceDir, asarPath: generatedAsarPath, arch: "x64" });

    const stageDistDir = path.join(tempDir, "dist");
    const packagedAppDir = path.join(stageDistDir, "win-unpacked");
    const resourcesDir = path.join(packagedAppDir, "resources");
    yield* fs.makeDirectory(path.join(resourcesDir, "resource-monitor"), { recursive: true });
    yield* fs.makeDirectory(path.join(resourcesDir, "plugins/entries/example"), {
      recursive: true,
    });
    yield* fs.copyFile(generatedAsarPath, path.join(resourcesDir, WINDOWS_SERVER_ASAR_RESOURCE));
    if (input.copyUnpackedNatives) {
      yield* fs.copy(
        `${generatedAsarPath}.unpacked`,
        path.join(resourcesDir, `${WINDOWS_SERVER_ASAR_RESOURCE}.unpacked`),
      );
    }
    yield* fs.writeFileString(
      path.join(resourcesDir, "resource-monitor/t3-resource-monitor.exe"),
      "monitor",
    );
    yield* fs.writeFileString(path.join(resourcesDir, "plugins/entries/example/plugin.json"), "{}");
    const appExecutableName = "t3code.exe";
    yield* fs.writeFileString(path.join(packagedAppDir, appExecutableName), "electron");
    yield* fs.writeFileString(path.join(packagedAppDir, "chrome_crashpad_handler.exe"), "crashpad");

    return {
      stageDistDir,
      packagedAppDir,
      sourceDir,
      generatedAsarPath,
      appExecutableName,
    } as const;
  },
);

// The self-containment check runs the packaged tree in a scratch directory. Its
// own node_modules holds the sidecar externals and must be ignored, but any
// node_modules *above* it would let Node's parent walk satisfy an import that is
// missing from the package, so the probe refuses to run in that case.
it("lists ancestor node_modules, nearest first, excluding the start directory", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"), [
    "C:\\tmp\\probe\\node_modules",
    "C:\\tmp\\node_modules",
    "C:\\node_modules",
  ]);
});

it("includes the filesystem root for posix paths", () => {
  assert.deepStrictEqual(ancestorNodeModulesPaths("/tmp/probe", "/"), [
    "/tmp/node_modules",
    "/node_modules",
  ]);
});

// A UNC root must keep its \\server\share prefix. Rebuilding it from segments
// produced relative paths, which fs.exists resolves against the build cwd, so
// the guard checked directories that do not exist and silently passed.
it("keeps the prefix of a UNC path instead of going relative", () => {
  const paths = ancestorNodeModulesPaths("\\\\server\\share\\tmp\\app", "\\");
  for (const candidate of paths) {
    assert.ok(candidate.startsWith("\\\\server\\share"), candidate);
  }
  assert.deepStrictEqual(paths[0], "\\\\server\\share\\tmp\\node_modules");
});

it.effect("rebases packaged links into the isolated tree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-copy-symlinks-" });
    const source = path.join(root, "source");
    const destination = path.join(root, "destination");
    const packageDir = path.join(source, "node_modules/.pnpm/example@1/node_modules/example");
    const relativePackageLink = path.join(source, "node_modules/example-relative");
    const absolutePackageLink = path.join(source, "node_modules/example-absolute");

    yield* fs.makeDirectory(packageDir, { recursive: true });
    yield* fs.writeFileString(path.join(packageDir, "index.js"), "module.exports = true;\n");
    yield* fs.symlink(
      path.join(".pnpm", "example@1", "node_modules", "example"),
      relativePackageLink,
    );
    yield* fs.symlink(packageDir, absolutePackageLink);

    yield* copyDirectoryPreservingSymlinks(source, destination);

    const copiedPackage = path.join(
      destination,
      "node_modules/.pnpm/example@1/node_modules/example",
    );
    const resolvedCopiedPackage = yield* fs.realPath(copiedPackage);
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-relative")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.readLink(path.join(destination, "node_modules/example-absolute")),
      copiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-relative")),
      resolvedCopiedPackage,
    );
    assert.equal(
      yield* fs.realPath(path.join(destination, "node_modules/example-absolute")),
      resolvedCopiedPackage,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it("ignores trailing separators", () => {
  assert.deepStrictEqual(
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app\\", "\\"),
    ancestorNodeModulesPaths("C:\\tmp\\probe\\app", "\\"),
  );
});
