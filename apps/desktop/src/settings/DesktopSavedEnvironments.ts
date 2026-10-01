import { type PersistedSavedEnvironmentRecord } from "@akeru/contracts";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as Ref from "effect/Ref";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import {
  type SavedEnvironmentRegistryDocument,
  toPersistedSavedEnvironmentRecord,
  preserveExistingSecrets,
  toSavedEnvironmentStorageRecord,
} from "./SavedEnvironmentDocument.ts";
import {
  type DesktopSavedEnvironmentsReadRegistryError,
  type DesktopSavedEnvironmentsMutationError,
  type DesktopSavedEnvironmentsGetSecretError,
  type DesktopSavedEnvironmentsSetSecretError,
  DesktopSavedEnvironmentsWriteError,
  DesktopSavedEnvironmentSecretProtectionError,
} from "./SavedEnvironmentErrors.ts";
import {
  writeRegistryDocument,
  readRegistryDocument,
  decodeSecretBytes,
} from "./SavedEnvironmentPersistence.ts";
export { DesktopSavedEnvironmentsWriteError } from "./SavedEnvironmentErrors.ts";
export { DesktopSavedEnvironmentsReadError } from "./SavedEnvironmentErrors.ts";
export { DesktopSavedEnvironmentsDocumentDecodeError } from "./SavedEnvironmentErrors.ts";
export { DesktopSavedEnvironmentSecretDecodeError } from "./SavedEnvironmentErrors.ts";
export { DesktopSavedEnvironmentSecretProtectionError } from "./SavedEnvironmentErrors.ts";
export type { DesktopSavedEnvironmentsReadRegistryError } from "./SavedEnvironmentErrors.ts";
export type { DesktopSavedEnvironmentsMutationError } from "./SavedEnvironmentErrors.ts";
export type { DesktopSavedEnvironmentsGetSecretError } from "./SavedEnvironmentErrors.ts";
export type { DesktopSavedEnvironmentsSetSecretError } from "./SavedEnvironmentErrors.ts";

export class DesktopSavedEnvironments extends Context.Service<
  DesktopSavedEnvironments,
  {
    readonly getRegistry: Effect.Effect<
      readonly PersistedSavedEnvironmentRecord[],
      DesktopSavedEnvironmentsReadRegistryError
    >;
    readonly setRegistry: (
      records: readonly PersistedSavedEnvironmentRecord[],
    ) => Effect.Effect<void, DesktopSavedEnvironmentsMutationError>;
    readonly removeEnvironment: (
      environmentId: string,
    ) => Effect.Effect<void, DesktopSavedEnvironmentsMutationError>;
    readonly getSecret: (
      environmentId: string,
    ) => Effect.Effect<Option.Option<string>, DesktopSavedEnvironmentsGetSecretError>;
    readonly setSecret: (input: {
      readonly environmentId: string;
      readonly secret: string;
    }) => Effect.Effect<boolean, DesktopSavedEnvironmentsSetSecretError>;
    readonly removeSecret: (
      environmentId: string,
    ) => Effect.Effect<void, DesktopSavedEnvironmentsMutationError>;
  }
>()("@akeru/desktop/settings/DesktopSavedEnvironments") {}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const crypto = yield* Crypto.Crypto;

  const writeDocument = (document: SavedEnvironmentRegistryDocument) =>
    crypto.randomUUIDv4.pipe(
      Effect.map((uuid) => uuid.replace(/-/g, "")),
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "create-temporary-file-name",
            path: environment.savedEnvironmentRegistryPath,
            cause,
          }),
      ),
      Effect.flatMap((suffix) =>
        writeRegistryDocument({
          fileSystem,
          path,
          registryPath: environment.savedEnvironmentRegistryPath,
          document,
          suffix,
        }),
      ),
    );

  return DesktopSavedEnvironments.of({
    getRegistry: readRegistryDocument(fileSystem, environment.savedEnvironmentRegistryPath).pipe(
      Effect.map((document) =>
        document.records.map((record) => toPersistedSavedEnvironmentRecord(record)),
      ),
      Effect.withSpan("desktop.savedEnvironments.getRegistry"),
    ),
    setRegistry: Effect.fn("desktop.savedEnvironments.setRegistry")(function* (records) {
      const currentDocument = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      yield* writeDocument(preserveExistingSecrets(currentDocument, records));
    }),
    removeEnvironment: Effect.fn("desktop.savedEnvironments.removeEnvironment")(
      function* (environmentId) {
        yield* Effect.annotateCurrentSpan({ environmentId });
        const document = yield* readRegistryDocument(
          fileSystem,
          environment.savedEnvironmentRegistryPath,
        );
        if (!document.records.some((record) => record.environmentId === environmentId)) {
          return;
        }

        yield* writeDocument({
          version: document.version,
          records: document.records.filter((record) => record.environmentId !== environmentId),
        });
      },
    ),
    getSecret: Effect.fn("desktop.savedEnvironments.getSecret")(function* (environmentId) {
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      const encoded = Option.fromNullishOr(
        document.records.find((record) => record.environmentId === environmentId)
          ?.encryptedBearerToken,
      );
      if (Option.isNone(encoded)) {
        return Option.none<string>();
      }
      const encryptionAvailable = yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSavedEnvironmentSecretProtectionError({
              operation: "check-encryption-availability",
              environmentId,
              registryPath: environment.savedEnvironmentRegistryPath,
              cause,
            }),
        ),
      );
      if (!encryptionAvailable) {
        return Option.none<string>();
      }

      const secretBytes = yield* decodeSecretBytes(
        environmentId,
        environment.savedEnvironmentRegistryPath,
        encoded.value,
      );
      return Option.some(
        yield* safeStorage.decryptString(secretBytes).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopSavedEnvironmentSecretProtectionError({
                operation: "decrypt-secret",
                environmentId,
                registryPath: environment.savedEnvironmentRegistryPath,
                cause,
              }),
          ),
        ),
      );
    }),
    setSecret: Effect.fn("desktop.savedEnvironments.setSecret")(function* (input) {
      const { environmentId, secret } = input;
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );

      const encryptionAvailable = yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSavedEnvironmentSecretProtectionError({
              operation: "check-encryption-availability",
              environmentId,
              registryPath: environment.savedEnvironmentRegistryPath,
              cause,
            }),
        ),
      );
      if (!encryptionAvailable) {
        return false;
      }

      const encryptedBearerToken = Encoding.encodeBase64(
        yield* safeStorage.encryptString(secret).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopSavedEnvironmentSecretProtectionError({
                operation: "encrypt-secret",
                environmentId,
                registryPath: environment.savedEnvironmentRegistryPath,
                cause,
              }),
          ),
        ),
      );
      let found = false;
      const nextDocument: SavedEnvironmentRegistryDocument = {
        version: document.version,
        records: document.records.map((record) => {
          if (record.environmentId !== environmentId) {
            return record;
          }

          found = true;
          return toSavedEnvironmentStorageRecord(record, Option.some(encryptedBearerToken));
        }),
      };

      if (found) {
        yield* writeDocument(nextDocument);
      }
      return found;
    }),
    removeSecret: Effect.fn("desktop.savedEnvironments.removeSecret")(function* (environmentId) {
      yield* Effect.annotateCurrentSpan({ environmentId });
      const document = yield* readRegistryDocument(
        fileSystem,
        environment.savedEnvironmentRegistryPath,
      );
      if (
        !document.records.some(
          (record) =>
            record.environmentId === environmentId && record.encryptedBearerToken !== undefined,
        )
      ) {
        return;
      }

      yield* writeDocument({
        version: document.version,
        records: document.records.map((record) => {
          if (record.environmentId !== environmentId) {
            return record;
          }
          return toPersistedSavedEnvironmentRecord(record);
        }),
      });
    }),
  });
});

export const layer = Layer.effect(DesktopSavedEnvironments, make);

export const layerTest = (input?: {
  readonly records?: readonly PersistedSavedEnvironmentRecord[];
  readonly secrets?: ReadonlyMap<string, string>;
}) =>
  Layer.effect(
    DesktopSavedEnvironments,
    Effect.gen(function* () {
      const recordsRef = yield* Ref.make(input?.records ?? []);
      const secretsRef = yield* Ref.make(new Map(input?.secrets ?? []));

      return DesktopSavedEnvironments.of({
        getRegistry: Ref.get(recordsRef),
        setRegistry: (records) => Ref.set(recordsRef, records),
        removeEnvironment: (environmentId) =>
          Ref.update(recordsRef, (records) =>
            records.filter((record) => record.environmentId !== environmentId),
          ).pipe(
            Effect.andThen(
              Ref.update(secretsRef, (secrets) => {
                const nextSecrets = new Map(secrets);
                nextSecrets.delete(environmentId);
                return nextSecrets;
              }),
            ),
          ),
        getSecret: (environmentId) =>
          Ref.get(secretsRef).pipe(
            Effect.map((secrets) => Option.fromNullishOr(secrets.get(environmentId))),
          ),
        setSecret: ({ environmentId, secret }) =>
          Ref.get(recordsRef).pipe(
            Effect.flatMap((records) => {
              if (!records.some((record) => record.environmentId === environmentId)) {
                return Effect.succeed(false);
              }
              return Ref.update(secretsRef, (secrets) => {
                const nextSecrets = new Map(secrets);
                nextSecrets.set(environmentId, secret);
                return nextSecrets;
              }).pipe(Effect.as(true));
            }),
          ),
        removeSecret: (environmentId) =>
          Ref.update(secretsRef, (secrets) => {
            const nextSecrets = new Map(secrets);
            nextSecrets.delete(environmentId);
            return nextSecrets;
          }),
      });
    }),
  );
