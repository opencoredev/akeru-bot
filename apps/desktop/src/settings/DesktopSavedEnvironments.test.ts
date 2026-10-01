import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";
import {
  savedRegistryRecord,
  decodeSavedEnvironmentRegistryDocumentProbe,
  makeLayer,
  withSavedEnvironments,
} from "./test-support/SavedEnvironmentsHarness.ts";
describe("DesktopSavedEnvironments", () => {
  it.effect("persists and reloads saved environment metadata", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        const persisted = yield* decodeSavedEnvironmentRegistryDocumentProbe(
          yield* fileSystem.readFileString(environment.savedEnvironmentRegistryPath),
        );
        assert.equal(persisted.version, 1);
        assert.lengthOf(persisted.records, 1);
      }),
    ),
  );

  it.effect("loads lenient saved environment registry documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(
          environment.savedEnvironmentRegistryPath,
          `{
            // Same optional envelope shape as browser saved environments.
            "version": 1,
            "records": [
              {
                "environmentId": "${savedRegistryRecord.environmentId}",
                "label": "Remote environment",
                "httpBaseUrl": "https://remote.example.com/",
                "wsBaseUrl": "wss://remote.example.com/",
                "createdAt": "2026-04-09T00:00:00.000Z",
                "lastConnectedAt": "2026-04-09T01:00:00.000Z",
                "desktopSsh": {
                  "alias": "devbox",
                  "hostname": "devbox.example.com",
                  "username": "julius",
                  "port": 22,
                },
              },
            ],
          }\n`,
        );

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
      }),
    ),
  );

  it.effect("treats empty saved environment documents as empty", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{}\n");

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("surfaces malformed saved environment documents", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, "{not-json");

        const registryError = yield* savedEnvironments.getRegistry.pipe(Effect.flip);
        assert.instanceOf(
          registryError,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        assert.equal(registryError.registryPath, environment.savedEnvironmentRegistryPath);
        assert.exists(registryError.cause);
        const secretError = yield* savedEnvironments
          .getSecret(savedRegistryRecord.environmentId)
          .pipe(Effect.flip);
        assert.instanceOf(
          secretError,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
        const mutationError = yield* savedEnvironments
          .setRegistry([savedRegistryRecord])
          .pipe(Effect.flip);
        assert.instanceOf(
          mutationError,
          DesktopSavedEnvironments.DesktopSavedEnvironmentsDocumentDecodeError,
        );
      }),
    ),
  );

  it.effect("reports saved environment filesystem reads separately from document decoding", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-saved-environments-test-",
      });
      const registryPath = `${baseDir}/userdata/saved-environments.json`;
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "readFileString",
        pathOrDescriptor: registryPath,
      });
      const fileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.fail(permissionError),
        }),
      );
      const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments.pipe(
        Effect.provide(makeLayer(baseDir, undefined, fileSystemLayer)),
      );

      const error = yield* savedEnvironments.getRegistry.pipe(Effect.flip);
      assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentsReadError);
      assert.equal(error.registryPath, registryPath);
      assert.strictEqual(error.cause, permissionError);
      assert.equal(error.message, `Failed to read desktop saved environments at ${registryPath}.`);
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("reports the failed saved environment write operation and path", () =>
    Effect.gen(function* () {
      const baseFileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* baseFileSystem.makeTempDirectoryScoped({
        prefix: "t3-desktop-saved-environments-test-",
      });
      const permissionError = PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeDirectory",
        pathOrDescriptor: `${baseDir}/userdata`,
      });
      const fileSystemLayer = Layer.succeed(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: baseFileSystem.readFileString,
          makeDirectory: () => Effect.fail(permissionError),
        }),
      );
      const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments.pipe(
        Effect.provide(makeLayer(baseDir, undefined, fileSystemLayer)),
      );

      const error = yield* savedEnvironments.setRegistry([savedRegistryRecord]).pipe(Effect.flip);
      assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentsWriteError);
      assert.equal(error.operation, "create-directory");
      assert.equal(error.path, `${baseDir}/userdata`);
      assert.strictEqual(error.cause, permissionError);
      assert.equal(
        error.message,
        `Desktop saved-environment write failed during create-directory at ${baseDir}/userdata.`,
      );
      assert.notEqual(error.message, permissionError.message);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
