import { describe, expect, it } from "@effect/vitest";
import { HostProcessPlatform } from "@akeru/shared/hostProcess";
import { SpawnExecutableResolution } from "@akeru/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { ClaudeExecutableFileCheck, resolveClaudeSdkExecutablePath } from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";

const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;

const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;

const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
}) {
  const existing = new Set(input.existingFiles ?? []);

  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcessPlatform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) =>
        Effect.succeed(existing.has(filePath)),
      ),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("uses filesystem metadata to skip directories and missing package entries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped();
      const cli = path.join(directory, "cli.js");
      yield* fileSystem.writeFileString(cli, "");

      const resolve = resolveClaudeSdkExecutablePath("claude", {}).pipe(
        Effect.provideService(HostProcessPlatform, "win32"),
        Effect.provideService(SpawnExecutableResolution, () => NPM_SHIM),
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          stat: (candidate) => fileSystem.stat(candidate === NPM_PACKAGE_EXE ? directory : cli),
        }),
      );

      expect(yield* resolve).toBe(NPM_PACKAGE_CLI);
      yield* fileSystem.remove(cli);
      expect(yield* resolve).toBe("claude");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the configured path unchanged on non-Windows platforms", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(SpawnExecutableResolution, () => {
            throw new Error("must not resolve on non-Windows platforms");
          }),
        ),
      ).toBe("claude");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the resolved absolute path for native Windows executables", () =>
    Effect.gen(function* () {
      const nativeBinary = "C:\\Users\\dev\\.local\\bin\\claude.exe";
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: nativeBinary }),
        ),
      ).toBe(nativeBinary);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows an npm launcher shim to the packaged native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_EXE, NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("follows .bat and .ps1 launcher shims the same way", () =>
    Effect.gen(function* () {
      for (const shim of [`${NPM_DIR}\\claude.bat`, `${NPM_DIR}\\claude.ps1`]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [NPM_PACKAGE_EXE],
            }),
          ),
        ).toBe(NPM_PACKAGE_EXE);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("normalizes mixed-case shim extensions before matching", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: `${NPM_DIR}\\claude.CMD`,
            existingFiles: [NPM_PACKAGE_EXE],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("falls back to cli.js when the package ships no native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_CLI);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the configured path when a shim has no known package entry", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM }),
        ),
      ).toBe("claude");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns the configured path when command resolution finds nothing", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: undefined }),
        ),
      ).toBe("claude");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
