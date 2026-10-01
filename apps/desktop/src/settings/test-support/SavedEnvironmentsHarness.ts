import * as NodeServices from "@effect/platform-node/NodeServices";

import { EnvironmentId, type PersistedSavedEnvironmentRecord } from "@akeru/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Schema from "effect/Schema";
import * as DesktopConfig from "../../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronSafeStorage from "../../electron/ElectronSafeStorage.ts";
import * as DesktopSavedEnvironments from "../DesktopSavedEnvironments.ts";

export const textDecoder = new TextDecoder();

export const textEncoder = new TextEncoder();

export const savedRegistryRecord: PersistedSavedEnvironmentRecord = {
  environmentId: EnvironmentId.make("environment-1"),
  label: "Remote environment",
  httpBaseUrl: "https://remote.example.com/",
  wsBaseUrl: "wss://remote.example.com/",
  createdAt: "2026-04-09T00:00:00.000Z",
  lastConnectedAt: "2026-04-09T01:00:00.000Z",
  desktopSsh: {
    alias: "devbox",
    hostname: "devbox.example.com",
    username: "julius",
    port: 22,
  },
};

export const SavedEnvironmentRegistryDocumentProbe = Schema.Struct({
  version: Schema.Number,
  records: Schema.Array(Schema.Unknown),
});

export const SavedEnvironmentRegistryDocumentProbeJson = Schema.fromJsonString(
  SavedEnvironmentRegistryDocumentProbe,
);

export const decodeSavedEnvironmentRegistryDocumentProbe = Schema.decodeEffect(
  SavedEnvironmentRegistryDocumentProbeJson,
);

export const encodeSavedEnvironmentRegistryDocumentProbe = Schema.encodeEffect(
  SavedEnvironmentRegistryDocumentProbeJson,
);

export function makeSafeStorageLayer(input: {
  readonly available: boolean;
  readonly availabilityError?: unknown;
  readonly encryptError?: unknown;
  readonly decryptError?: unknown;
}) {
  return Layer.succeed(ElectronSafeStorage.ElectronSafeStorage, {
    isEncryptionAvailable:
      input.availabilityError === undefined
        ? Effect.succeed(input.available)
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageAvailabilityError({
              cause: input.availabilityError,
            }),
          ),
    encryptString: (value) =>
      input.encryptError === undefined
        ? Effect.succeed(textEncoder.encode(`enc:${value}`))
        : Effect.fail(
            new ElectronSafeStorage.ElectronSafeStorageEncryptError({
              cause: input.encryptError,
            }),
          ),
    decryptString: (value) => {
      if (input.decryptError !== undefined) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: input.decryptError,
          }),
        );
      }

      const decoded = textDecoder.decode(value);
      if (!decoded.startsWith("enc:")) {
        return Effect.fail(
          new ElectronSafeStorage.ElectronSafeStorageDecryptError({
            cause: new Error("invalid secret"),
          }),
        );
      }
      return Effect.succeed(decoded.slice("enc:".length));
    },
    selectedStorageBackend: Effect.succeed(Option.none()),
  } satisfies ElectronSafeStorage.ElectronSafeStorage["Service"]);
}

export function makeLayer(
  baseDir: string,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
  },
  fileSystemLayer: Layer.Layer<FileSystem.FileSystem> = NodeServices.layer,
) {
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
      Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({ T3CODE_HOME: baseDir })),
    ),
  );

  const safeStorageLayer = makeSafeStorageLayer({
    available: options?.availableSecretStorage ?? true,
    availabilityError: options?.availabilityError,
    encryptError: options?.encryptError,
    decryptError: options?.decryptError,
  });
  const dependencies = Layer.mergeAll(
    environmentLayer,
    safeStorageLayer,
    NodeServices.layer,
    fileSystemLayer,
  );

  return DesktopSavedEnvironments.layer.pipe(Layer.provideMerge(dependencies));
}

export const withSavedEnvironments = <A, E, R>(
  effect: Effect.Effect<A, E, R | DesktopSavedEnvironments.DesktopSavedEnvironments>,
  options?: {
    readonly availableSecretStorage?: boolean;
    readonly availabilityError?: unknown;
    readonly encryptError?: unknown;
    readonly decryptError?: unknown;
  },
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const baseDir = yield* fileSystem.makeTempDirectoryScoped({
      prefix: "t3-desktop-saved-environments-test-",
    });
    return yield* effect.pipe(Effect.provide(makeLayer(baseDir, options)));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);
