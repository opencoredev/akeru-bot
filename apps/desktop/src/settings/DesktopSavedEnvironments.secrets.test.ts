import { assert, describe, it } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import * as Option from "effect/Option";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "./DesktopSavedEnvironments.ts";
import {
  savedRegistryRecord,
  encodeSavedEnvironmentRegistryDocumentProbe,
  withSavedEnvironments,
} from "./test-support/SavedEnvironmentsHarness.ts";

describe("DesktopSavedEnvironments", () => {
  it.effect("persists encrypted saved environment secrets when encryption is available", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.isTrue(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "bearer-token",
          }),
        );

        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );

  it.effect("reports invalid saved secret encoding without exposing the secret", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const fileSystem = yield* FileSystem.FileSystem;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });

        const encoded = yield* encodeSavedEnvironmentRegistryDocumentProbe({
          version: 1,
          records: [{ ...savedRegistryRecord, encryptedBearerToken: "%%%" }],
        });

        yield* fileSystem.writeFileString(environment.savedEnvironmentRegistryPath, `${encoded}\n`);

        const error = yield* savedEnvironments
          .getSecret(savedRegistryRecord.environmentId)
          .pipe(Effect.flip);

        assert.instanceOf(error, DesktopSavedEnvironments.DesktopSavedEnvironmentSecretDecodeError);
        assert.equal(error.environmentId, savedRegistryRecord.environmentId);
        assert.equal(error.registryPath, environment.savedEnvironmentRegistryPath);
        assert.equal(error.field, "encryptedBearerToken");
        assert.exists(error.cause);
        assert.equal(
          error.message,
          `Failed to decode encryptedBearerToken for environment ${savedRegistryRecord.environmentId} at ${environment.savedEnvironmentRegistryPath}.`,
        );
        assert.notInclude(error.message, "%%%");
      }),
    ),
  );

  it.effect("returns false when writing secrets while encryption is unavailable", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.isFalse(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "next-token",
          }),
        );
      }),
      { availableSecretStorage: false },
    ),
  );

  it.effect("adds saved-environment context to safe storage availability failures", () => {
    const cause = new Error("safe storage unavailable");

    return withSavedEnvironments(
      Effect.gen(function* () {
        const environment = yield* DesktopEnvironment.DesktopEnvironment;
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        const error = yield* savedEnvironments
          .setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "next-token",
          })
          .pipe(Effect.flip);

        assert.instanceOf(
          error,
          DesktopSavedEnvironments.DesktopSavedEnvironmentSecretProtectionError,
        );
        assert.equal(error.operation, "check-encryption-availability");
        assert.equal(error.environmentId, savedRegistryRecord.environmentId);
        assert.equal(error.registryPath, environment.savedEnvironmentRegistryPath);
        assert.instanceOf(error.cause, ElectronSafeStorage.ElectronSafeStorageAvailabilityError);

        const availabilityError =
          error.cause as ElectronSafeStorage.ElectronSafeStorageAvailabilityError;

        assert.strictEqual(availabilityError.cause, cause);
        assert.equal(
          error.message,
          `Desktop saved-environment secret protection failed during check-encryption-availability for environment ${savedRegistryRecord.environmentId} at ${environment.savedEnvironmentRegistryPath}.`,
        );
        assert.notEqual(error.message, availabilityError.message);
      }),
      { availabilityError: cause },
    );
  });

  it.effect("removes saved environment secrets", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.removeSecret(savedRegistryRecord.environmentId);

        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("removes saved environment metadata and its embedded secret atomically", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.removeEnvironment(savedRegistryRecord.environmentId);

        assert.deepEqual(yield* savedEnvironments.getRegistry, []);
        assert.isTrue(
          Option.isNone(yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId)),
        );
      }),
    ),
  );

  it.effect("returns false when writing a secret without metadata", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;

        assert.isFalse(
          yield* savedEnvironments.setSecret({
            environmentId: savedRegistryRecord.environmentId,
            secret: "bearer-token",
          }),
        );
      }),
    ),
  );

  it.effect("preserves encrypted secrets when metadata is rewritten", () =>
    withSavedEnvironments(
      Effect.gen(function* () {
        const savedEnvironments = yield* DesktopSavedEnvironments.DesktopSavedEnvironments;
        yield* savedEnvironments.setRegistry([savedRegistryRecord]);
        yield* savedEnvironments.setSecret({
          environmentId: savedRegistryRecord.environmentId,
          secret: "bearer-token",
        });

        yield* savedEnvironments.setRegistry([savedRegistryRecord]);

        assert.deepEqual(yield* savedEnvironments.getRegistry, [savedRegistryRecord]);
        assert.deepEqual(
          yield* savedEnvironments.getSecret(savedRegistryRecord.environmentId),
          Option.some("bearer-token"),
        );
      }),
    ),
  );
});
