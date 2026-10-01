import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";

import * as Path from "effect/Path";

import {
  type SavedEnvironmentRegistryDocument,
  decodeSavedEnvironmentRegistryDocumentJson,
  normalizeSavedEnvironmentRegistryDocument,
  encodeSavedEnvironmentRegistryDocumentJson,
} from "./SavedEnvironmentDocument.ts";
import {
  type DesktopSavedEnvironmentsReadRegistryError,
  DesktopSavedEnvironmentsReadError,
  DesktopSavedEnvironmentsDocumentDecodeError,
  DesktopSavedEnvironmentsWriteError,
  DesktopSavedEnvironmentSecretDecodeError,
} from "./SavedEnvironmentErrors.ts";

export function readRegistryDocument(
  fileSystem: FileSystem.FileSystem,
  registryPath: string,
): Effect.Effect<SavedEnvironmentRegistryDocument, DesktopSavedEnvironmentsReadRegistryError> {
  return fileSystem.readFileString(registryPath).pipe(
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed<string | null>(null)
        : Effect.fail(
            new DesktopSavedEnvironmentsReadError({
              registryPath,
              cause: error,
            }),
          ),
    ),
    Effect.flatMap((raw) =>
      raw === null
        ? Effect.succeed({ version: 1, records: [] })
        : decodeSavedEnvironmentRegistryDocumentJson(raw).pipe(
            Effect.map(normalizeSavedEnvironmentRegistryDocument),
            Effect.mapError(
              (cause) =>
                new DesktopSavedEnvironmentsDocumentDecodeError({
                  registryPath,
                  cause,
                }),
            ),
          ),
    ),
  );
}

export const writeRegistryDocument = Effect.fn("desktop.savedEnvironments.writeRegistryDocument")(
  function* (input: {
    readonly fileSystem: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly registryPath: string;
    readonly document: SavedEnvironmentRegistryDocument;
    readonly suffix: string;
  }): Effect.fn.Return<void, DesktopSavedEnvironmentsWriteError> {
    const directory = input.path.dirname(input.registryPath);
    const tempPath = `${input.registryPath}.${process.pid}.${input.suffix}.tmp`;
    const encoded = yield* encodeSavedEnvironmentRegistryDocumentJson(input.document).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "encode-registry",
            path: input.registryPath,
            cause,
          }),
      ),
    );
    yield* input.fileSystem.makeDirectory(directory, { recursive: true }).pipe(
      Effect.mapError(
        (cause) =>
          new DesktopSavedEnvironmentsWriteError({
            operation: "create-directory",
            path: directory,
            cause,
          }),
      ),
    );
    yield* Effect.gen(function* () {
      yield* input.fileSystem.writeFileString(tempPath, `${encoded}\n`).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSavedEnvironmentsWriteError({
              operation: "write-temporary-file",
              path: tempPath,
              cause,
            }),
        ),
      );
      yield* input.fileSystem.rename(tempPath, input.registryPath).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopSavedEnvironmentsWriteError({
              operation: "replace-registry-file",
              path: input.registryPath,
              cause,
            }),
        ),
      );
    }).pipe(
      Effect.ensuring(
        input.fileSystem.remove(tempPath, { force: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not remove a temporary saved-environment registry file.", {
              tempPath,
              error,
            }),
          ),
        ),
      ),
    );
  },
);

export function decodeSecretBytes(
  environmentId: string,
  registryPath: string,
  encoded: string,
): Effect.Effect<Uint8Array, DesktopSavedEnvironmentSecretDecodeError> {
  return Effect.fromResult(Encoding.decodeBase64(encoded)).pipe(
    Effect.mapError(
      (cause) =>
        new DesktopSavedEnvironmentSecretDecodeError({
          environmentId,
          registryPath,
          field: "encryptedBearerToken",
          cause,
        }),
    ),
  );
}
