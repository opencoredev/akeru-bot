import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopAppSettings from "./DesktopAppSettings.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";

describe("desktop atomic writes", () => {
  for (const target of ["settings", "registry"] as const) {
    for (const failure of ["write", "rename", "none"] as const) {
      for (const cleanupFails of [false, true]) {
        it.effect(`${target}: cleans up after ${failure}, cleanup failure=${cleanupFails}`, () =>
          Effect.gen(function* () {
            const baseFileSystem = yield* FileSystem.FileSystem;
            const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
              prefix: "akeru-atomic-writes-",
            });
            const removedPaths: string[] = [];
            const writeError = PlatformError.systemError({
              _tag: "PermissionDenied",
              module: "FileSystem",
              method: failure === "write" ? "writeFileString" : "rename",
              pathOrDescriptor: baseDir,
            });
            const fileSystemLayer = Layer.succeed(FileSystem.FileSystem, {
              ...baseFileSystem,
              writeFileString: (path, contents, options) =>
                baseFileSystem
                  .writeFileString(path, contents, options)
                  .pipe(
                    Effect.andThen(failure === "write" ? Effect.fail(writeError) : Effect.void),
                  ),
              rename: (source, destination) =>
                failure === "rename"
                  ? Effect.fail(writeError)
                  : baseFileSystem.rename(source, destination),
              remove: (path, options) => {
                removedPaths.push(String(path));
                return baseFileSystem
                  .remove(path, options)
                  .pipe(Effect.andThen(cleanupFails ? Effect.fail(writeError) : Effect.void));
              },
            });
            const environmentLayer = DesktopEnvironment.layer({
              dirname: "/repo/apps/desktop/src",
              homeDirectory: baseDir,
              platform: "darwin",
              processArch: "x64",
              appVersion: "1.2.3",
              appPath: "/repo",
              isPackaged: true,
              resourcesPath: "/missing/resources",
              runningUnderArm64Translation: false,
            }).pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  DesktopConfig.layerTest({ T3CODE_HOME: baseDir }),
                ),
              ),
            );
            const dependencies = Layer.mergeAll(
              NodeServices.layer,
              environmentLayer,
              fileSystemLayer,
              Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
                isEncryptionAvailable: Effect.succeed(false),
                encryptString: (value) => Effect.succeed(new TextEncoder().encode(value)),
                decryptString: (value) => Effect.succeed(new TextDecoder().decode(value)),
                selectedStorageBackend: Effect.succeed(Option.none()),
              }),
            );
            const save = Effect.gen(function* () {
              if (target === "settings") {
                yield* Effect.gen(function* () {
                  const settings = yield* DesktopAppSettings.DesktopAppSettings;
                  yield* settings.setServerExposureMode("network-accessible");
                }).pipe(Effect.provide(DesktopAppSettings.layer.pipe(Layer.provide(dependencies))));
              } else {
                yield* Effect.gen(function* () {
                  const registry = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
                  yield* registry.setRegistry([]);
                }).pipe(
                  Effect.provide(DesktopSavedEnvironments.layer.pipe(Layer.provide(dependencies))),
                );
              }
            });

            if (failure === "none") {
              yield* save;
            } else {
              const error = yield* save.pipe(Effect.flip);
              if (
                !Schema.is(DesktopAppSettings.DesktopSettingsWriteError)(error) &&
                !Schema.is(DesktopSavedEnvironments.DesktopSavedEnvironmentsWriteError)(error)
              ) {
                assert.fail(`Unexpected save error: ${error._tag}`);
                return;
              }
              assert.equal(
                error.operation,
                failure === "write"
                  ? "write-temporary-file"
                  : target === "settings"
                    ? "replace-settings-file"
                    : "replace-registry-file",
              );
              assert.strictEqual(error.cause, writeError);
            }
            assert.lengthOf(removedPaths, 1);
            const tempPath = removedPaths[0]!;
            assert.isTrue(tempPath.startsWith(`${baseDir}/userdata/`));
            assert.isTrue(tempPath.endsWith(".tmp"));
            assert.isFalse(yield* baseFileSystem.exists(tempPath));
            assert.isTrue(yield* baseFileSystem.exists(`${baseDir}/userdata`));
          }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
        );
      }
    }
  }
});
